/**
 * Carryover Extension for pi
 *
 * 跨会话工作承接：让 pi 能“接续”上次干到哪，下次接着干。
 * 按工作目录区分 —— 每个项目一份 <cwd>/.pi/CARRYOVER.md。
 *
 * 三层保障（不把宝押在“退出时调 LLM”上）：
 *   1. 平时：agent 通过 save_carryover 工具主动维护 .pi/CARRYOVER.md（用干活时的 token，
 *      与退出时刻的 token 状态无关 —— 这是主力，最稳）
 *   2. 退出时：LLM 增量摘要（30s 超时，失败则跳过，不卡退出）
 *   3. 退出降级：LLM 不可用/超时（token 用完等）时，直接抓取最近对话原样落盘
 *
 * 启动时：自动把 .pi/CARRYOVER.md 注入 system prompt，agent 无缝接续。
 * 与 pi 自带会话机制联动：保存时同步记录会话文件路径（.pi/.carryover-session），
 * 注入时附带提示，需要回看完整历史细节时用 /resume 直接定位 ——
 * pi 自带机制是数据层（完整历史永远在），本扩展是状态层（永远知道该干什么）。
 *
 * 命令：/carryover 查看 | /carryover save 手动生成 | /carryover clear 清空
 */

import { uuidv7 } from "@earendil-works/pi-ai";
import { complete } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import fs from "node:fs";
import path from "node:path";

const STORE_DIR = ".pi";
const CARRYOVER_FILE = "CARRYOVER.md";
const SESSION_META_FILE = ".carryover-session"; // 记录最近会话文件路径（纯路径一行）
const LLM_TIMEOUT_MS = 30_000;
const FALLBACK_MAX_USER_MSGS = 8;
const FALLBACK_MAX_ASSISTANT_CHARS = 1500;

// ---------- 文件读写 ----------

function carryoverPath(cwd: string): string {
  return path.join(cwd, STORE_DIR, CARRYOVER_FILE);
}

function readCarryover(cwd: string): string | null {
  try {
    const p = carryoverPath(cwd);
    if (fs.existsSync(p)) {
      const text = fs.readFileSync(p, "utf8").trim();
      return text.length > 0 ? text : null;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function writeCarryover(cwd: string, content: string): void {
  const p = carryoverPath(cwd);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf8");
}

// ---------- 会话联动（最近会话文件路径，独立存储避免被全量覆盖） ----------

function sessionMetaPath(cwd: string): string {
  return path.join(cwd, STORE_DIR, SESSION_META_FILE);
}

function writeSessionMeta(cwd: string, sessionFile: string | undefined): void {
  if (!sessionFile) return; // --no-session 模式没有会话文件
  try {
    const p = sessionMetaPath(cwd);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, sessionFile, "utf8");
  } catch {
    /* ignore */
  }
}

function readSessionMeta(cwd: string): string | null {
  try {
    const p = sessionMetaPath(cwd);
    if (fs.existsSync(p)) {
      const text = fs.readFileSync(p, "utf8").trim();
      return text.length > 0 ? text : null;
    }
  } catch {
    /* ignore */
  }
  return null;
}

// ---------- 文本提取 ----------

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const c of content) {
    if (c && typeof c === "object" && (c as any).type === "text" && typeof (c as any).text === "string") {
      parts.push((c as any).text);
    }
  }
  return parts.join("\n");
}

interface SessionEntryLike {
  type: string;
  message?: { role?: string; content?: unknown };
}

function buildConversationText(entries: SessionEntryLike[]): string {
  const lines: string[] = [];
  for (const e of entries) {
    if (e.type !== "message" || !e.message?.role) continue;
    const role = e.message.role;
    if (role !== "user" && role !== "assistant") continue;
    const text = extractText(e.message.content).trim();
    if (text) lines.push(`${role === "user" ? "User" : "Assistant"}: ${text}`);
  }
  return lines.join("\n\n");
}

/** LLM 不可用时的兜底：抓最近几条用户消息 + 最后一条 assistant 回复。 */
function fallbackExtract(entries: SessionEntryLike[]): string {
  const userMsgs = entries.filter((e) => e.type === "message" && e.message?.role === "user");
  const lastUsers = userMsgs.slice(-FALLBACK_MAX_USER_MSGS);
  const parts: string[] = [];
  for (const e of lastUsers) {
    const t = extractText(e.message!.content).trim();
    if (t) parts.push(`- ${t.replace(/\n/g, "\n  ")}`);
  }
  let lastAssistant = "";
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type === "message" && e.message?.role === "assistant") {
      lastAssistant = extractText(e.message.content).trim();
      if (lastAssistant) break;
    }
  }
  if (lastAssistant) {
    parts.push(`\n最后回复:\n${lastAssistant.slice(0, FALLBACK_MAX_ASSISTANT_CHARS)}`);
  }
  return parts.join("\n");
}

