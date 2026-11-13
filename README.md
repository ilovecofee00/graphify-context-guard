# graphify-guard

> **A Claude Code plugin that makes Claude query a [Graphify](https://github.com/safishamsi/graphify) knowledge graph before it explores a codebase, caps file reads at 300 lines and blocks page-by-page dumps of whole files. It does this with two small hooks that stay out of the model's way.**

**Claude Code native from v1.0.0.** The earliest version of this repo targeted Gemini / Antigravity harnesses (`PreInvocation`, `read_file`, `run_command`). That version is gone. v1.0.0 uses Claude Code's plugin format, Claude Code's hook protocol and Claude Code's tool names (`Read`, `Grep`, `Glob`, `Bash`, `PowerShell`), and it won't work in other harnesses as-is. The old version is still in git history (`ddf3f1d`) if you need it. That version is pretty much premature but not completely useless. You can make it work way better trough trial and error.**

---

## Contents

- [What it does](#what-it-does)
- [Context efficiency without interrupting the model](#context-efficiency-without-interrupting-the-model)
- [Measured numbers](#measured-numbers)
- [How it works](#how-it-works)
- [Installation](#installation)
- [Rules reference](#rules-reference)
- [Limitations](#limitations)
- [Testing](#testing)
- [Repository structure](#repository-structure)
- [License](#license)

---

## What it does

Every read/exploration rule applies **only in workspaces that contain `graphify-out/`**. Everywhere else the plugin does nothing, except for the `node_modules` rule.

| # | Rule | Trigger | Result |
|---|---|---|---|
| 1 | **Graphify first** | `Grep`, `Glob`, a shell step whose command is a lister (`ls`, `dir`, `find`, `fd`, `tree`, `Get-ChildItem`), `git ls-files / ls-tree / grep`, a file search (`grep`, `rg`, `Select-String`, `findstr`) as the first stage of a pipeline, or reading files under `src/ lib/ app/ tools/ public/`, all before any `graphify query / explain / path` in this session | Denied, with a one-line instruction to run a graphify lookup. The unlock lasts 30 min per session. A search fed by a pipe (`npm test \| grep fail`) is an output filter and is allowed. |
| 2 | **300-line read window** | `Read` with no `limit` or `limit > 300` | Input rewritten to `limit: 300` (offset kept). The call goes ahead. |
| 2b | Shell read sizing | `cat`, `Get-Content`, `head`, `tail`, `sed -n`, `bat`, `nl`, `more`, `less` on a source file that would print > 300 lines (pipe limiters like `\| head -n 40`, `\| wc -l` are taken into account) | Denied |
| 3 | **Sequential paging ban** | A 3rd back-to-back chunk of the same file (each chunk starts within ±5 lines of where the last one ended, within 5 min). `Read` and ranged shell reads share the counter. | Denied, pointing to `graphify explain` (`loc=Lxx`) |
| 4 | **Vendor noise** | A search tool given root `node_modules` (or `node_modules/*`) as a path, or a lister of it that feeds a search (`gci node_modules \| sls`, `find node_modules -exec grep`). Applies in all projects. | Denied unless scoped to `node_modules/<pkg>/…` or `--force-vendor` is passed |

Always readable: `README.md`, `ROADMAP.md`, `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `package.json`, `tsconfig*.json`, images, PDFs and notebooks. Images, PDFs and notebooks are never clamped.

---

## Context efficiency without interrupting the model

A guardrail that saves tokens but keeps cutting into the model's reasoning hasn't really gained anything. graphify-guard is built to add as little as possible to the conversation and never to halt a turn. These are the properties, all checkable in [`scripts/context-guard.cjs`](scripts/context-guard.cjs):

**1. It only runs at tool-call boundaries.** The hooks are `SessionStart` and `PreToolUse`. There is no `UserPromptSubmit`, `Stop` or per-turn hook, so nothing gets injected between your prompt and the model's reasoning, and the model's thinking is never read or modified.

**2. Exactly what text reaches the model:**

| Event | Text added to Claude's context | When |
|---|---|---|
| Allowed call (most calls) | **0 chars** (no stdout) | every pass-through |
| Read clamp | **0 chars**: the reason goes to Claude Code's debug log only (`permissionDecisionReason` on `"allow"`). Claude just gets a 300-line result. | `Read` over 300 lines |
| Deny | **122–227 chars** in place of the tool result | blocked call |
| Session rules | **501 chars / 79 words** | each `SessionStart` (startup, resume, clear, compact), graph projects only |

**3. It never stops the turn.** The script always exits `0`. It never uses exit code `2` (blocking error), `"ask"` (permission prompt) or `"defer"` (end turn). A deny goes back to Claude as a normal tool result with an instruction, so Claude reads it and continues in the same turn, usually with the suggested `graphify` command.

**4. The clamp costs no extra round-trip.** An oversized `Read` isn't rejected and retried. It's rewritten (`"allow"` + `updatedInput`) and runs in the same call.

**5. It fails open.** Empty or invalid input → pass-through. If the script crashes or times out (5 s limit), Claude Code treats that as a non-blocking error and the tool call goes ahead. A bug in the guard can't stall a session.

**6. Low overhead.** The median hook time is ~24–26 ms. Most of that is Node.js process startup (21.6 ms for `node -e 0` on the same machine), so the guard's own logic adds about 3 ms per call.

---

## Measured numbers

Environment: Windows 11, Node.js v26.13.0, 40 runs per case. The file samples are the largest source files of Graphify 0.9.106 itself.

### Hook latency and output size

| Case | Median | p95 | stdout |
|---|---|---|---|
| Baseline `node -e 0` | 21.6 ms | — | — |
| Pass-through (`Bash: git status`) | 24.2 ms | 25.8 ms | 0 B |
| Deny (`Grep`, session locked) | 24.4 ms | 26.9 ms | 346 B (reason: 227 chars) |
| Read clamp | 25.6 ms | 27.3 ms | 290 B (debug log only) |
| SessionStart | 24.1 ms | 25.6 ms | 584 B (context: 501 chars) |

The other deny reasons are 161 chars (paging) and 122 chars (`node_modules`).

### What the 300-line clamp saves on a single Read

Claude Code's `Read` already stops at 2,000 lines by default, so that is the fair baseline. A guard-free Read doesn't load the whole file.

| File | Total lines | First 2,000 lines | First 300 lines (clamped) | Reduction |
|---|---|---|---|---|
| `extractors/engine.py` | 12,185 | 89,182 B | 13,008 B | 85% |
| `extract.py` | 13,518 | 95,648 B | 14,030 B | 85% |
| `cli.py` | 6,148 | 86,937 B | 13,154 B | 84% |
| `extractors/resolution.py` | 5,067 | 91,141 B | 13,698 B | 84% |
| `llm.py` | 4,040 | 92,985 B | 13,502 B | 85% |

At a rough 4 bytes per token, that is about 22–24k tokens down to about 3.3–3.5k for one unbounded read of a large file. Across Graphify's 98 Python files, 62 are over 300 lines, so they're affected by the clamp. Files at or under 300 lines are unaffected.

### What these numbers don't show

- **Savings from graphify lookups** depend on Graphify's own output. The instruction uses `--budget 800`, which caps the lookup result. I haven't benchmarked whole agent sessions (tokens per task, task success) with and without the guard, so this README makes no claim about end-to-end savings.
- **A deny costs one tool round-trip.** The model's call is rejected and it makes another (typically the graphify lookup). The guard is a net win only when that lookup replaces broader exploration.

---

## How it works

```text
Session start ──► SessionStart hook ──► graphify-out/ ? ──no──► (silent)
                                             │yes
                                             ▼
                                inject 501-char rule summary

Claude calls Read / Grep / Glob / Bash / PowerShell
        │
        ▼
 PreToolUse hook (node, ~25 ms)
        │
        ├─ Bash/PS runs `graphify query|explain|path` ──► write session lock (30 min) ──► pass
        ├─ search over root node_modules ───────────────────────────────────────────► deny
        ├─ no graphify-out/ ─────────────────────────────────────────────────────────► pass
        ├─ locked + discovery / source read ──────────────────────────────────────────► deny
        ├─ shell read > 300 lines ─────────────────────────────────────────────────────► deny
        ├─ 3rd sequential chunk of same file ──────────────────────────────────────────► deny
        ├─ Read limit missing or > 300 ──────────────────────────► allow + updatedInput (limit 300)
        └─ otherwise ─────────────────────────────────────────────────────────────────► pass
```

**State** lives in `os.tmpdir()`, keyed by `md5(workspace path + session_id)`:
- `.graphify-guard-<key>.lock`: the unlock marker. Its mtime is checked against a 30-min TTL.
- `.graphify-guard-reads-<key>.json`: per-file paging tracker, reset after 5 min idle.

Because the key includes `session_id`, parallel Claude Code sessions in the same repo don't unlock each other.

---

## Installation

Requirements: Claude Code, Node.js ≥ 18 on PATH, and the [Graphify](https://github.com/safishamsi/graphify) CLI (`uv tool install graphifyy`) with a `graphify-out/` built in your project.

### Option A: install from GitHub (recommended)

The repo is also a single-plugin marketplace (`.claude-plugin/marketplace.json`). In Claude Code, run:

```text
/plugin marketplace add ilovecofee00/graphify-context-guard
/plugin install graphify-guard@graphify-context-guard
```

Restart Claude Code (or run `/reload-plugins`) to load the hooks. To get updates later, run `/plugin marketplace update graphify-context-guard`. To pin a release instead of following `main`, add the tag, for example `/plugin marketplace add ilovecofee00/graphify-context-guard#v1.0.1`.

### Option B: try it for one session without installing

```bash
git clone https://github.com/ilovecofee00/graphify-context-guard.git
claude --plugin-dir ./graphify-context-guard
```

### Optional: model-facing rules

The SessionStart hook already tells Claude the rules. If you also want them in your instructions permanently, paste [`rules/AGENTS.md`](rules/AGENTS.md) into your project or user `CLAUDE.md`. That way Claude follows the rules up front and runs into fewer denies.

---

## Rules reference

| Situation | Behavior | What Claude should do instead |
|---|---|---|
| Discovery before any graphify lookup | Deny | `graphify query "<1-2 concepts>" --budget 800`, `graphify explain "<symbol>"`, `graphify path "<A>" "<B>"` |
| `Read` without limit / > 300 lines | Clamp to 300 | Ask for specific ranges |
| Shell dump of a source file | Deny | `Read` with offset/limit, or `head -n ≤300` |
| 3rd consecutive chunk of one file | Deny | `graphify explain` → read ~50 lines around `loc=Lxx` |
| Search over root `node_modules` | Deny | `node_modules/<pkg>/…` or `--force-vendor` |
| Milestone finished | n/a | `graphify update .` (once, not after every edit) |

---

## Limitations

- **Pattern-based, not a sandbox.** Commands are matched with regexes. An agent can get around the guard on purpose (for example `python -c "print(open(...).read())"` or `awk`). The goal is to steer the default behavior, not to enforce security.
- **How shell commands are judged:** the guard splits a command at `&&`, `||`, `;`, `|` and newlines (respecting quotes, and also looking inside `$(...)`), then looks at each step's *command name* and *path arguments*. Words inside strings, commit messages or file paths don't trigger it. It's still a heuristic, not a shell parser: unusual syntax (PowerShell backtick escapes, `eval`, aliases you defined yourself) may be judged wrongly in either direction.
- **Fixed source folders:** "source" means a path containing `src/`, `lib/`, `app/`, `tools/` or `public/`. Files elsewhere aren't gated, only clamped.
- **Auto-approval:** a clamped `Read` returns `"allow"`, which skips the permission prompt for that Read. Your deny rules are still evaluated. Read is a read-only tool.
- **Tested on Windows 11 only.** The script has no platform-specific code, but it hasn't been run on macOS or Linux.

---

## Testing

The tests use Node's built-in test runner and have zero dependencies. They spawn the real hook with Claude Code-shaped JSON in throwaway workspaces.

```bash
npm test
```

37 tests in 11 groups: SessionStart (graph / no graph), the Graphify-first gate (Grep, Glob, shell discovery, source vs. doc vs. binary reads), unlocking (query/explain/path, session scoping, 30-min expiry), the Read clamp, the paging ban (per file, reset on jumps, shared with `sed -n`), shell read sizing (whole-file dumps, > 300 lines, pipe limiters, `sed -i` ignored), `node_modules` scoping, non-graph projects, invalid input, and false-positive regressions (keywords inside strings, commit messages and paths; pipe filters; quoted separators), alongside checks that real discovery and vendor searches are still caught.

---

## Repository structure

```text
.
├── .claude-plugin/
│   ├── plugin.json            # Claude Code plugin manifest
│   └── marketplace.json       # Makes the repo installable via /plugin marketplace add
├── hooks/
│   └── hooks.json             # SessionStart + PreToolUse (Bash|PowerShell|Read|Grep|Glob)
├── scripts/
│   └── context-guard.cjs      # The hook engine (single file, Node built-ins only)
├── rules/
│   └── AGENTS.md              # Optional rules text for CLAUDE.md
├── tests/
│   └── context-guard.test.cjs # node:test suite
├── package.json
└── LICENSE
```

---

## License

MIT © Kemal Arda Aytaç
