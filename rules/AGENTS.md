# Global Graphify State-Machine & Codebase Exploration Guardrails

Mandatory state-machine exploration rules enforced across all workspaces via `context-guard`:

## 1. State-Machine Discovery Protocol
- **Assume Graphify Present**: Assume `graphify-out/graph.json` is present by default. NEVER execute `Test-Path graphify-out` or conditional existence checks. Fall back only if the Python module explicitly reports a missing graph.
- **Turn-1 Gatekeeper**: Batching directory scans (`Get-ChildItem`, `dir`, `ls`, `tree`, `find`) or raw file searches (`grep`, `rg`, `Select-String`) before running Graphify on Turn 1 is strictly forbidden and blocked by middleware hooks. Reading top-level specification files (`ROADMAP.md`, `README.md`, `package.json`) is the only exception.
- **Granular Querying (1-2 Concepts Max)**: Multi-concept "bag-of-words" queries are strictly forbidden. Target 1-2 architectural symbols or concepts per query. Always include `--budget 800` (or `--context call`) to prevent hub-node token bloat. If results are truncated, narrow with `context_filter` or `get_node`.
- **AST Lookup & Inspection**:
  - Concept / File / Symbol lookup:
    - Windows: `.\.venv\Scripts\python.exe -m graphify explain "<concept>"`
    - POSIX: `./.venv/bin/python -m graphify explain "<concept>"`
  - Component relationships: `python -m graphify path "<A>" "<B>"`
  - Focused semantic queries: `python -m graphify query "<focused_query>" --budget 800`
  - Windows Terminal Sandbox: Always invoke `.venv` Python / Graphify commands with `BypassSandbox: true` to prevent virtualenv socket hangs.

## 2. Targeted Read & Search Rules
- **AST-First Reads**: Read source files only after target symbols and exact line offsets (`loc=Lxx`) are identified through AST graph lookup.
- **Strict Window Clamping**: Direct `read_file` calls are strictly capped and auto-clamped at **80 lines** per request.
- **Sequential Paging Ban**: Reading a file in consecutive sliding chunks (e.g., lines 1–80, 81–160, 161–240) is blocked after **2 consecutive pages**. Locate exact symbols via Graphify instead of paging through files.
- **Vendor & Root Search Protection**: Specific package subdirectories (e.g., `node_modules/<pkg>/...`) are permitted. Unconstrained root `node_modules` dumps are blocked unless `--force-vendor` is explicitly passed.

## 3. Milestone Synchronization
- Synchronize the knowledge graph once at the completion of a milestone or feature via `python -m graphify update .` to avoid intermediate edit noise.