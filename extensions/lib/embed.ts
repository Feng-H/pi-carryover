/**
 * 话题切换的 Embedding 主检测器（v1.1.2 引入，v1.2.0 自适应阈值）。
 *
 * 实测基准（15 组中文 + 5 组英文样本，avg 余弦）：
 *   bge-small-zh-v1.5 (q8, 23MB)：中文同 0.415~0.487 vs 异 0.239~0.359 → 完全可分
 *   all-MiniLM-L6-v2 (q8, 23MB)：英文同 0.134~0.346 vs 异 0.009~0.095 → 完全可分
 *   多语言单模型 (e5-small) 两头弱 → 弃用，改为按语言路由双小模型。
 *
 * v1.2.0 自适应阈值（会话历史基线，TextTiling mean−σ 思路的安全变体）：
 *   实测标定否定了窗口两两 μ−σ 方案（同话题误报 +25%，相邻捕获仅 +33%，净收益为负：
 *   zh 同话题 sim [0.415..0.491] 与相邻话题 [0.391..0.538] 分布重叠，消息级本质不可分）；
 *   改为跟踪本会话「已判同话题」的 sim 历史：threshold = clamp(min(H)−margin, floor, cap)。
 *   修复语域漂移：简短语域（短句/口语化）sim 系统性偏低，固定 0.4 对同话题「好的 我试试」
 *   实测误报；历史基线自动降至 0.371 正确判定。冷启动（|H|<3）或显式覆盖时退回固定值
 *   —— v1.1.x 行为完全兼容。auto 模式 LLM 拒绝确认时回填 markSame()，阈值自回下。
 *
 * @huggingface/transformers 为 optionalDependency：装不上/加载失败时调用方回落词法。
 */

export interface EmbedModelSpec {
  id: string; // HF repo
  label: string; // 中文名（zh 文案）
  labelEn: string; // 英文名（en 文案）
  sizeMB: number;
  threshold: number; // avg 余弦低于此值 → 疑似话题切换（固定基准，v1.1.x 行为）
  adaptiveFloor: number; // 自适应阈值下限（语域极端简短时的护栏）
  adaptiveCap: number; // 自适应阈值上限（防止向上游棘）
  files: string[]; // 预下载清单（transformers.js 缓存布局）
}

/** 自适应安全边际：threshold = min(历史同话题 sim) − margin（序列实测 0.05） */
export const ADAPTIVE_MARGIN = 0.05;
/** 历史样本数达到该值才启用自适应（否则证据不足，用固定阈值） */
export const ADAPTIVE_MIN_HIST = 3;
/** 历史窗口长度（近端同话题 sim 滚动窗口，语域漂移时可自然下滑） */
export const ADAPTIVE_HIST_SIZE = 8;

export const EMBED_MODELS: Record<"zh" | "en", EmbedModelSpec> = {
  zh: {
    id: "Xenova/bge-small-zh-v1.5",
    label: "中文优化 bge-small-zh",
    labelEn: "bge-small-zh (Chinese)",
    sizeMB: 23,
    threshold: 0.4,
    adaptiveFloor: 0.15, // 简短语域护栏：实测短句会话 floor 可至 0.37
    adaptiveCap: 0.55, // 丰富语域封顶：同话题实测 0.45~0.59，留 0.05 余量
    files: ["config.json", "tokenizer.json", "tokenizer_config.json", "onnx/model_quantized.onnx"],
  },
  en: {
    id: "Xenova/all-MiniLM-L6-v2",
    label: "英文优化 MiniLM",
    labelEn: "MiniLM (English)",
    sizeMB: 23,
    threshold: 0.115,
    adaptiveFloor: 0.03, // 英文短句护栏
    adaptiveCap: 0.25, // 英文同话题实测 0.12~0.35，封顶防误报
    files: [
      "config.json",
      "tokenizer.json",
      "tokenizer_config.json",
      "special_tokens_map.json",
      "onnx/model_quantized.onnx",
    ],
  },
};

/** 语言路由：CJK 字符占字母+CJK 总数比例 >10% → zh。纯函数，可单测。 */
export function detectLang(text: string): "zh" | "en" {
  const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const latin = (text.match(/[a-zA-Z]/g) ?? []).length;
  return cjk / Math.max(1, cjk + latin) > 0.1 ? "zh" : "en";
}

