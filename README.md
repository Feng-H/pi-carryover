# pi-carryover

> Cross-session work carryover for the [pi](https://pi.dev) coding agent — "pick up where I left off", automatically.

Every project gets a `<cwd>/.pi/CARRYOVER.md` with **only the unfinished work**: TODOs, key decisions, blockers, next steps. It's injected into the system prompt at session start, so a fresh `pi` knows exactly what to continue — no `-c`, no session picking, no re-explaining.

```
$ pi
> 以下是上次会话结束时的工作状态。开始新任务前请先阅读，并据此接续工作：
> ## 待办
> - 重构 auth 模块（进行到一半，UserService 已拆）
> ...
```

## Install

```bash
pi install git:github.com/Feng-H/pi-carryover
```

Zero config. Works immediately in every project directory.

## How it works

**Three-tier reliability** — never bet everything on "LLM available at exit time":

| Tier | When | LLM needed? | Reliability |
|------|------|:-----------:|-------------|
| 1. Agent-maintained notes | During work, via the `save_carryover` tool (uses your working tokens) | already paid | 🌟 Primary — nearly lossless |
| 2. LLM exit summary | On quit, ≤300-word incremental summary (30s timeout, skips silently) | yes | Best effort |
| 3. Raw fallback | On quit when LLM is unavailable / out of tokens / timeout | **no** | 💯 100% guaranteed |

The summary keeps only: unfinished work / TODOs / key decisions / blockers / next steps. Completed items are always dropped.

**Session linkage with pi's built-in history** — pi's own mechanism is the *data layer* (full conversation trees, always saved); this extension is the *state layer* (always knows what's next). On every save it records the session file path to `.pi/.carryover-session`; on startup it's injected alongside the notes, so the agent can point you to `/resume` when full history details are needed.

```
pi built-in sessions  =  database (nothing is ever lost)
pi-carryover          =  sticky note (always knows what to do next)
```

## Commands

| Command | Description |
|---------|-------------|
| `/carryover` | View current notes (truncated preview + last session path) |
| `/carryover save` | Manually generate an LLM summary now |
| `/carryover clear` | Clear the notes |

The agent also gets a `save_carryover` **tool** and is instructed to call it at milestones, when TODOs change, or before exit — that's tier 1, the most reliable path.

## Files created

```
<project>/.pi/CARRYOVER.md        # the carryover notes (markdown, human-editable, git-committable)
<project>/.pi/.carryover-session  # last session file path (for /resume linkage)
```

Both are per-project (`cwd`-scoped) and safe to commit — share project state with your team via git.

## Design notes

- **Why not just `pi -c`?** `-c` replays the *last* conversation line with full history (token-heavy, and only that one line). Carryover works on *any* new session, accumulates state across many sessions per project, and costs ~300 tokens.
- **Why no conflict with pi's context management?** Compaction is intra-session; sessions are manual replay. This extension touches neither — it only appends to the system prompt via the documented `before_agent_start` API.

## License

MIT