// ---------- LLM 摘要 ----------

const SUMMARY_SYSTEM_PROMPT = `你是编码 agent 会话的“承接笔记”生成器，为下一次会话能无缝接续工作而服务。

只输出 markdown 正文，不要任何前言或解释。保持精简（300 字以内；中文对话用中文，英文对话用英文）。

严格规则：
- 只记录：未完成的工作、待办事项、关键决策或方向、当前卡点、明确的下一步。
- 绝不记录已完成的工作或已解决的细节。
- 使用标题分节：## 待办 / ## 关键决策 / ## 下一步。
- 如果确实没有未完成事项，只写“无未完成事项”。`;

/** 用当前会话模型生成摘要。失败/超时/无 key 返回 null（调用方走降级）。 */
async function generateSummary(
  ctx: any,
  conversationText: string,
  existingCarryover: string | null,
): Promise<string | null> {
  if (!ctx.model) return null;
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
  if (!auth.ok || !auth.apiKey) return null;

  const userText = [
    existingCarryover ? `## 现有承接笔记（参考并更新）\n${existingCarryover}\n` : "",
    `## 本次会话记录\n${conversationText}\n`,
    "请基于以上更新工作承接（只保留未完成/待办/关键决策/下一步，删除已完成）。",
  ].join("\n");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
  try {
    const resp = await complete(
      ctx.model,
      {
        systemPrompt: SUMMARY_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: userText }],
            timestamp: Date.now(),
          } as any,
        ],
      },
      {
        apiKey: auth.apiKey,
        headers: auth.headers,
        env: auth.env,
        signal: controller.signal,
        cacheRetention: "none",
        sessionId: uuidv7(),
      },
    );
    if (resp.stopReason === "aborted") return null;
    const summary = resp.content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("\n")
      .trim();
    return summary.length > 0 ? summary : null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------- 扩展 ----------

