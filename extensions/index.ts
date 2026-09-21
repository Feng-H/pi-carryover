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
 * v1.1.0 话题压缩（Topic Compaction）：上下文全生命周期记忆的会话内一环。
 *   - input 钩子零 LLM 检测话题切换（新消息 vs 近期话题窗口的词频覆盖）
 *   - suggest（默认）提示用户 /compact；auto（opt-in）ctx.compact 主动压缩
 *   - session_compact 钩子把每次压缩摘要归档到 <cwd>/.pi/topics/（压缩即沉淀）
 *   - /carryover topics 查看话题归档
 *   配置：~/.pi/agent/settings.json 的 carryover.topicCompact 节
 *
 * 命令：/carryover 查看 | /carryover save 手动生成 | /carryover clear 清空 | /carryover topics 话题归档
 */

import { uuidv7 } from "@earendil-works/pi-ai";
import { complete } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import fs from "node:fs";
import os from "node:os";
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

// ---------- 话题压缩（v1.1.0）----------

const TOPIC_WINDOW = 6; // 近期用户消息窗口（当前话题样本）
const SHIFT_COVERAGE = 0.12; // 新消息词频被窗口覆盖比例低于此值 → 疑似话题切换
const MIN_NEW_TOKENS = 6; // 新消息有效词条数下限（太少无法判断）
const MAX_ARCHIVES = 50; // 话题归档数量上限（超出删最旧）

const AUTO_COMPACT_INSTRUCTIONS =
  "用户已切换话题。请在摘要中完整保留旧话题的目标、已完成的结论、关键决策、文件读取/修改清单与未完成事项，便于日后召回；对与新话题已无关的内容不要展开。";

const LATIN_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "if", "then", "this", "that", "these", "those",
  "is", "are", "was", "were", "be", "been", "to", "of", "in", "on", "for", "with",
  "as", "at", "by", "from", "it", "its", "you", "we", "they", "me", "my", "our",
  "do", "does", "did", "can", "could", "should", "would", "will", "not", "no", "yes",
  "what", "which", "who", "how", "when", "where", "why", "all", "any", "some", "more",
  "other", "into", "over", "under", "about", "just", "than", "too", "very", "now",
  "there", "here", "them", "his", "her", "him", "she", "he", "have", "has", "had",
]);

export interface TopicCompactConfig {
  mode: "off" | "suggest" | "auto";
  minTokens: number;
  cooldownTurns: number;
  archive: boolean;
}

const DEFAULT_TOPIC_CONFIG: TopicCompactConfig = {
  mode: "suggest",
  minTokens: 40_000,
  cooldownTurns: 3,
  archive: true,
};

/** 全局 settings.json 路径（测试可用 PI_CARRYOVER_DIR 注入） */
function agentSettingsPath(): string {
  return path.join(process.env.PI_CARRYOVER_DIR ?? path.join(os.homedir(), ".pi", "agent"), "settings.json");
}

/** 读取 carryover.topicCompact 配置（异常/缺失回落默认值，绝不影响输入链路） */
export function readTopicConfig(): TopicCompactConfig {
  const cfg = { ...DEFAULT_TOPIC_CONFIG };
  try {
    const raw = JSON.parse(fs.readFileSync(agentSettingsPath(), "utf8"));
    const tc = raw?.carryover?.topicCompact;
    if (tc && typeof tc === "object") {
      if (tc.mode === "off" || tc.mode === "suggest" || tc.mode === "auto") cfg.mode = tc.mode;
      if (typeof tc.minTokens === "number" && tc.minTokens >= 0) cfg.minTokens = tc.minTokens;
      if (typeof tc.cooldownTurns === "number" && tc.cooldownTurns >= 0) cfg.cooldownTurns = tc.cooldownTurns;
      if (typeof tc.archive === "boolean") cfg.archive = tc.archive;
    }
  } catch {
    /* 配置缺失/损坏 → 默认值 */
  }
  return cfg;
}

