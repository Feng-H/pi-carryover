# pi-carryover

[![npm version](https://img.shields.io/npm/v/pi-carryover.svg?color=blue)](https://www.npmjs.com/package/pi-carryover)
[![npm downloads](https://img.shields.io/npm/dt/pi-carryover.svg?color=green)](https://www.npmjs.com/package/pi-carryover)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![pi-package](https://img.shields.io/badge/pi-package-00b57a)](https://pi.dev/packages)

**[English](#how-is-this-different-from-pis-built-in-handoff-and-pi--c) | [简体中文](#中文说明)**

> Cross-session work carryover for the [pi](https://pi.dev) coding agent — quit today, and tomorrow's fresh `pi` already knows exactly what's unfinished and what's next.

Every project gets a `<cwd>/.pi/CARRYOVER.md` holding **only unfinished work** (TODOs, key decisions, blockers, next steps — completed items are always dropped). It's injected into the system prompt at every session start, per project directory.

**v1.1 — Topic compaction**: pi's built-in compaction only fires when the context is about to overflow (volume-driven, arbitrary cut point). pi-carryover watches every input and, when your new question drifts from the recent topic, suggests — or performs, opt-in — compacting at that natural boundary, and archives every compaction summary under `.pi/topics/` for later recall. See [Topic compaction](#topic-compaction-v11--semantic-detection-v112).

**v1.1.2 — Semantic detection**: lexical coverage misjudged Chinese paraphrases (same-topic rewording scored 0 overlap); detection now runs on tiny local embedding models, language-routed (`bge-small-zh` 23MB + `MiniLM` 23MB, ~2ms/message, fully offline after download, auto hf-mirror.com fallback for CN networks). Benchmarked 28/28 on Chinese & English same/diff-topic pairs. **v1.1.3**: enabled by default (installs = full features; models download silently in background on first use, disable via `/carryover embed off`) and bilingual UI (prompts follow your input language).

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

## Topic compaction (v1.1) — semantic detection (v1.1.2)

pi's built-in compaction is **volume-driven**: it fires only when the context is about to overflow, cutting at an arbitrary point mid-work. This extension adds **semantic timing**: it detects when your new question is unrelated to the recent topic and suggests (or performs, opt-in) compaction at that natural boundary — the best possible moment, with the best possible instructions.

- **Embedding-based detection (v1.1.2)** — each message is embedded by a tiny local model and compared (cosine similarity against a rolling window of recent messages). v1.1's pure lexical coverage metric systematically misjudged Chinese paraphrases (same-topic rewording scored 0 overlap); semantic similarity fixes that: benchmarked 28/28 correct across Chinese & English same/diff-topic pairs.
- **Language-routed dual models** — CJK-dominant messages route to `bge-small-zh-v1.5` (23MB), latin-dominant to `all-MiniLM-L6-v2` (23MB). Each language gets a model actually trained for it; total download 46MB, inference ~2ms/message on CPU, fully offline after download. (A single multilingual model tested worse on both languages and was rejected.)
- **Enabled by default (v1.1.3)** — installing the extension means full features: nothing downloads at install time, but on first use the models download silently in the background (progress in the status bar, one notification with an opt-out hint). Disable anytime via `/carryover embed off` or settings.json.
- **Resilient downloader** — HF endpoint is auto-probed (official → hf-mirror.com for CN networks); files download with HTTP Range resume (curl -C - equivalent, 5 retries) because HF CDN connections do drop on flaky networks. transformers.js's own fetcher has no resume — this downloader bypasses it; the runtime never touches the network.
- **Graceful degradation** — models unavailable (no network / skipped)? Lexical detection remains as fallback, but pure-CJK messages skip it (measured 100% false positives); latin-technical chats keep full coverage.
- **Guardrails** — context floor (`minTokens`, default 40k), turn cooldown (default 3), short messages & mid-stream interrupts skipped, failures never touch the input pipeline.
- **suggest mode (default)** — notifies with similarity score + token count; you decide whether to `/compact`.
- **auto mode (opt-in)** — an LLM yes/no double-confirm gates the irreversible compaction; only confirmed topic shifts trigger `ctx.compact()` with instructions to fully preserve the old topic's conclusions/decisions/file state.
- **Compaction = carryover** — every compaction summary is archived to `<project>/.pi/topics/`, capped at 50.

```jsonc
// ~/.pi/agent/settings.json
"carryover": {
  "topicCompact": {
    "mode": "suggest",    // "off" | "suggest" | "auto"
    "minTokens": 40000,
    "cooldownTurns": 3,
    "archive": true,
    "embed": {                       // v1.1.2 semantic detection
      "choice": "auto",             // "auto" (default) | "zh" | "en" | "off"
      "thresholdZh": 0.40,          // optional overrides (bench defaults)
      "thresholdEn": 0.115,
      "endpoint": ""                // optional download source override
    }
  }
}
```

## Commands & files

| Command | Description |
|---------|-------------|
| `/carryover` | View notes (truncated preview + last session path) |
| `/carryover save` | Manually generate an LLM summary now |
| `/carryover clear` | Clear the notes |
| `/carryover topics` | List topic compaction archives |
| `/carryover embed` | Semantic detection status / `on\|auto\|zh\|en\|off\|reset` |

```
<project>/.pi/CARRYOVER.md        # the notes (markdown, human-editable, git-committable)
<project>/.pi/.carryover-session  # last session file path (for /resume linkage)
<project>/.pi/topics/             # topic compaction archives (v1.1, capped at 50)
```

---

## 中文说明

> pi coding agent 的跨会话工作承接扩展 —— 今天退出，明天全新启动的 `pi` 已经知道还有什么没干完、下一步是什么。

每个项目目录维护一份 `<cwd>/.pi/CARRYOVER.md`,**只保留未完成的工作**(待办、关键决策、卡点、下一步 —— 已完成的事项永远会被删掉)。每次会话启动自动注入 system prompt,按项目目录隔离。

**v1.1 新增 —— 话题压缩**：pi 内建 compaction 只在上下文快溢出时才触发(体积驱动、切点随机)。pi-carryover 监听每条输入，当新问题与近期话题无关时，在这个自然边界**提示**(或选开**自动**)压缩旧话题上下文，并把每次压缩摘要归档到 `.pi/topics/` 随时可召回。详见[话题压缩](#话题压缩-v11--语义检测-v112)。

**v1.1.2 —— 语义检测**：词法覆盖率对中文同义改写系统性误判(同话题换个措辞覆盖率就是 0)，改用本地小模型 Embedding 语义相似度检测，按语言路由双小模型(中文 bge-small-zh + 英文 MiniLM 各 23MB，约 2ms/条，下载后完全离线；国内网络自动切 hf-mirror.com)。中英文 28 组样本实测全部判对。**v1.1.3**:默认启用(装了扩展即全功能，首次使用时后台静默下载，`/carryover embed off` 可关闭)+ 提示文案跟随输入语言(中/英双语)。

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

### 话题压缩 (v1.1) —— 语义检测 (v1.1.2)

pi 内建的压缩是**体积驱动**的:只在上下文快溢出时才触发,切点落在干活的任意位置。本扩展补上**语义时机**:检测新问题与近期话题无关时,在这个自然边界提示(或选择自动)压缩 —— 最佳时机、最佳指令。

- **Embedding 语义检测 (v1.1.2)** —— 每条消息用本地小模型向量化,与近期消息窗口算余弦相似度。v1.1 的纯词法覆盖率对中文同义改写系统性误判(同话题措辞一换覆盖率就是 0),语义相似度彻底解决:中英文同/异话题 28 组样本全部判对。
- **按语言路由双小模型** —— 中文为主的消息走 `bge-small-zh-v1.5`(23MB),英文为主走 `all-MiniLM-L6-v2`(23MB)。各用各的最优模型,总下载 46MB,CPU 推理约 2ms/条,下载后完全离线。(实测单一多语言模型两种语言都更差,弃用。)
- **懒引导** —— 安装时不下载任何东西。首次真正需要检测时弹交互选择(双模型/仅中文/仅英文/跳过),选择持久化,下载进度显示在状态栏。
- **抗断下载器** —— 下载源自动探测(官方 → 国内自动切 hf-mirror.com);文件用 HTTP Range 断点续传(curl -C - 等效,重试 5 次),HF CDN 在不稳网络下断连也不怕;绕开 transformers.js 自带的无续传 fetch,运行时零联网。
- **优雅降级** —— 模型不可用(断网/选择跳过)时回落词法检测,但纯中文消息不再信任词法(实测误判率 100%),拉丁词技术对话保持可用。
- **护栏** —— 上下文下限(`minTokens` 默认 40k)、轮数冷却(默认 3)、短消息与流式打断跳过;任何失败不影响输入链路。
- **suggest 模式(默认)** —— 提示相似度 + token 数,由你决定是否 `/compact`。
- **auto 模式(选开)** —— LLM yes/no 二次确认后才执行不可逆的压缩,指令要求完整保留旧话题的结论/决策/文件状态。
- **压缩即沉淀** —— 每次压缩摘要都归档到 `<项目>/.pi/topics/`,上限 50 份。

```jsonc
// ~/.pi/agent/settings.json
"carryover": {
  "topicCompact": {
    "mode": "suggest",    // "off" | "suggest" | "auto"
    "minTokens": 40000,
    "cooldownTurns": 3,
    "archive": true,
    "embed": {                       // v1.1.2 语义检测
      "choice": "auto",             // "auto"(默认) | "zh" | "en" | "off"
      "thresholdZh": 0.40,          // 可选阈值覆盖(默认为基准实测值)
      "thresholdEn": 0.115,
      "endpoint": ""                // 可选下载源覆盖
    }
  }
}
```

### 命令与文件

| 命令 | 说明 |
|---------|-------------|
| `/carryover` | 查看笔记(截断预览 + 最近会话路径) |
| `/carryover save` | 立即手动生成 LLM 摘要 |
| `/carryover clear` | 清空笔记 |
| `/carryover topics` | 查看话题压缩归档 |
| `/carryover embed` | 语义检测状态 / `on\|auto\|zh\|en\|off\|reset` |

```
<project>/.pi/CARRYOVER.md        # 笔记(markdown,人可读可改,可进 git)
<project>/.pi/.carryover-session  # 最近会话文件路径(供 /resume 联动)
<project>/.pi/topics/             # 话题压缩归档(v1.1,上限 50 份)
```

## License

MIT
