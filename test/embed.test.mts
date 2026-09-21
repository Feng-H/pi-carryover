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
import { detectLang, cosine, EmbedEngine, EMBED_MODELS } from "../extensions/lib/embed.ts";
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