/** 余弦（输入向量已归一化时即点积） */
export function cosine(a: number[] | Float32Array, b: number[] | Float32Array): number {
  let dot = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot;
}

export interface EmbedChoice {
  /** "auto" = 双模型路由 | "zh" | "en" | "off" | undefined（未选择过） */
  choice?: "auto" | "zh" | "en" | "off";
  thresholdZh?: number;
  thresholdEn?: number;
}

interface LangBucket {
  loading: Promise<boolean> | null;
  extractor: ((t: string) => Promise<Float32Array>) | null;
  vecs: number[][]; // 近期消息向量（归一化）
  texts: string[]; // 对应原文（窗口重建/调试）
  simHist: number[]; // 已判同话题的 sim 历史（自适应阈值基线，v1.2.0）
}

const WINDOW = 6; // 与词法窗口一致

/**
 * 自适应阈值（纯函数，可单测）：threshold = clamp(min(hist) − margin, floor, cap)。
 * hist = 本会话已判同话题的 sim 历史；|hist| < 3 时退回 fixed（冷启动）。
 * 双向移动：简短语域自动下探（至 floor）修复固定阈值误报；丰富语域上探（至 cap）。
 * 设计依据：修复语域漂移，而非相邻话题分离（实测不可分，由 LLM 二次确认层兑底）。
 */
export function adaptiveThreshold(
  hist: number[],
  fixed: number,
  floor: number,
  cap: number,
): { threshold: number; adaptive: boolean } {
  if (hist.length < ADAPTIVE_MIN_HIST) return { threshold: fixed, adaptive: false };
  const cand = Math.min(...hist) - ADAPTIVE_MARGIN;
  const threshold = Math.min(Math.max(cand, floor), cap);
  return { threshold, adaptive: Math.abs(threshold - fixed) > 1e-9 };
}

/**
 * 进程内单例引擎。所有方法失败安全：任何异常 → 视为不可用，调用方回落词法。
 */
export class EmbedEngine {
  private tf: any = null; // @huggingface/transformers 模块
  private buckets: Record<"zh" | "en", LangBucket> = {
    zh: { loading: null, extractor: null, vecs: [], texts: [], simHist: [] },
    en: { loading: null, extractor: null, vecs: [], texts: [], simHist: [] },
  };
  /** 供测试注入缓存目录；生产用 ~/.pi/agent/.cache/transformers（跨 pi update 持久） */
  cacheDir: string | null = null;

  get available(): boolean {
    return this.buckets.zh.extractor !== null || this.buckets.en.extractor !== null;
  }

  /** 需要的语言桶列表（按用户选择） */
  private wanted(choice: NonNullable<EmbedChoice["choice"]>): Array<"zh" | "en"> {
    if (choice === "zh") return ["zh"];
    if (choice === "en") return ["en"];
    return ["zh", "en"]; // auto
  }

  /**
   * 初始化（幂等）。ensure: 已就位时跳过下载。
   * @param ensureModel 下载回调（由 index.ts 注入，串联 downloader + 进度 UI）
   * @returns 首次调用是否成功加载了至少一个模型
   */
  async init(
    choice: NonNullable<EmbedChoice["choice"]>,
    ensureModel: (lang: "zh" | "en") => Promise<boolean>,
  ): Promise<boolean> {
    if (choice === "off") return false;
    try {
      if (!this.tf) {
        this.tf = await import("@huggingface/transformers");
        this.tf.env.localModelOnly = true; // 预下载器负责网络，运行时零网络
        if (this.cacheDir) this.tf.env.cacheDir = this.cacheDir;
      }
    } catch {
      return false; // optionalDependency 未装上
    }
    let any = false;
    for (const lang of this.wanted(choice)) {
      const b = this.buckets[lang];
      if (b.extractor || b.loading) {
        any = true;
        continue;
      }
      b.loading = (async () => {
        try {
          const ok = await ensureModel(lang);
          if (!ok) return false;
          const pipe = await this.tf.pipeline("feature-extraction", EMBED_MODELS[lang].id, { dtype: "q8" });
          b.extractor = async (t: string) => {
            const out = await pipe(t, { pooling: "mean", normalize: true });
            return out.data as Float32Array;
          };
          // 窗口重建：把已积累的原文补算向量，立即可检测
          for (const text of b.texts.slice(-WINDOW)) {
            try {
              b.vecs.push(Array.from(await b.extractor(text)));
            } catch {
              /* 单条失败跳过 */
            }
          }
          return true;
        } catch {
          return false;
        } finally {
          b.loading = null;
        }
      })();
      any = (await b.loading) || any;
    }
    return any;
  }

