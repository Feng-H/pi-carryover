# pi-carryover

[![npm version](https://img.shields.io/npm/v/pi-carryover.svg?color=blue)](https://www.npmjs.com/package/pi-carryover)
[![npm downloads](https://img.shields.io/npm/dt/pi-carryover.svg?color=green)](https://www.npmjs.com/package/pi-carryover)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![pi-package](https://img.shields.io/badge/pi-package-00b57a)](https://pi.dev/packages)

**[English](#how-is-this-different-from-pis-built-in-handoff-and-pi--c) | [简体中文](#中文说明)**

> Cross-session work carryover for the [pi](https://pi.dev) coding agent — quit today, and tomorrow's fresh `pi` already knows exactly what's unfinished and what's next.

Every project gets a `<cwd>/.pi/CARRYOVER.md` holding **only unfinished work** (TODOs, key decisions, blockers, next steps — completed items are always dropped). It's injected into the system prompt at every session start, per project directory.

## Install

Install via **npm** (recommended):

```bash
pi install npm:pi-carryover
```

Or install directly from **GitHub**:

```bash
pi install git:github.com/Feng-H/pi-carryover
```

Zero config. Works immediately in every project.

---

## How is this different from pi's built-in `/handoff` and `pi -c`?

Three different tools for three different jobs — they complement, not compete:

| | **pi built-in `pi -c` / `/resume`** | **pi official `/handoff` example** | **pi-carryover (this)** |
|---|---|---|---|
| What it does | Replays the **full history** of the last (or picked) session | Generates a one-shot **kickoff prompt** for a *new task* from current context | Maintains a **living project state note** across sessions |
| Trigger | Manual — you must remember `-c` or pick a session | Manual — you run `/handoff <goal>` mid-session when starting something new | **Automatic** — saves on quit, injects on every start. `/carryover save` for manual |
| Persistence | Session JSONL files (machine format) | None — the generated prompt is a draft in your editor, not saved | `<cwd>/.pi/CARRYOVER.md` — human-readable, hand-editable, git-committable |
| Scope | One conversation line | One task transfer | **The whole project** (per-cwd, accumulates across many sessions) |
| Session linkage | *is* the data | Loses the old session | Records last session path (`.pi/.carryover-session`); the agent tells you when `/resume` would help |
| Token cost per start | Full history replay (can be huge) | One LLM generation per use | ~300–600 tokens, flat |

**Mental model:**

- `pi -c` / `/resume` = **the database** — nothing is ever lost, but you must know where to look, and replaying costs full context.
- `/handoff` = **the courier** — "I'm switching to a new task *right now*; package what matters into one prompt."
- `pi-carryover` = **the sticky note on the whiteboard** — always current, always visible at the next standup, for any session you start.

They compose well: work across many sessions with carryover keeping state; `/handoff` when pivoting to a fresh task; `/resume` (the path is recorded for you) when details matter.

## When you need it (and when you don't)

**Strong fit:**

- Multi-day projects — "pick up where I left off" without re-explaining or hunting sessions
- Many parallel projects — each directory self-describes its own state on open
- Frequent `pi` restarts (new terminals, reboots, mid-task interruptions)
- Team workflows — commit `.pi/CARRYOVER.md` and teammates' agents inherit the project state
- Cheap/free/rotating model setups where long `-c` replays are wasteful or unreliable

**Weak fit (skip it):**

- One-shot throwaway sessions (`pi --no-session`)
- Single linear session you always continue with `pi -c`
- Strictly private scratch work you never want on disk

## Token cost — honest numbers

| Cost item | When | Approx. size |
|---|---|---|
| Inject notes + maintenance instructions into system prompt | **Every LLM call** | ~400–600 tokens (notes ≤300 words + fixed ~150-token instruction block) |
| `save_carryover` tool schema (`promptSnippet` + guidelines) | Every LLM call (tool listing) | ~80 tokens, flat |
| Agent writing notes via `save_carryover` | At milestones / TODO changes (few times per session) | The note itself (~300–500 tokens), inside the ongoing conversation |
| Exit LLM summary (tier 2) | Once, on quit | One standalone call; input ≈ full conversation text, output ≤300 words. 30s timeout, silently skipped on failure |
| Raw fallback (tier 3) | Only when tier 2 fails | **Zero LLM cost** — pure file I/O |

Notes on the recurring cost:

- **Caching works in your favor.** The injected block sits at a stable position in the prompt, so with provider prompt caching (most providers), repeat calls hit cache; the ~500 tokens only truly bill once per session (and once more after each note update invalidates it).
- **Versus the alternative:** a `pi -c` replay of a long session routinely costs tens of thousands of context tokens *per call*; carryover is a flat few hundred.
- **Zero at exit is survivable by design:** if tokens are exhausted at quit time (exactly when it matters), tier 3 grabs raw recent turns to disk without calling any LLM — the next session still gets a usable state.

## How it works

**Three-tier reliability** — never bet everything on "LLM available at exit time":

| Tier | When | LLM needed? | Reliability |
|------|------|:-----------:|-------------|
| 1. Agent-maintained notes | During work, via the `save_carryover` tool | Uses your working tokens | 🌟 Primary — nearly lossless |
| 2. LLM exit summary | On quit, ≤300-word incremental summary | yes | Best effort (30s timeout) |
| 3. Raw fallback | On quit when LLM unavailable / out of tokens | **no** | 💯 100% guaranteed |

**Session linkage** — on every save, the current session file path is recorded to `.pi/.carryover-session`; on startup it's injected alongside the notes, so the agent can point you to `/resume` when full-history detail is needed. pi's sessions are the *data layer*; this extension is the *state layer*.

## Commands & files

| Command | Description |
|---------|-------------|
| `/carryover` | View notes (truncated preview + last session path) |
| `/carryover save` | Manually generate an LLM summary now |
| `/carryover clear` | Clear the notes |

```
<project>/.pi/CARRYOVER.md        # the notes (markdown, human-editable, git-committable)
<project>/.pi/.carryover-session  # last session file path (for /resume linkage)
```

---

## 中文说明

> pi coding agent 的跨会话工作承接扩展 —— 今天退出，明天全新启动的 `pi` 已经知道还有什么没干完、下一步是什么。

每个项目目录维护一份 `<cwd>/.pi/CARRYOVER.md`,**只保留未完成的工作**(待办、关键决策、卡点、下一步 —— 已完成的事项永远会被删掉)。每次会话启动自动注入 system prompt,按项目目录隔离。

### 安装方式

通过 **npm 官方镜像** 安装（推荐）：

```bash
pi install npm:pi-carryover
```

或者直接从 **GitHub** 安装：

```bash
pi install git:github.com/Feng-H/pi-carryover
```

- npm 官方包页面：[https://www.npmjs.com/package/pi-carryover](https://www.npmjs.com/package/pi-carryover)

零配置,装完即用,对所有项目目录生效。

### 与官方 `/handoff`、`pi -c` 的区别

三者是三件不同的事,互补而非竞争:

| | **pi 自带 `pi -c` / `/resume`** | **官方 `/handoff` 示例** | **pi-carryover(本扩展)** |
|---|---|---|---|
| 做什么 | 回放最后(或选定)会话的**完整历史** | 从当前上下文一次性生成**新任务的启动 prompt** | 跨会话维护**项目状态笔记** |
| 触发 | 手动 —— 你得记得 `-c` 或去挑会话 | 手动 —— 会话中切新任务时 `/handoff <goal>` | **全自动** —— 退出时保存、每次启动注入;也可 `/carryover save` 手动 |
| 持久化 | 会话 JSONL(机器格式) | 无 —— 生成的 prompt 是编辑器草稿,不落盘 | `<cwd>/.pi/CARRYOVER.md` —— 人可读、可手改、可进 git |
| 范围 | 一条对话线 | 一次任务转移 | **整个项目**(按目录,跨多个会话累积) |
| 会话联动 | 本身就是数据 | 丢失旧会话 | 记录最近会话路径(`.pi/.carryover-session`),需要时 agent 会告诉你用 `/resume` |
| 每次启动 token 成本 | 完整历史回放(可能巨大) | 每次使用一次 LLM 生成 | ~300-600 tokens,恒定 |

**心智模型:**

- `pi -c` / `/resume` = **数据库** —— 什么都不丢,但你得知道去哪找,回放要付完整上下文的钱;
- `/handoff` = **快递员** —— "我现在要切新任务,把要紧的东西打包成一个 prompt";
- `pi-carryover` = **白板上的便签** —— 永远最新,任何一次开工都能看到。

三者可以组合:平时用 carryover 维持项目状态;切新任务用 `/handoff`;需要历史细节时用 `/resume`(路径已替你记好)。

### 适用场景

**强烈匹配:**

- 多天项目 —— "接着上次干"不用重新交代、不用翻会话
- 多项目并行 —— 每个目录打开即自述状态
- 频繁重启 pi(新终端、重启、中途打断)
- 团队协作 —— 把 `.pi/CARRYOVER.md` 提交进 git,队友的 agent 自动继承项目状态
- 廉价/免费/轮换模型 —— 长会话 `-c` 回放又贵又不可靠时

**弱匹配(可以不装):**

- 一次性临时会话(`pi --no-session`)
- 永远单会话线性工作、总是 `pi -c` 续开
- 绝不想落盘的隐私工作

### Token 消耗 —— 诚实数字

| 成本项 | 时机 | 大小 |
|---|---|---|
| 注入笔记 + 维护指令到 system prompt | **每次 LLM 调用** | ~400-600 tokens(笔记≤300字 + 固定~150 token 指令块) |
| `save_carryover` 工具 schema | 每次 LLM 调用(工具列表) | ~80 tokens,恒定 |
| agent 通过 `save_carryover` 写笔记 | 里程碑/待办变化时(每会话几次) | 笔记本身(~300-500 tokens),在会话内完成 |
| 退出 LLM 摘要(第2层) | 退出时一次 | 独立调用一次;输入≈会话全文,输出≤300字;30s 超时静默跳过 |
| 降级抓取(第3层) | 仅第2层失败时 | **零 LLM 成本** —— 纯文件读写 |

关于经常性成本的说明:

- **Prompt caching 帮你省钱**:注入块位置稳定,多数 provider 的 prompt 缓存会命中;~500 tokens 每会话真正计费约一次(笔记更新后失效一次,随后又稳定)。
- **对比基线**:长会话 `pi -c` 回放动辄每次调用几万上下文 token;carryover 是恒定几百。
- **退出时零 token 也可存活**:退出那一刻 token 正好用完(最坏时机)时,第3层不调任何 LLM 直接抓最近对话落盘 —— 下次会话照样有可用状态。

### 工作原理

**三层保障** —— 绝不把宝押在"退出时 LLM 可用"上:

| 层 | 时机 | 需要 LLM? | 可靠性 |
|------|------|:-----------:|-------------|
| 1. agent 主动维护笔记 | 干活中,通过 `save_carryover` 工具 | 用干活时的 token | 🌟 主力 —— 几乎不丢 |
| 2. 退出 LLM 摘要 | 退出时,≤300字增量摘要 | 是 | 尽力而为(30s 超时) |
| 3. 原始抓取兜底 | 退出时 LLM 不可用/token 用完 | **否** | 💯 100% 保证 |

**会话联动** —— 每次保存都把当前会话文件路径记到 `.pi/.carryover-session`;启动时与笔记一起注入,agent 需要完整历史细节时会指引你用 `/resume`。pi 自带会话是**数据层**,本扩展是**状态层**。

### 命令与文件

| 命令 | 说明 |
|---------|-------------|
| `/carryover` | 查看笔记(截断预览 + 最近会话路径) |
| `/carryover save` | 立即手动生成 LLM 摘要 |
| `/carryover clear` | 清空笔记 |

```
<project>/.pi/CARRYOVER.md        # 笔记(markdown,人可读可改,可进 git)
<project>/.pi/.carryover-session  # 最近会话文件路径(供 /resume 联动)
```

## License

MIT