/** 分词：拉丁词（去停用词）+ CJK 二元组。零依赖零 LLM。 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const w of text.toLowerCase().match(/[a-z_][a-z0-9_-]{2,}/g) ?? []) {
    if (!LATIN_STOPWORDS.has(w)) out.push(w);
  }
  const cjk = (text.match(/[\u4e00-\u9fff]+/g) ?? []).join("");
  for (let i = 0; i + 1 < cjk.length; i++) out.push(cjk.slice(i, i + 2));
  return out;
}

/** 覆盖率：新消息词条被窗口命中的比例 */
export function coverageOf(newTokens: Set<string>, windowTokens: Set<string>): number {
  if (newTokens.size === 0) return 1;
  let hit = 0;
  for (const t of newTokens) if (windowTokens.has(t)) hit++;
  return hit / newTokens.size;
}

/** 话题切换检测：新输入 vs 近期话题窗口。词条不足/窗口太短时不判定。 */
export function detectTopicShift(input: string, recentInputs: string[]): { shift: boolean; coverage: number } {
  const nt = new Set(tokenize(input));
  if (nt.size < MIN_NEW_TOKENS || recentInputs.length < 2) return { shift: false, coverage: 1 };
  const wt = new Set(recentInputs.flatMap(tokenize));
  if (wt.size === 0) return { shift: true, coverage: 0 };
  const cov = coverageOf(nt, wt);
  return { shift: cov < SHIFT_COVERAGE, coverage: cov };
}

function topicsDir(cwd: string): string {
  return path.join(cwd, STORE_DIR, "topics");
}

/** 压缩摘要 → 话题归档（压缩即沉淀）。返回归档文件路径，失败返回 null。 */
export function writeTopicArchive(cwd: string, summary: string, tokensBefore: number, reason: string): string | null {
  try {
    const dir = topicsDir(cwd);
    fs.mkdirSync(dir, { recursive: true });
    const ts = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const name =
      `${ts.getFullYear()}-${pad(ts.getMonth() + 1)}-${pad(ts.getDate())}` +
      `_${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}.md`;
    const file = path.join(dir, name);
    const title =
      summary
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l && !l.startsWith("<!--") && !l.startsWith("#")) ?? "话题摘要";
    const content = [
      `<!-- topic-archive @ ${ts.toISOString()} reason=${reason} tokensBefore=${tokensBefore} -->`,
      `# ${title.replace(/^#+\s*/, "").slice(0, 60)}`,
      "",
      summary,
      "",
    ].join("\n");
    fs.writeFileSync(file, content, "utf8");
    const all = fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
    while (all.length > MAX_ARCHIVES) fs.rmSync(path.join(dir, all.shift()!), { force: true });
    return file;
  } catch {
    return null;
  }
}

export interface TopicArchiveInfo {
  file: string;
  title: string;
  tokensBefore: number | null;
  ts: string;
}

