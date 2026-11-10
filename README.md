# Graphify Context Guard

> **Deterministic middleware hooks and runtime guardrails designed for Gemini agent harnesses to eliminate context bloat, enforce AST-driven code navigation, auto-clamp unconstrained file reads, and block recursive searches.**

***Note: I made this especially for Gemini models since i work with them in my workspace. Claude approaches vanilla Graphify way better than Gemini, but Graphify Context Guard made it more reliable as far as i tested*** 

---

## Table of Contents

- [Overview](#overview)
- [The Problem: Why AI Agents Waste Context](#the-problem-why-ai-agents-waste-context)
  - [The Context Degradation Trap](#the-context-degradation-trap)
  - [The 3 Anti-Patterns of Coding Agents](#the-3-anti-patterns-of-coding-agents)
- [How Context Guard Delivers 95%+ Context Efficiency](#how-context-guard-delivers-95-context-efficiency)
- [How It Works: Beginner to Advanced Breakdown](#how-it-works-beginner-to-advanced-breakdown)
  - [The Middleware Analogy](#the-middleware-analogy)
  - [Lifecycle Hooks Explained](#lifecycle-hooks-explained)
  - [The State Machine: State 1 vs. State 2](#the-state-machine-state-1-vs-state-2)
  - [The 4 Deterministic Defense Layers](#the-4-deterministic-defense-layers)
- [Architecture & Execution Flow](#architecture--execution-flow)
- [Repository Structure](#repository-structure)
- [Installation & Setup](#installation--setup)
  - [1. Clone Repository](#1-clone-repository)
  - [2. Configure Plugin Manifest](#2-configure-plugin-manifest)
  - [3. Inject Agent Rules](#3-inject-agent-rules)
- [Real-World Walkthrough: Before vs. After](#real-world-walkthrough-before-vs-after)
- [Runtime Rules & Overrides](#runtime-rules--overrides)
- [License](#license)

---

## Overview

When autonomous LLM agents work in large software repositories, their single biggest failure point is **context saturation**. Agents tend to explore blindly: running broad directory listings, recursive greps, and dumping entire 1,000-line source files into the context window just to inspect a 5-line helper function.

**Graphify Context Guard** is an active, deterministic gatekeeper. Operating at the harness lifecycle level via Node.js hooks, it intercepts an agent's tool requests *before* execution. It prevents unconstrained exploration, forces the agent to consult pre-computed Abstract Syntax Tree (AST) knowledge graphs (via Graphify), clamps file reads to an 80-line maximum, and blocks greedy pagination loops.

---

## The Problem: Why AI Agents Waste Context

### The Context Degradation Trap

LLM context windows may be large (up to 1M–2M tokens), but **effective reasoning degrades long before the window is full**:

- **Attention Dilution & "Lost in the Middle":** When an agent floods its context window with thousands of lines of boilerplate code, its ability to recall exact instructions, adhere to guardrails, and detect subtle bugs drops dramatically.
- **Inference Latency & Cost:** Every round-trip with a saturated context window takes significantly longer to process and burns massive token volume.
- **Premature Context Exhaustion:** Long-running tasks fail halfway through because the agent exhausted its working memory on raw directory listings and unparsed code dumps.

### The 3 Anti-Patterns of Coding Agents

```text
❌ Anti-Pattern 1: Turn-1 "Shotgun" Exploration
   Agent lands in project ──► Runs 'ls -R', 'dir /s', or 'grep -rn' ──► Ingests 20,000 tokens of file paths.

❌ Anti-Pattern 2: The Monster File Read
   Agent needs one function ──► Runs 'read_file(lines 1-1200)' ──► Sinks 4,500 tokens on unrelated classes.

❌ Anti-Pattern 3: The Salami-Slicing (Paging) Loophole
   Harness limits reads to 80 lines ──► Agent chains 1-80, 81-160, 161-240... ──► Reassembles the whole file piece by piece.
```

---

## How Context Guard Delivers 95%+ Context Efficiency

Instead of letting the agent "read to find out," Context Guard forces the agent to **"query the map before taking a step."**

| Metric | Traditional Agent (Unconstrained) | Agent with Graphify Context Guard | Savings |
| :--- | :--- | :--- | :--- |
| **Initial Discovery** | 5,000 – 15,000 tokens (`ls`, `find`, recursive `grep`) | ~100 tokens (`graphify query` / `explain`) | **~98% reduction** |
| **Locating a Symbol** | 2,500 – 6,000 tokens (reading full files) | ~150 tokens (AST reports exact offset `loc=L142`) | **~95% reduction** |
| **Code Inspection** | 800 – 1,500 lines dumped into context | Max **80 lines** clamped strictly around target | **~90% reduction** |
| **Vendor Noise** | Scans entire `node_modules` (thousands of lines) | **Blocked** unless specific package targeted | **100% eliminated** |

---

## How It Works: Beginner to Advanced Breakdown

### The Middleware Analogy

Think of Graphify Context Guard like an **airport security checkpoint and GPS navigator combined**:
- **Without Guard:** The agent lands in an unfamiliar airport and runs down every terminal, opens every luggage bag, and asks everyone where Gate B12 is.
- **With Guard:** Security stops the agent at the entrance: *"You cannot wander through the halls. Look at your boarding pass (AST Graph) to get your gate number first. Once you know Gate B12, you can walk directly there."*

### Lifecycle Hooks Explained

Context Guard hooks into two key phases of the agent harness lifecycle:

1. **`PreInvocation` Hook:**
   - Runs *before* the LLM begins reasoning for its turn.
   - Injects an ephemeral status reminder informing the model whether the AST is unlocked and what strict reading limits are active.
2. **`PreToolUse` Hook:**
   - Runs *every time* the LLM calls a tool (`run_command`, `read_file`, `grep_search`, `list_dir`, etc.) *before* the tool actually executes.
   - Has three powers:
     - **Allow:** The tool call passes through unmodified.
     - **Rewrite / Clamp:** Modifies arguments on the fly (e.g., reduces requested lines from 500 down to 80).
     - **Deny (Exit 1):** Immediately aborts execution with an actionable error message teaching the agent what to do instead.

### The State Machine: State 1 vs. State 2

```text
                  ┌────────────────────────────────────────┐
                  │          Session Initialized           │
                  │       (graphify-out/ detected)         │
                  └───────────────────┬────────────────────┘
                                      │
                                      ▼
                  ┌────────────────────────────────────────┐
                  │                STATE 1                 │
                  │          [AST Session Locked]          │
                  │  • Exploration tools strictly blocked  │
                  │  • dir, ls, grep, find -> REJECTED     │
                  └───────────────────┬────────────────────┘
                                      │
                         Agent runs:  │ graphify query <term>
                                      │ graphify explain <symbol>
                                      │ graphify path <A> <B>
                                      ▼
                  ┌────────────────────────────────────────┐
                  │                STATE 2                 │
                  │         [AST Session Unlocked]         │
                  │  • TTL: 30 minutes (temp lock file)    │
                  │  • Targeted reads permitted (<= 80 L)  │
                  │  • Paging monitored (max 2 pages/file) │
                  └────────────────────────────────────────┘
```

1. **State 1 (Locked):** If `graphify-out` exists in the workspace root, the agent is forbidden from running raw discovery commands. It *must* query Graphify first to understand the project architecture.
2. **State Transition:** Running `graphify query`, `graphify explain`, or `graphify path` creates an ephemeral lock in the system temporary directory with a 30-minute Time-To-Live (TTL).
3. **State 2 (Unlocked):** The agent now has structural context. It can inspect files, but all reads remain clamped to a maximum 80-line window.

### The 4 Deterministic Defense Layers

#### 1. Turn-1 AST Gatekeeper
If an agent attempts `Get-ChildItem`, `ls`, `dir`, `tree`, `grep`, or `rg` while the AST lock is active, the hook immediately intercepts the command and returns:
```text
[HOOK BLOCKED]: Directory scanning and raw file search are strictly disabled when 'graphify-out' exists.
Execute a focused 'graphify query', 'explain', or 'path' command FIRST.
```

#### 2. 80-Line Read Clamping
Agents often invoke `read_file` without line limits or ask for 500 lines at once. Context Guard normalizes multiple CLI argument schemas (`start_line`/`end_line`, `offset`/`limit`) and automatically clamps the slice:
- Requested: `StartLine: 1, EndLine: 500`
- Intercepted & Rewritten: `StartLine: 1, EndLine: 80`

#### 3. Sequential Paging Ban (Anti-Salami Slicing)
If an agent attempts to circumvent the 80-line limit by reading chunks consecutively (`1-80`, then `81-160`), Context Guard tracks this behavior in a lightweight sliding-window tracker (`os.tmpdir()`).
On the **3rd consecutive read** within a 5-minute window, the hook kills the tool:
```text
[BLOCKED by context-guard]: Sequential paging detected on 'foo.ts' (3 consecutive reads).
Do not drain context by reading entire files in chunks.
Action: Use Graphify to locate the exact symbol line (loc=Lxx), then read strictly 30-50 lines around it.
```

#### 4. Vendor Noise Isolation
Unscoped search commands targeting or passing through `node_modules` are blocked unless explicitly scoped to a specific subpackage (`node_modules/<pkg>`) or flagged with `--force-vendor`.

---

## Architecture & Execution Flow

```text
                  Agent Invocation
                         │
                         ▼
               [PreInvocation Hook]
                         │
             Injects Ephemeral Banner
             "Context Guard Active..."
                         │
                         ▼
                Agent Requests Tool
                         │
                         ▼
                 [PreToolUse Hook]
                         │
       ┌─────────────────┴─────────────────┐
       ▼                                   ▼
 [Is read_file?]                    [Is run_command / search?]
       │                                   │
       ├── > 80 Lines?                     ├── Hits 'node_modules'?
       │     └─► AUTO-CLAMP down to 80     │     └─► BLOCKED (unless scoped)
       │                                   │
       └── 3rd Consecutive Chunk?          └── Exploration ('ls', 'grep')?
             └─► BLOCKED: Exit 1                 ├── AST Locked?  ──► BLOCKED: Exit 1
                 "Use AST loc=Lxx"               └── AST Unlocked ──► ALLOWED
```

---

## Repository Structure

```text
.
├── rules/
│   └── AGENTS.md            # System prompt rules informing the model of guardrail constraints
├── scripts/
│   └── context-guard.cjs    # Deterministic Node.js hook engine (AST gating, clamping, tracker)
├── hooks.json               # Antigravity / Gemini CLI lifecycle matcher definitions
├── README.md                # Project documentation and guide
└── .gitignore               # Standard ignore patterns
```

---

## Installation & Setup

### 1. Clone Repository

Clone this repository into your agent's plugin directory or your workspace:

```bash
git clone https://github.com/ilovecofee00/graphify-context-guard.git
```

### 2. Configure Plugin Manifest

Add `hooks.json` to your agent configuration (e.g., `~/.gemini/config/plugins/graphify-guard/hooks.json` or your project root):

```json
{
  "graphify-context-guard": {
    "enabled": true,
    "PreToolUse": [
      {
        "matcher": "run_command|Bash|shell|read_file|Read|view_file|list_dir|find_by_name|grep_search|glob|Grep|Glob|LS",
        "hooks": [
          {
            "type": "command",
            "command": "node scripts/context-guard.cjs pre-tool",
            "timeout": 5
          }
        ]
      }
    ],
    "PreInvocation": [
      {
        "type": "command",
        "command": "node scripts/context-guard.cjs pre-invocation",
        "timeout": 5
      }
    ]
  }
}
```

### 3. Inject Agent Rules

Append the contents of [`rules/AGENTS.md`](rules/AGENTS.md) into your global system prompt, workspace instructions (`GEMINI.md`, `AGENTS.md`), or plugin prompt configuration. This ensures the model proactively knows the guardrails exist before triggering them.

---

## Real-World Walkthrough: Before vs. After

### ❌ Scenario 1: Without Context Guard (Blind Dump)
1. **Agent:** `"I need to find where user authentication tokens are signed."`
2. **Agent:** Runs `grep -rn "jwt.sign" .` ➔ Returns 180 results across `node_modules`, `build`, and `src` (3,200 tokens).
3. **Agent:** Runs `read_file("src/auth/token-service.ts", 1, 650)` ➔ Ingests 650 lines (2,800 tokens).
4. **Agent:** Runs `read_file("src/auth/token-service.ts", 651, 1300)` ➔ Ingests another 650 lines (2,800 tokens).
5. **Outcome:** Over **8,800 tokens consumed** in 3 turns. The context buffer is now heavily diluted.

### ✅ Scenario 2: With Context Guard (AST Navigation)
1. **Agent:** `"I need to find where user authentication tokens are signed."`
2. **Agent:** Attempts `grep -rn "jwt.sign" .` ➔ **BLOCKED by Context Guard.**
3. **Agent:** Follows error guidance and runs:
   ```bash
   python -m graphify explain "signToken"
   ```
4. **Graphify:** Returns node metadata in 65 tokens:
   ```text
   Symbol: signToken | File: src/auth/token-service.ts | loc=L142 | outgoing: [signJWT, cryptoKey]
   ```
5. **Agent:** Reads targeted window:
   ```json
   { "Path": "src/auth/token-service.ts", "StartLine": 135, "EndLine": 175 }
   ```
6. **Outcome:** Total tokens consumed: **~220 tokens**. Code discovered with surgical precision, leaving 98% of the context window fresh for complex reasoning.

---

## Runtime Rules & Overrides

| Action | Guard Behavior | Reason | How to Bypass / Override |
| :--- | :--- | :--- | :--- |
| **Unscoped search in `node_modules`** | **Blocked** | Prevents dumping third-party dependency code into context | Append `--force-vendor` or specify package (`node_modules/<pkg>`) |
| **Raw file read > 80 lines** | **Auto-Clamped** | Prevents attention dilution and unanchored monster reads | Locate exact symbol via `graphify explain` and read a 40–60 line slice |
| **Sequential paging > 2 consecutive chunks** | **Blocked** | Prevents salami-slicing entire files into context | Use AST symbol offsets (`loc=Lxx`) instead of linear pagination |
| **Turn-1 broad scans (`dir`, `ls`, `grep`)** | **Blocked** | Enforces structural AST navigation before raw exploration | Run `graphify query`, `explain`, or `path` first to unlock session |

---

## License

MIT © Kemal Arda Aytaç
