# pi-carryover

> Cross-session work carryover for the [pi](https://pi.dev) coding agent — quit today, and tomorrow's fresh `pi` already knows exactly what's unfinished and what's next.

Every project gets a `<cwd>/.pi/CARRYOVER.md` holding **only unfinished work** (TODOs, key decisions, blockers, next steps — completed items are always dropped). It's injected into the system prompt at every session start, per project directory.

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

## License

MIT
