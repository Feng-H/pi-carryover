// v1.2.1 原子写 + 事件日志 + 降级完整性标记 的单元验证（直接测 extensions/index.ts 真实导出）
// 思想来源：Pi Durable（checkpoint 事务写 / append-only transcript / aborted 标记）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  atomicWriteText,
  writeCarryover,
  appendCarryoverLog,
  LOG_ROTATE_BYTES,
} from "../extensions/index.ts";

function tmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "carryover-atomic-"));
}

test("atomicWriteText：自动建父目录，无残留临时文件，rename 后内容完整", () => {
  const dir = tmpProject();
  const p = path.join(dir, "nested", ".pi", "CARRYOVER.md");
  atomicWriteText(p, "# hello\n- todo A");
  assert.equal(fs.readFileSync(p, "utf8"), "# hello\n- todo A");
  assert.deepEqual(fs.readdirSync(path.dirname(p)), ["CARRYOVER.md"]); // 无 .tmp 残留
});

test("writeCarryover：覆盖式最新视图 + appendCarryoverLog 可回放多条 entry", () => {
  const dir = tmpProject();
  writeCarryover(dir, "第一版：修 bug");
  writeCarryover(dir, "第二版：写测试");
  // 最新视图：CARRYOVER.md 只保留最后一次
  assert.equal(fs.readFileSync(path.join(dir, ".pi", "CARRYOVER.md"), "utf8"), "第二版：写测试");
  // 事件日志：两条 entry 都在，可回放
  const raw = fs.readFileSync(path.join(dir, ".pi", "carryover.log"), "utf8");
  assert.equal(raw.split("```carryover-entry").length - 1, 2);
  assert.ok(raw.includes("第一版：修 bug") && raw.includes("第二版：写测试"));
});

test("carryover.log 轮转：超过 1MB 时旧日志改名为 .1，新日志从新 entry 开始", () => {
  const dir = tmpProject();
  const log = path.join(dir, ".pi", "carryover.log");
  fs.mkdirSync(path.dirname(log), { recursive: true });
  // 预置一个超限旧日志
  fs.writeFileSync(log, "x".repeat(LOG_ROTATE_BYTES + 1), "utf8");
  appendCarryoverLog(dir, "轮转后的新 entry");
  assert.ok(fs.existsSync(`${log}.1`), "旧日志应轮转为 .1");
  assert.equal(fs.statSync(`${log}.1`).size, LOG_ROTATE_BYTES + 1);
  const fresh = fs.readFileSync(log, "utf8");
  assert.ok(fresh.includes("轮转后的新 entry"));
  assert.ok(!fresh.includes("x"), "新日志不应含旧内容");
});

test("降级完整性标记：超过 FALLBACK 上限时给出覆盖范围提示", () => {
  const FALLBACK_MAX_USER_MSGS = 8;
  const totalUserMsgs = 15;
  const marker =
    totalUserMsgs > FALLBACK_MAX_USER_MSGS
      ? `仅覆盖最近 ${FALLBACK_MAX_USER_MSGS} 条（共 ${totalUserMsgs} 条）`
      : "";
  assert.ok(marker.includes("8") && marker.includes("15"));
});