  /** 记录一条消息进语言桶（引擎就绪后增量积累窗口）。失败静默。 */
  async observe(text: string): Promise<void> {
    const lang = detectLang(text);
    const b = this.buckets[lang];
    b.texts.push(text);
    if (b.texts.length > WINDOW) b.texts.shift();
    if (!b.extractor) return;
    try {
      const v = Array.from(await b.extractor(text));
      b.vecs.push(v);
      if (b.vecs.length > WINDOW) b.vecs.shift();
    } catch {
      /* skip */
    }
  }

  /**
   * 话题切换检测（v1.2.0 自适应阈值）：新消息 vs 同语言窗口向量 avg 余弦。
   *
   * 阈值策略（语域自适应，失败安全）：
   *   1. 用户显式覆盖（thresholdZh/thresholdEn）→ 固定阈值，自适应关闭；
   *   2. 同话题 sim 历史 < ADAPTIVE_MIN_HIST → 固定阈值（冷启动）；
   *   3. 否则 threshold = clamp(min(hist) − margin, floor, cap)，双向适配语域。
   *   判为同话题的 sim 自动入历史；auto 模式 LLM 拒绝切换时经 markSame() 回填自愈。
   *
   * @returns null = embedding 不可用（调用方回落词法）；否则 { shift, similarity, lang, threshold, adaptive }
   */
  async detect(text: string, thresholdOverride?: Partial<Record<"zh" | "en", number>>): Promise<{
    shift: boolean;
    similarity: number;
    lang: "zh" | "en";
    threshold: number; // 本次实际生效的阈值
    adaptive: boolean; // true = 自适应生效（阈值偏离固定值）
  } | null> {
    const lang = detectLang(text);
    const b = this.buckets[lang];
    if (!b.extractor || b.vecs.length < 2) return null;
    try {
      const v = await b.extractor(text);
      let sum = 0;
      for (const w of b.vecs) sum += cosine(v, w);
      const similarity = sum / b.vecs.length;
      const spec = EMBED_MODELS[lang];
      const override = thresholdOverride?.[lang];
      const { threshold, adaptive } =
        override !== undefined
          ? { threshold: override, adaptive: false } // 显式覆盖 = 用户接管，退回固定模式
          : adaptiveThreshold(b.simHist, spec.threshold, spec.adaptiveFloor, spec.adaptiveCap);
      const shift = similarity < threshold;
      if (!shift && override === undefined) {
        // 同话题 sim 入历史（滚动窗口）：语域基线持续自校正；覆盖模式不污染基线
        b.simHist.push(similarity);
        if (b.simHist.length > ADAPTIVE_HIST_SIZE) b.simHist.shift();
      }
      return { shift, similarity, lang, threshold, adaptive };
    } catch {
      return null;
    }
  }

  /**
   * 外部纠偏回填（auto 模式 LLM 拒绝切换确认时调用）：
   * 该消息实为同话题，但其 sim 未入历史（判了 shift）——回填使阈值下移自愈。
   */
  markSame(lang: "zh" | "en", similarity: number): void {
    const b = this.buckets[lang];
    if (typeof similarity !== "number" || Number.isNaN(similarity)) return;
    b.simHist.push(similarity);
    if (b.simHist.length > ADAPTIVE_HIST_SIZE) b.simHist.shift();
  }

  /** 压缩后重置窗口（session_compact 联动）；语域历史一并重置（新话题新基线） */
  resetWindow(): void {
    for (const b of Object.values(this.buckets)) {
      b.vecs = [];
      b.texts = [];
      b.simHist = [];
    }
  }
}
