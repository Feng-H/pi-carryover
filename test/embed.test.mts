/**
 * v1.1.2 Embedding 检测单元测试（不下载模型，零网络）：
 *   node --test test/
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import {
  detectLang,
  cosine,
  EmbedEngine,
  EMBED_MODELS,
  adaptiveThreshold,
  ADAPTIVE_MARGIN,
  ADAPTIVE_MIN_HIST,
  ADAPTIVE_HIST_SIZE,
} from "../extensions/lib/embed.ts";
import { downloadFileResumable, ensureModelFiles, resolveEndpoint } from "../extensions/lib/downloader.ts";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-carryover-embed-"));
}

test("detectLang：语言路由阈值", () => {
  assert.equal(detectLang("登录页面有个bug点击没反应"), "zh");
  assert.equal(detectLang("帮我配置跨域，参考 CORS policy 文档"), "zh"); // 混合但中文为主
  assert.equal(detectLang("how to fix the CORS error"), "en");
  assert.equal(detectLang("react-window 虚拟列表优化"), "zh"); // 少量拉丁+中文为主
  assert.equal(detectLang("deploy nginx and check pm2 logs"), "en");
});

test("cosine：归一化向量点积", () => {
  assert.ok(Math.abs(cosine([1, 0], [0, 1])) < 1e-9);
  assert.ok(Math.abs(cosine([0.6, 0.8], [0.6, 0.8]) - 1) < 1e-9);
});

test("EmbedEngine：模型未就绪时 detect 返回 null（调用方回落词法）", async () => {
  const e = new EmbedEngine();
  assert.equal(e.available, false);
  assert.equal(await e.detect("随便什么消息"), null);
});

test("EMBED_MODELS：注册表双模型 + 各自阈值", () => {
  assert.equal(EMBED_MODELS.zh.id, "Xenova/bge-small-zh-v1.5");
  assert.equal(EMBED_MODELS.en.id, "Xenova/all-MiniLM-L6-v2");
  assert.ok(EMBED_MODELS.zh.threshold > 0.3 && EMBED_MODELS.zh.threshold < 0.45);
  assert.ok(EMBED_MODELS.en.threshold > 0.05 && EMBED_MODELS.en.threshold < 0.2);
  // 文件清单必须含 onnx 权重与分词器
  for (const m of Object.values(EMBED_MODELS)) {
    assert.ok(m.files.includes("onnx/model_quantized.onnx"));
    assert.ok(m.files.includes("tokenizer.json"));
  }
});

test("downloadFileResumable：Range 断点续传（模拟中途断连）", async () => {
  const payload = Buffer.alloc(300_000, 7); // 300KB 测试负载
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits++;
    const range = req.headers["range"];
    if (!range) {
      // 首次：只发一半就断（模拟断连）
      res.writeHead(200, { "content-length": String(payload.length) });
      res.end(payload.subarray(0, 150_000)); // 少于声明长度 → undici 报错 → 重试
      return;
    }
    const start = Number(range.replace(/bytes=(\d+)-/, "$1"));
    res.writeHead(206, {
      "content-range": `bytes ${start}-${payload.length - 1}/${payload.length}`,
      "content-length": String(payload.length - start),
    });
    res.end(payload.subarray(start));
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = server.address().port;
  const dest = path.join(tmpDir(), "model.bin");
  try {
    const r = await downloadFileResumable(`http://127.0.0.1:${port}/f.bin`, dest, () => {}, 4);
    assert.equal(r, "ok");
    assert.ok(hits >= 2, "应发生断点续传重试");
    const got = fs.readFileSync(dest);
    assert.equal(got.length, payload.length, "续传后文件完整");
    assert.ok(got.equals(payload), "内容逐字节一致");
  } finally {
    server.close();
  }
});

test("ensureModelFiles：全部就位时离线快速路径（零请求）", async () => {
  const cache = tmpDir();
  const files = ["config.json", "onnx/model_quantized.onnx"];
  for (const f of files) {
    const p = path.join(cache, "Xenova", "test-model", f);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "x");
  }
  // 若发起请求会因 endpoint 不可达而失败/超时，这里必须瞬间 true
  const ok = await ensureModelFiles("Xenova/test-model", files, "http://127.0.0.1:1", cache, () => {});
  assert.equal(ok, true);
});

test("resolveEndpoint：显式配置最高优先级（不探测网络）", async () => {
  const e = await resolveEndpoint({ configured: "https://example.invalid" });
  assert.equal(e, "https://example.invalid");
});

// ===== v1.2.0 自适应阈值 =====

test("EMBED_MODELS：自适应护栏字段存在且合理（floor < fixed < cap）", () => {
  for (const m of Object.values(EMBED_MODELS)) {
    assert.ok(m.adaptiveFloor < m.threshold, `${m.id}: floor 应低于固定阈值`);
    assert.ok(m.adaptiveCap > m.threshold, `${m.id}: cap 应高于固定阈值`);
  }
});

test("adaptiveThreshold：冷启动回退固定值", () => {
  assert.deepEqual(adaptiveThreshold([0.5, 0.5], 0.4, 0.15, 0.55), { threshold: 0.4, adaptive: false });
  assert.deepEqual(adaptiveThreshold([], 0.4, 0.15, 0.55), { threshold: 0.4, adaptive: false });
});

test("adaptiveThreshold：简短语域下探（修复固定阈值误报，序实测场景）", () => {
  // 序列实测：terse 会话 H=[0.447,0.421,0.438]，固定 0.4 对同话题 sim 0.389 误报
  const r = adaptiveThreshold([0.447, 0.421, 0.438], 0.4, 0.15, 0.55);
  assert.ok(Math.abs(r.threshold - (0.421 - ADAPTIVE_MARGIN)) < 1e-9, `应降至 min−margin，实际 ${r.threshold}`);
  assert.equal(r.adaptive, true);
  assert.ok(0.389 > r.threshold, "同话题 0.389 应被正确判为同题（固定 0.4 会误报）");
});

test("adaptiveThreshold：丰富语域上探", () => {
  const r = adaptiveThreshold([0.569, 0.507, 0.455], 0.4, 0.15, 0.55);
  assert.ok(Math.abs(r.threshold - (0.455 - ADAPTIVE_MARGIN)) < 1e-9);
  assert.equal(r.adaptive, true);
});

test("adaptiveThreshold：floor/cap 双向护栏", () => {
  // 极高基线 → 封顶；极低基线 → 托底
  assert.equal(adaptiveThreshold([0.9, 0.9, 0.9], 0.4, 0.15, 0.55).threshold, 0.55);
  assert.equal(adaptiveThreshold([0.1, 0.12, 0.11], 0.4, 0.15, 0.55).threshold, 0.15);
});

test("EmbedEngine.detect：历史驱动的自适应 + sim 入历史 + 覆盖模式不污染", async () => {
  const e = new EmbedEngine();
  // 注入确定性 extractor：中文文本 → 预设归一化向量（cosine=点积，向量必须归一化）
  const norm = (v: number[]) => {
    const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    return Float32Array.from(v.map((x) => x / n));
  };
  // 同话题簇：主轴 (1,0,0) 附近；新同话题也在簇内；异话题正交 (0,1,0)
  const table: Record<string, Float32Array> = {
    同题1: norm([1, 0.05, 0]),
    同题2: norm([1, 0.08, 0]),
    同题3: norm([1, 0.11, 0]),
    同题4: norm([1, 0.14, 0]),
    异题: norm([0, 1, 0]),
  };
  const zh = (e as any).buckets.zh;
  zh.extractor = async (t: string) => table[t];
  zh.vecs = [Array.from(table.同题1), Array.from(table.同题2), Array.from(table.同题3)];

  // 冷启动（无历史）：固定阈值，同话题不切换且 sim 入历史
  const r1 = await e.detect("同题4");
  assert.ok(r1 && !r1.shift && r1.adaptive === false);
  assert.equal(zh.simHist.length, 1, "同话题 sim 应入历史");

  // 历史不足 3 条仍是固定阈值（detect 前检查：第 2/3 次仍冷启动）
  const r2 = await e.detect("同题4");
  assert.equal(r2.adaptive, false);
  const r3 = await e.detect("同题4");
  assert.equal(r3.adaptive, false, "第 3 次 detect 时历史仅 2 条，仍应固定阈值");

  // 第 4 次：历史已满 3 条 → 自适应生效（簇内 sim ≈ 0.999 → 阈值上探至 cap 0.55）
  const r4same = await e.detect("同题4");
  assert.equal(r4same.adaptive, true, "历史 ≥3 应激活自适应");
  assert.ok(Math.abs(r4same.threshold - 0.55) < 1e-9, `应封顶 cap，实际 ${r4same.threshold}`);
  assert.ok(!r4same.shift, "同话题不应切换");

  // 异话题（正交， sim≈0）→ 切换，且不入历史
  const before = zh.simHist.length;
  const r4 = await e.detect("异题");
  assert.ok(r4 && r4.shift, "正交向量应判切换");
  assert.equal(zh.simHist.length, before, "切换判定不应入历史");

  // 显式覆盖 → 固定阈值 + 不入历史
  const hBefore = zh.simHist.length;
  const r5 = await e.detect("同题4", { zh: 0.5 });
  assert.ok(r5 && !r5.shift && r5.adaptive === false);
  assert.equal(r5.threshold, 0.5);
  assert.equal(zh.simHist.length, hBefore, "覆盖模式不应污染基线");
});

test("EmbedEngine.markSame：LLM 拒绝回填使阈值下移自愈", async () => {
  const e = new EmbedEngine();
  const zh = (e as any).buckets.zh;
  zh.simHist = [0.6, 0.62, 0.61]; // 误判前的历史：阈值 0.55（封顶）
  e.markSame("zh", 0.42); // LLM 拒绝：实为同话题，但 sim 只有 0.42
  const hist = zh.simHist as number[];
  assert.equal(hist[hist.length - 1], 0.42, "应回填到历史尾部");
  const r = adaptiveThreshold(hist, 0.4, 0.15, 0.55);
  assert.ok(r.threshold < 0.55, `阈值应下移自愈，实际 ${r.threshold}`);
  assert.ok(Math.abs(r.threshold - (0.42 - ADAPTIVE_MARGIN)) < 1e-9);
  // 无效输入拒绝
  e.markSame("zh", NaN);
  assert.equal(zh.simHist.length, hist.length);
});

test("ADAPTIVE_*：常量与文档一致", () => {
  assert.equal(ADAPTIVE_MARGIN, 0.05);
  assert.equal(ADAPTIVE_MIN_HIST, 3);
  assert.ok(ADAPTIVE_HIST_SIZE >= 6, "历史窗口应足够覆盖语域演化");
});