/** 列出话题归档（新→旧） */
export function listTopicArchives(cwd: string): TopicArchiveInfo[] {
  try {
    const dir = topicsDir(cwd);
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .sort()
      .reverse()
      .map((f) => {
        const file = path.join(dir, f);
        let title = f;
        let tokensBefore: number | null = null;
        let ts = "";
        try {
          const text = fs.readFileSync(file, "utf8");
          const m = text.match(/<!-- topic-archive @ ([^ ]+) reason=\S+ tokensBefore=(\d+) -->/);
          if (m) {
            ts = m[1];
            tokensBefore = Number(m[2]);
          }
          const h = text.match(/^# (.+)$/m);
          if (h) title = h[1];
        } catch {
          /* 单文件读失败跳过展示细节 */
        }
        return { file, title, tokensBefore, ts };
      });
  } catch {
    return [];
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

  // 5) 话题压缩：input 钩子零 LLM 检测话题切换（suggest 提示 / auto 主动压缩）
  let recentInputs: string[] = []; // 当前话题窗口（近期用户消息）
  let turnsSinceTrigger = 0; // 距上次触发/压缩的用户轮数（冷却护栏）

  pi.on("input", async (event: any, ctx: any) => {
    if (event?.source !== "interactive") return { action: "continue" };
    const text = String(event?.text ?? "").trim();
    // 命令、空输入、流式打断消息不参与检测（打断常与当前话题相关）
    if (!text || text.startsWith("/") || event?.streamingBehavior === "steer") return { action: "continue" };
    try {
      const cfg = readTopicConfig();
      if (cfg.mode !== "off") {
        turnsSinceTrigger++;
        const det = detectTopicShift(text, recentInputs);
        const eligible =
          det.shift &&
          recentInputs.length >= 2 &&
          turnsSinceTrigger > cfg.cooldownTurns;
        if (eligible) {
          const usage = ctx.getContextUsage?.();
          const tokens = usage?.tokens ?? null;
          if (tokens !== null && tokens >= cfg.minTokens) {
            turnsSinceTrigger = 0;
            if (cfg.mode === "auto" && typeof ctx.compact === "function") {
              ctx.compact({
                customInstructions: AUTO_COMPACT_INSTRUCTIONS,
                onError: (e: any) => {
                  try {
                    ctx.ui.notify(`🌀 自动压缩失败: ${e?.message ?? e}`, "warning");
                  } catch {}
                },
              });
              ctx.ui.notify(
                `🌀 疑似话题切换（覆盖率 ${det.coverage.toFixed(2)}），已自动压缩旧话题上下文（${tokens} tokens）`,
                "info",
              );
            } else {
              ctx.ui.notify(
                `🌀 新问题似乎与近期工作关联不大（疑似话题切换），当前上下文 ${tokens} tokens。` +
                  `可执行 /compact 压缩旧话题（结论保留在摘要中，随时可召回）；` +
                  `如需自动压缩，在 settings.json 配置 carryover.topicCompact.mode="auto"`,
                "info",
              );
            }
          }
        }
      }
      recentInputs.push(text);
      if (recentInputs.length > TOPIC_WINDOW) recentInputs.shift();
    } catch {
      /* 检测异常绝不影响正常输入链路 */
    }
    return { action: "continue" };
  });

  // 6) 压缩即沉淀：每次压缩成功后归档摘要，并重置话题窗口
  pi.on("session_compact", async (event: any, ctx: any) => {
    recentInputs = [];
    turnsSinceTrigger = 0;
    try {
      const cfg = readTopicConfig();
      if (!cfg.archive) return;
      const entry = event?.compactionEntry;
      if (!entry?.summary) return;
      const file = writeTopicArchive(ctx.cwd, String(entry.summary), Number(entry.tokensBefore) || 0, String(event?.reason ?? "manual"));
      if (file && ctx.hasUI) ctx.ui.notify(`📦 旧话题已归档: ${path.basename(file)}（/carryover topics 查看）`, "info");
    } catch {
      /* 归档失败不影响压缩本身 */
    }
  });

  // 7) /carryover 命令
  pi.registerCommand("carryover", {
    description: "工作承接：/carryover 查看 | save 手动生成 | clear 清空 | topics 话题归档",
    handler: async (args: string, ctx: any) => {
      const sub = (args || "").trim().split(/\s+/)[0]?.toLowerCase();
      const p = carryoverPath(ctx.cwd);

      if (sub === "topics") {
        const list = listTopicArchives(ctx.cwd);
        if (list.length === 0) {
          ctx.ui.notify(`暂无话题归档（${topicsDir(ctx.cwd)}）。压缩发生后会自动归档摘要。`, "info");
          return;
        }
        const lines = list
          .slice(0, 10)
          .map((a) => `· ${a.tokensBefore != null ? `${a.tokensBefore} tokens · ` : ""}${a.title}`);
        ctx.ui.notify(`话题归档（共 ${list.length} 份，目录 ${topicsDir(ctx.cwd)}）：\n${lines.join("\n")}`, "info");
        return;
      }

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
