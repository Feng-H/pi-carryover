/**
 * 话题压缩（Topic Compaction）核心逻辑测试：
 *   node --test test/
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  tokenize,
  coverageOf,
  detectTopicShift,
  readTopicConfig,
  writeTopicArchive,
  listTopicArchives,
  writeEmbedConfig,
} from "../extensions/index.ts";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-carryover-test-"));
}

test("tokenize：拉丁词去停用词 + CJK 二元组", () => {
  const t = tokenize("Fix the login bug in auth.ts 登录失败问题");
  assert.ok(t.includes("login") && t.includes("bug") && t.includes("auth"));
  assert.ok(!t.includes("the")); // 停用词被过滤
  assert.ok(t.some((x) => /^[\u4e00-\u9fff]{2}$/.test(x)), "应产生中文二元组");
});

test("coverageOf：数学正确性", () => {
  assert.equal(coverageOf(new Set(["a", "b"]), new Set(["a", "c"])), 0.5);
  assert.equal(coverageOf(new Set(), new Set(["a"])), 1);
  assert.equal(coverageOf(new Set(["a"]), new Set()), 0);
});

test("detectTopicShift：同话题高覆盖不报切换，跨话题低覆盖报切换", () => {
  // 同话题（中英混合调试场景）
  const window = [
    "pi-scenes 切换场景时 settings 双写法导致启动冲突",
    "detectExtensionConflicts 检测 tool 重名然后 exit",
    "修复 isPackageInstalled 身份级判定跳过 pi install",
  ];
  const same = detectTopicShift("再看下身份级去重 dedupeByIdentity 的测试覆盖", window);
  assert.equal(same.shift, false, `同话题不应报切换 (coverage=${same.coverage})`);

  // 完全无关的新话题（求职/简历场景）
  const other = detectTopicShift("帮我优化简历里的项目经历描述，突出量化成果和领导力", window);
  assert.equal(other.shift, true, `跨话题应报切换 (coverage=${other.coverage})`);
});

test("detectTopicShift：短消息与短窗口不判定", () => {
  assert.equal(detectTopicShift("继续", ["话题一内容很长很长", "话题二内容也很长"]).shift, false);
  assert.equal(detectTopicShift("这是一个包含足够词汇量的新话题输入关于完全不同的领域", ["单独一条"]).shift, false);
});

test("readTopicConfig：默认值 / 覆盖 / 损坏配置回落", () => {
  const dir = tmpDir();
  process.env.PI_CARRYOVER_DIR = dir;
  try {
    // 缺失 → 默认
    assert.deepEqual(readTopicConfig(), {
      mode: "suggest",
      minTokens: 40000,
      cooldownTurns: 3,
      archive: true,
      embed: { choice: "auto" },
    });
    // 覆盖
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "settings.json"),
      JSON.stringify({ carryover: { topicCompact: { mode: "auto", minTokens: 60000, cooldownTurns: 5, archive: false } } }),
    );
    const cfg = readTopicConfig();
    assert.equal(cfg.mode, "auto");
    assert.equal(cfg.minTokens, 60000);
    assert.equal(cfg.cooldownTurns, 5);
    assert.equal(cfg.archive, false);
    // 损坏 → 默认
    fs.writeFileSync(path.join(dir, "settings.json"), "{broken json");
    assert.equal(readTopicConfig().mode, "suggest");
  } finally {
    delete process.env.PI_CARRYOVER_DIR;
  }
});

test("writeTopicArchive + listTopicArchives：归档往返与列表", () => {
  const cwd = tmpDir();
  const summary = "## Goal\n修复 pi 启动冲突\n\n## Progress\n- [x] 身份级去重\n\n## Next Steps\n1. 观察 stats";
  const file = writeTopicArchive(cwd, summary, 88000, "threshold");
  assert.ok(file && fs.existsSync(file));
  const list = listTopicArchives(cwd);
  assert.equal(list.length, 1);
  assert.equal(list[0].tokensBefore, 88000);
  assert.ok(list[0].title.length > 0);
  // 内容含摘要与 frontmatter 标记
  const text = fs.readFileSync(file, "utf8");
  assert.ok(text.includes("修复 pi 启动冲突"));
  assert.ok(text.includes("tokensBefore=88000"));
  // 空目录
  assert.equal(listTopicArchives(tmpDir()).length, 0);
});

test("v1.1.2 readTopicConfig/writeEmbedConfig：embed 节解析与原子持久化（本文件串行执行避免 env 竞争）", () => {
  const dir = tmpDir();
  process.env.PI_CARRYOVER_DIR = dir;
  try {
    let cfg = readTopicConfig();
    assert.equal(cfg.embed.choice, "auto"); // 默认启用
    writeEmbedConfig({ choice: "auto", resolvedEndpoint: "https://hf-mirror.com" });
    cfg = readTopicConfig();
    assert.equal(cfg.embed.choice, "auto");
    assert.equal(cfg.embed.resolvedEndpoint, "https://hf-mirror.com");
    // 覆盖单键不影响其他键
    writeEmbedConfig({ choice: "zh" });
    cfg = readTopicConfig();
    assert.equal(cfg.embed.choice, "zh");
    assert.equal(cfg.embed.resolvedEndpoint, "https://hf-mirror.com");
    // settings.json 顶层键保留
    const raw = JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8"));
    assert.ok(typeof raw === "object");
  } finally {
    delete process.env.PI_CARRYOVER_DIR;
  }
});
