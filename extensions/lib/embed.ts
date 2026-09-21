/**
 * 话题切换的 Embedding 主检测器（v1.1.2）。
 *
 * 实测基准（15 组中文 + 5 组英文样本，avg 余弦）：
 *   bge-small-zh-v1.5 (q8, 23MB)：中文同 0.415~0.487 vs 异 0.239~0.359 → 完全可分
 *   all-MiniLM-L6-v2 (q8, 23MB)：英文同 0.134~0.346 vs 异 0.009~0.095 → 完全可分
 *   多语言单模型 (e5-small) 两头弱 → 弃用，改为按语言路由双小模型。
 *
 * @huggingface/transformers 为 optionalDependency：装不上/加载失败时调用方回落词法。
 */

export interface EmbedModelSpec {
  id: string; // HF repo
  label: string; // 中文名（zh 文案）
  labelEn: string; // 英文名（en 文案）
  sizeMB: number;
  threshold: number; // avg 余弦低于此值 → 疑似话题切换
  files: string[]; // 预下载清单（transformers.js 缓存布局）
}

export const EMBED_MODELS: Record<"zh" | "en", EmbedModelSpec> = {
  zh: {
    id: "Xenova/bge-small-zh-v1.5",
    label: "中文优化 bge-small-zh",
    labelEn: "bge-small-zh (Chinese)",
    sizeMB: 23,
    threshold: 0.4,
    files: ["config.json", "tokenizer.json", "tokenizer_config.json", "onnx/model_quantized.onnx"],
  },
  en: {
    id: "Xenova/all-MiniLM-L6-v2",
    label: "英文优化 MiniLM",
    labelEn: "MiniLM (English)",
    sizeMB: 23,
    threshold: 0.115,
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
}

const WINDOW = 6; // 与词法窗口一致

/**
 * 进程内单例引擎。所有方法失败安全：任何异常 → 视为不可用，调用方回落词法。
 */
export class EmbedEngine {
  private tf: any = null; // @huggingface/transformers 模块
  private buckets: Record<"zh" | "en", LangBucket> = {
    zh: { loading: null, extractor: null, vecs: [], texts: [] },
    en: { loading: null, extractor: null, vecs: [], texts: [] },
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
   * 话题切换检测：新消息 vs 同语言窗口向量 avg 余弦。
   * @returns null = embedding 不可用（调用方回落词法）；否则 { shift, similarity, lang }
   */
  async detect(text: string, thresholdOverride?: Partial<Record<"zh" | "en", number>>): Promise<{
    shift: boolean;
    similarity: number;
    lang: "zh" | "en";
  } | null> {
    const lang = detectLang(text);
    const b = this.buckets[lang];
    if (!b.extractor || b.vecs.length < 2) return null;
    try {
      const v = await b.extractor(text);
      let sum = 0;
      for (const w of b.vecs) sum += cosine(v, w);
      const similarity = sum / b.vecs.length;
      const threshold = thresholdOverride?.[lang] ?? EMBED_MODELS[lang].threshold;
      return { shift: similarity < threshold, similarity, lang };
    } catch {
      return null;
    }
  }

  /** 压缩后重置窗口（session_compact 联动） */
  resetWindow(): void {
    for (const b of Object.values(this.buckets)) {
      b.vecs = [];
      b.texts = [];
    }
  }
}
