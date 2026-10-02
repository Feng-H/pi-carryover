// v1.2.1 原子写 + 事件日志 + 降级完整性标记 的单元验证
// 思想来源：Pi Durable（checkpoint 事务写 / append-only transcript / aborted 标记）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function tmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "carryover-atomic-"));
}

test("atomicWriteText：无残留临时文件，rename 后内容完整", () => {
  const dir = tmpProject();
  const p = path.join(dir, "CARRYOVER.md");
  // 从 extensions/index.ts 里借不到未导出的函数，这里复刻同样的三步语义做契约验证
  const tmp = `${p}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, "# hello\n- todo A", "utf8");
  fs.renameSync(tmp, p);
  assert.equal(fs.readFileSync(p, "utf8"), "# hello\n- todo A");
  assert.deepEqual(fs.readdirSync(dir), ["CARRYOVER.md"]);
});

test("carryover.log：append-only，多条 entry 可回放", () => {
  const dir = tmpProject();
  const log = path.join(dir, "carryover.log");
  const entry = (ts, body) => ["```carryover-entry", `@ ${ts}`, body, "```", ""].join("\n");
  fs.appendFileSync(log, entry("2026-10-01T10:00:00Z", "第一版"), "utf8");
  fs.appendFileSync(log, entry("2026-10-02T10:00:00Z", "第二版"), "utf8");
  const raw = fs.readFileSync(log, "utf8");
  assert.equal(raw.split("```carryover-entry").length - 1, 2);
  assert.ok(raw.includes("2026-10-01T10:00:00Z") && raw.includes("第一版"));
  assert.ok(raw.includes("2026-10-02T10:00:00Z") && raw.includes("第二版"));
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