export default function (pi: ExtensionAPI) {
  // 1) 对话时注入承接笔记 + 会话联动提示 + 维护指令（每次都会带上，但 CARRYOVER.md 精简，开销可忽略）
  pi.on("before_agent_start", async (event: any, ctx: any) => {
    const mem = readCarryover(ctx.cwd);
    const lastSession = readSessionMeta(ctx.cwd);
    if (!mem && !lastSession) return;
    const block = [
      "",
      "## 上次工作承接（自动加载自 .pi/CARRYOVER.md）",
      "以下是上次会话结束时的工作状态。开始新任务前请先阅读，并据此接续工作：",
      "",
      mem ?? "（暂无摘要）",
      "",
    ];
    if (lastSession) {
      block.push(
        `上次会话文件: \`${lastSession}\`（需要回看完整历史细节时，告诉用户可用 /resume 或 \`pi --session\` 恢复该会话）`,
        "",
      );
    }
    block.push(
      "## 工作承接维护要求",
      "当你完成一个里程碑、待办发生变化、或做出关键决策时，请调用 `save_carryover` 工具更新 .pi/CARRYOVER.md：",
      "只保留未完成的工作、待办、关键决策、卡点和下一步；删除已完成的事项。这样下次启动能快速接续。",
      "",
    );
    return { systemPrompt: event.systemPrompt + block.join("\n") };
  });

  // 2) save_carryover 工具 —— agent 平时主动维护（主力路径）
  pi.registerTool({
    name: "save_carryover",
    label: "Save Carryover",
    description:
      "更新本项目的跨会话工作承接 (.pi/CARRYOVER.md)。写入当前未完成工作、待办、关键决策、卡点和下一步，删除已完成事项。在完成里程碑、待办变化或退出前调用。",
    promptSnippet: "更新跨会话工作承接（未完成工作 + 待办）",
    promptGuidelines: [
      "Use save_carryover when finishing a milestone, when TODOs or next steps change, or before the session ends, to keep .pi/CARRYOVER.md current with only unfinished work.",
    ],
    parameters: Type.Object({
      content: Type.String({
        description:
          ".pi/CARRYOVER.md 的完整 markdown 内容。只包含未完成工作、待办、关键决策、卡点、下一步。会覆盖整个文件。",
      }),
    }),
    async execute(_toolCallId: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
      try {
        writeCarryover(ctx.cwd, params.content.trim());
        writeSessionMeta(ctx.cwd, ctx.sessionManager.getSessionFile()); // 同步记录当前会话
        return {
          content: [{ type: "text", text: `已更新工作承接: ${carryoverPath(ctx.cwd)}` }],
          details: {},
        };
      } catch (e: any) {
        return { content: [{ type: "text", text: `保存失败: ${e?.message ?? e}` }], details: {} };
      }
    },
  });

  // 3) 退出时：LLM 增量摘要（尽力）+ 降级抓取（兜底）
  pi.on("session_shutdown", async (event: any, ctx: any) => {
    if (event?.reason !== "quit") return;
    const cwd = ctx.cwd;
    // 无论摘要成败，都记录会话文件路径供下次 /resume 联动
    writeSessionMeta(cwd, ctx.sessionManager.getSessionFile());
    let saved = false;

    // 3a) 尝试 LLM 摘要
    try {
      const entries: SessionEntryLike[] = ctx.sessionManager.getBranch();
      const conv = buildConversationText(entries);
      if (conv.trim()) {
        if (ctx.hasUI) ctx.ui.notify("💾 正在保存工作承接...", "info");
        const summary = await generateSummary(ctx, conv, readCarryover(cwd));
        if (summary) {
          const header = `<!-- carryover: LLM 摘要 @ ${new Date().toISOString()} -->\n`;
          writeCarryover(cwd, header + summary);
          saved = true;
          if (ctx.hasUI) ctx.ui.notify("💾 工作承接已保存 (LLM 摘要)", "info");
        }
      }
    } catch {
      /* 走降级 */
    }

    // 3b) 降级抓取（LLM 不可用 / token 用完 / 超时）—— 不调 LLM，100% 可靠
    if (!saved) {
      try {
        const entries: SessionEntryLike[] = ctx.sessionManager.getBranch();
        const raw = fallbackExtract(entries);
        if (raw.trim()) {
          const header =
            `<!-- carryover: 降级抓取 @ ${new Date().toISOString()}（LLM 不可用/超时） -->\n` +
            `⚠️ 以下为最近对话原始记录（因 LLM 不可用，未生成精简摘要）。\n\n`;
          writeCarryover(cwd, header + raw);
          if (ctx.hasUI) ctx.ui.notify("💾 工作承接已保存 (降级抓取)", "warning");
        }
      } catch {
        /* 尽力而为 */
      }
    }
  });

  // 4) /carryover 命令
  pi.registerCommand("carryover", {
    description: "工作承接 (.pi/CARRYOVER.md)：/carryover 查看 | /carryover save 手动生成 | /carryover clear 清空",
    handler: async (args: string, ctx: any) => {
      const sub = (args || "").trim().split(/\s+/)[0]?.toLowerCase();
      const p = carryoverPath(ctx.cwd);

      if (sub === "clear") {
        try {
          writeCarryover(ctx.cwd, "");
          ctx.ui.notify("已清空工作承接", "info");
        } catch (e: any) {
          ctx.ui.notify(`清空失败: ${e?.message ?? e}`, "error");
        }
        return;
      }

      if (sub === "save") {
        if (!ctx.model) {
          ctx.ui.notify("未选择模型，无法生成摘要", "error");
          return;
        }
        const branch: SessionEntryLike[] = ctx.sessionManager.getBranch();
        const conv = buildConversationText(branch);
        if (!conv.trim()) {
          ctx.ui.notify("当前会话无内容，无需保存", "info");
          return;
        }
        ctx.ui.notify("正在生成摘要...", "info");
        try {
          const summary = await generateSummary(ctx, conv, readCarryover(ctx.cwd));
          if (summary) {
            const header = `<!-- carryover: 手动保存 @ ${new Date().toISOString()} -->\n`;
            writeCarryover(ctx.cwd, header + summary);
            writeSessionMeta(ctx.cwd, ctx.sessionManager.getSessionFile());
            ctx.ui.notify("💾 工作承接已保存", "info");
          } else {
            ctx.ui.notify("生成失败（无 API key 或超时），可让 agent 调用 save_carryover 手动保存", "warning");
          }
        } catch (e: any) {
          ctx.ui.notify(`生成失败: ${e?.message ?? e}`, "error");
        }
        return;
      }

      // 默认：查看（notify 截断显示 + 文件路径）
      const mem = readCarryover(ctx.cwd);
      const lastSession = readSessionMeta(ctx.cwd);
      if (!mem && !lastSession) {
        ctx.ui.notify(`暂无工作承接 (${p})`, "info");
        return;
      }
      const parts: string[] = [`工作承接 (${p}):`];
      if (mem) {
        parts.push("", mem.length > 800 ? `${mem.slice(0, 800)}\n…（已截断，完整内容见 ${p}）` : mem);
      }
      if (lastSession) {
        parts.push(`\n📎 上次会话: ${lastSession}（/resume 可恢复）`);
      }
      ctx.ui.notify(parts.join("\n"), "info");
    },
  });
}
