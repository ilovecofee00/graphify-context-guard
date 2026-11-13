# Graphify State-Machine & Exploration Guardrails (Claude Code)

Enforced by `graphify-guard` hooks. All rules apply only in workspaces containing `graphify-out/`.

## 1. Discovery protocol
- **AST first**: `Glob`, `Grep`, shell listings/searches (`ls`, `find`, `grep`, `rg`, `Get-ChildItem`, `Select-String`...) and reads of files under `src/ lib/ app/ tools/ public/` are blocked until a graphify lookup has run in this session (unlock lasts 30 min).
  Always allowed: `README.md`, `ROADMAP.md`, `CLAUDE.md`, `AGENTS.md`, `package.json`, `tsconfig*.json`.
- **Granular queries**: 1-2 concepts per query, always `--budget 800`.
  - Concept / symbol: `graphify explain "<concept>"`
  - Relationship: `graphify path "<A>" "<B>"`
  - Focused search: `graphify query "<focused query>" --budget 800`
  Use the `graphify` CLI on PATH (uv tool install); `python -m graphify` fails with system Python.

## 2. Read rules
- `Read` is clamped to **300 lines** per call (images/PDF/notebooks exempt).
- More than **2 consecutive chunk reads** (≈600 contiguous lines) of one file within 5 min is blocked: locate symbols via graphify (`loc=Lxx`) and read ~50 lines around them.
- Unscoped searches over root `node_modules` are blocked; target `node_modules/<pkg>/...` or pass `--force-vendor`.

## 3. Milestone sync
- Run `graphify update .` once at the end of a milestone/feature, not after every edit.
