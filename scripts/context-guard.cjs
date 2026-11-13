/* eslint-disable @typescript-eslint/no-require-imports */
// graphify-guard v1.0.0 — Claude Code native
// Hook protocol: stdin JSON {session_id, cwd, hook_event_name, tool_name, tool_input}
//   pass-through  -> exit 0, no stdout (normal permission flow continues)
//   deny          -> exit 0, hookSpecificOutput.permissionDecision = "deny"
//   rewrite input -> exit 0, permissionDecision "allow" + updatedInput (Read only: read-only tool)
// All read/exploration rules apply ONLY in workspaces that contain graphify-out/.
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const LOCK_TTL_MS = 30 * 60 * 1000; // graphify "unlock" lasts 30 min per session
const PAGING_TTL_MS = 5 * 60 * 1000; // sliding-window tracker resets after 5 min idle
const MAX_WINDOW_LINES = 300; // max lines per Read in graph projects
const MAX_CONSECUTIVE_PAGES = 2; // 2 x 300 = 600 contiguous lines, then use graphify

const BLOCK_MSG =
  "[graphify-guard] This workspace has graphify-out/. Run a focused `graphify query \"<1-2 concepts>\" --budget 800`, " +
  "`graphify explain \"<symbol>\"` or `graphify path \"<A>\" \"<B>\"` FIRST, then explore/read with the returned locations.";

const mode = process.argv.includes("session-start") ? "session-start" : "pre-tool";
const payload = readPayload();
const workspaceRoot = payload.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
const sessionId = String(payload.session_id || "nosession");
const hasGraph = fs.existsSync(path.join(workspaceRoot, "graphify-out"));


// ------------------------------------------------------------------ helpers
function readPayload() {
  try {
    const raw = fs.readFileSync(0, "utf-8");
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}
function key() {
  const norm = path.resolve(workspaceRoot).replace(/\\/g, "/").toLowerCase();
  return crypto.createHash("md5").update(norm + "|" + sessionId).digest("hex").slice(0, 12);
}
const lockPath = () => path.join(os.tmpdir(), `.graphify-guard-${key()}.lock`);
const trackerPath = () => path.join(os.tmpdir(), `.graphify-guard-reads-${key()}.json`);

function isUnlocked() {
  try {
    const st = fs.statSync(lockPath());
    if (Date.now() - st.mtimeMs > LOCK_TTL_MS) {
      fs.unlinkSync(lockPath());
      return false;
    }
    return true;
  } catch {
    return false;
  }
}
function unlock() {
  try {
    fs.writeFileSync(lockPath(), new Date().toISOString(), "utf-8");
  } catch {}
}
function loadHistory() {
  try {
    return JSON.parse(fs.readFileSync(trackerPath(), "utf-8"));
  } catch {
    return {};
  }
}
function saveHistory(h) {
  try {
    fs.writeFileSync(trackerPath(), JSON.stringify(h), "utf-8");
  } catch {}
}
function pass() {
  process.exit(0);
}
function emit(obj) {
  process.stdout.write(JSON.stringify(obj));
  process.exit(0);
}
function deny(reason) {
  emit({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  });
}

function normPath(p) {
  const abs = path.isAbsolute(p) ? p : path.resolve(workspaceRoot, p);
  return abs.replace(/\\/g, "/").toLowerCase();
}
const SOURCE_DIR_RE = /(?:^|\/)(?:src|lib|app|tools|public)\//;
const DOC_RE = /(?:roadmap\.md|readme\.md|claude\.md|agents\.md|gemini\.md|package\.json|tsconfig[^/]*\.json)$/i;

// Sliding-window tracker shared by Read and ranged shell reads. Returns consecutive chunk count.
function trackPaging(norm, start, end) {
  const history = loadHistory();
  const now = Date.now();
  const rec = history[norm] || { count: 0, lastEnd: 0, ts: 0 };
  const sequential = now - rec.ts < PAGING_TTL_MS && Math.abs(start - (rec.lastEnd + 1)) <= 5;
  rec.count = sequential ? rec.count + 1 : 1;
  rec.lastEnd = end;
  rec.ts = now;
  history[norm] = rec;
  saveHistory(history);
  return rec.count;
}
function pagingMsg(norm, count) {
  return (
    `[graphify-guard] Sequential paging on '${path.basename(norm)}' (${count} consecutive chunks). ` +
    "Locate the symbol with `graphify explain \"<symbol>\"` (loc=Lxx) and read ~50 lines around it."
  );
}

// ------------------------------------------------- shell file-read detection
const READERS = new Set(["cat", "type", "gc", "get-content", "more", "less", "bat", "nl", "head", "tail", "sed"]);
const FILTERS = new Set(["wc", "measure-object", "grep", "rg", "findstr", "select-string", "sls"]);

function stripNoise(cmd) {
  return cmd
    .replace(/@(['"])[\s\S]*?\r?\n\1@/g, " ") // PowerShell here-strings
    .replace(/<<-?\s*(['"]?)(\w+)\1([^\n]*)\n[\s\S]*?\n\s*\2\s*(?=\n|$)/g, " $3") // heredoc bodies
    .replace(/\d?>>?\s*(?:"[^"]*"|'[^']*'|[^\s;|&]+)/g, " "); // redirection targets (writes, 2>&1)
}
function tokenize(s) {
  return (s.match(/"[^"]*"|'[^']*'|\S+/g) || []).map((t) => t.replace(/^["']|["']$/g, ""));
}
function num(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}
// Returns {start, end} (end may be Infinity) for a reader stage, "edit" for sed -i, null if not a reader.
function readerRange(cmd, toks, raw) {
  const flag = (re) => {
    for (let i = 0; i < toks.length; i++) {
      const m = re.exec(toks[i]);
      if (m) return num(m[1] !== undefined && m[1] !== "" ? m[1] : toks[i + 1]);
    }
    return null;
  };
  if (cmd === "head" || cmd === "tail") {
    if (toks.some((t) => /^-c/.test(t))) return { start: 1, end: 1 };
    if (cmd === "tail" && toks.some((t, i) => /^\+\d+$/.test(t) && /^-n$/.test(toks[i - 1] || ""))) return { start: 1, end: Infinity };
    const n = flag(/^-n(\d*)$/) ?? flag(/^--lines=(\d+)$/) ?? flag(/^-(\d+)$/) ?? 10;
    return cmd === "head" ? { start: 1, end: n } : { start: null, end: n };
  }
  if (cmd === "sed") {
    if (toks.some((t) => /^-i/.test(t) || t === "--in-place")) return "edit";
    if (!toks.includes("-n")) return { start: 1, end: Infinity }; // plain sed prints the whole file
    const script = toks.find((t) => /^\d+(?:,(?:\d+|\$))?p$/.test(t) || /\$p$/.test(t));
    if (!script) return { start: 1, end: 1 }; // pattern-only script ~ a search, not a dump
    const m = /^(\d+)(?:,(\d+|\$))?p$/.exec(script);
    if (!m) return { start: 1, end: Infinity };
    const a = num(m[1]);
    const b = m[2] === undefined ? a : m[2] === "$" ? Infinity : num(m[2]);
    return { start: a, end: b };
  }
  // cat/type/gc/Get-Content/more/less/bat/nl
  const idx = /\[\s*(\d+)\s*\.\.\s*(\d+)\s*\]/.exec(raw);
  if (idx) return { start: num(idx[1]) + 1, end: num(idx[2]) + 1 };
  const head = flag(/^-(?:totalcount|head|first)(?::(\d+))?$/i);
  if (head !== null) return { start: 1, end: head };
  const tail = flag(/^-(?:tail|last)(?::(\d+))?$/i);
  if (tail !== null) return { start: null, end: tail };
  return { start: 1, end: Infinity };
}
function limiterBound(toks) {
  const c = (toks[0] || "").toLowerCase();
  if (FILTERS.has(c)) return 0;
  if (c === "head" || c === "tail") {
    const r = readerRange(c, toks, "");
    return r.end;
  }
  if (c === "select-object" || c === "select") {
    for (let i = 0; i < toks.length; i++) {
      if (/^-(?:first|last)$/i.test(toks[i])) return num(toks[i + 1]) ?? Infinity;
      if (/^-index$/i.test(toks[i])) return 1;
    }
  }
  return Infinity;
}
// ---------------------------------------------- command structure (quote-aware)
// Splits a command into segments (&&, ||, ;, newline) of pipeline stages (|), ignoring
// separators inside quotes. $(...) and `...` bodies are scanned as extra segments.
// Backslash escapes inside double quotes only for Bash (PowerShell paths end in "C:\dir\").
function splitCommand(cmd, bashEscapes) {
  const s = stripNoise(cmd);
  const segs = [];
  let stages = [];
  let cur = "";
  let q = null;
  const endStage = () => {
    stages.push(cur);
    cur = "";
  };
  const endSeg = () => {
    endStage();
    segs.push(stages);
    stages = [];
  };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      cur += ch;
      if (bashEscapes && q === '"' && ch === "\\" && i + 1 < s.length) cur += s[++i];
      else if (ch === q) q = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      q = ch;
      cur += ch;
    } else if ((ch === "&" || ch === "|") && s[i + 1] === ch) {
      endSeg();
      i++;
    } else if (ch === ";" || ch === "\n" || ch === "\r") endSeg();
    else if (ch === "|") endStage();
    else cur += ch;
  }
  endSeg();
  const subs = [];
  for (const m of s.matchAll(/\$\(([^()]*)\)|`([^`]*)`/g)) {
    if (m[1] !== undefined || bashEscapes) subs.push(...splitCommand(m[1] ?? m[2], bashEscapes));
  }
  return segs
    .map((st) => st.map((x) => x.trim()).filter(Boolean))
    .filter((st) => st.length)
    .concat(subs);
}
// Command name (lowercased, path/.exe stripped) and its argument tokens for one stage.
const PREFIXES = /^(?:sudo|&|\.|command|exec|time|nohup|xargs|env)$/i;
function stageCommand(stage) {
  const toks = tokenize(stage.replace(/^[({\s]+/, "").replace(/\[[^\]]*\]/g, " "));
  while (toks.length && (/^\w+=/.test(toks[0]) || PREFIXES.test(toks[0]))) toks.shift();
  const name = (toks[0] || "").replace(/\\/g, "/").split("/").pop().replace(/\.exe$/i, "").toLowerCase();
  return { name, args: toks.slice(1) };
}

const LISTERS = new Set(["ls", "dir", "find", "tree", "gci", "get-childitem", "fd"]);
const SEARCHERS = new Set(["grep", "egrep", "fgrep", "rg", "ripgrep", "findstr", "select-string", "sls"]);
const GIT_DISCOVERY = new Set(["ls-files", "ls-tree", "grep"]);
// Flags whose value is the next token (grep + rg); their value is never a path.
const VALUE_FLAGS = new Set([
  "-e", "-f", "-A", "-B", "-C", "-m", "-d", "-D", "--include", "--exclude", "--exclude-dir",
  "-g", "--glob", "--iglob", "-t", "--type", "-T", "--type-not", "-M", "--max-depth", "-j", "-r", "--replace",
  "--regexp", "--file",
]);

function isGraphifyLookup({ name, args }) {
  let rest = null;
  if (name === "graphify") rest = args;
  else if (/^(?:python3?|py)$/.test(name) && args[0] === "-m" && args[1] === "graphify") rest = args.slice(2);
  else if (name === "uvx" && args[0] === "graphify") rest = args.slice(1);
  return !!rest && /^(?:query|explain|path)$/i.test(rest[0] || "");
}
function isDiscoveryStage({ name, args }, stageIndex) {
  if (LISTERS.has(name)) return true;
  if (name === "git") return GIT_DISCOVERY.has((args[0] || "").toLowerCase());
  // a search tool fed by a pipe filters output; only a first-stage search scans files
  return SEARCHERS.has(name) && stageIndex === 0;
}
// Positional path arguments of a search/list command (patterns and flag values excluded).
function pathArgs({ name, args }) {
  if (name === "select-string" || name === "sls") {
    const paths = [];
    const pos = [];
    let namedPattern = false;
    for (let i = 0; i < args.length; i++) {
      const a = args[i].toLowerCase();
      if (a === "-path" || a === "-literalpath") paths.push(...String(args[++i] || "").split(","));
      else if (a === "-pattern") (namedPattern = true), i++;
      else if (/^-(?:include|exclude|encoding|context)$/.test(a)) i++;
      else if (!a.startsWith("-")) pos.push(args[i]);
    }
    return paths.concat(namedPattern ? pos : pos.slice(1));
  }
  if (name === "findstr") {
    const pos = args.filter((a) => !/^\/[a-z]/i.test(a));
    const explicit = args.some((a) => /^\/[cg]:/i.test(a));
    return explicit ? pos : pos.slice(1);
  }
  const pos = [];
  let explicitPattern = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (VALUE_FLAGS.has(a)) {
      if (a === "-e" || a === "-f" || a === "--regexp" || a === "--file") explicitPattern = true;
      i++;
    } else if (/^(?:-e|-f|--regexp=|--file=)./.test(a)) explicitPattern = true;
    else if (!a.startsWith("-")) pos.push(a);
  }
  return SEARCHERS.has(name) && !explicitPattern ? pos.slice(1) : pos;
}
// True when a path is root node_modules or a wildcard across all packages.
function isRootNodeModules(p) {
  const n = String(p).replace(/\\/g, "/");
  const m = /(?:^|\/)node_modules(?:\/(.*))?$/.exec(n);
  if (!m) return false;
  const next = (m[1] || "").split("/")[0];
  return next === "" || /[*?]/.test(next);
}
// Search over root node_modules: a search tool given it as a path, or a lister of it
// whose output feeds a search (gci node_modules | sls, find node_modules -exec grep).
function searchesRootNodeModules(stages) {
  const cmds = stages.map(stageCommand);
  const hasSearch = cmds.some((c) => SEARCHERS.has(c.name));
  return cmds.some((c) => {
    if (SEARCHERS.has(c.name)) return pathArgs(c).some(isRootNodeModules);
    if (LISTERS.has(c.name)) {
      const listsRoot = c.args.filter((a) => !a.startsWith("-")).some(isRootNodeModules);
      return listsRoot && (hasSearch || c.args.some((a) => SEARCHERS.has(a.toLowerCase())));
    }
    return false;
  });
}

// Scans every pipeline; returns {file, norm, start, end, bound} for each source-file read.
function findShellReads(segments) {
  const hits = [];
  for (const stages of segments) {
    const raw = stages[0];
    const toks = tokenize(raw.replace(/[()]/g, " ").replace(/\[[^\]]*\]/g, " ")).filter((t) => !/^(?:sudo|&)$/.test(t));
    while (toks.length && /^\w+=/.test(toks[0])) toks.shift(); // env assignments
    const c = (toks[0] || "").toLowerCase();
    if (!READERS.has(c)) continue;
    const files = toks.slice(1).filter((t) => !t.startsWith("-") && /\.[a-z0-9]{1,6}$/i.test(t));
    const src = files.map((f) => ({ f, n: normPath(f) })).filter((x) => SOURCE_DIR_RE.test(x.n) && !DOC_RE.test(x.n));
    if (!src.length) continue;
    const r = readerRange(c, toks, raw);
    if (r === "edit") continue;
    let bound = r.start === null || r.end === Infinity ? r.end : r.end - r.start + 1;
    for (const st of stages.slice(1)) bound = Math.min(bound, limiterBound(tokenize(st)));
    for (const x of src) hits.push({ file: x.f, norm: x.n, start: r.start, end: r.end, bound });
  }
  return hits;
}

// ------------------------------------------------------------ SessionStart
function sessionStart() {
  if (!hasGraph) pass();
  emit({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext:
        "graphify-guard active (graphify-out/ detected):\n" +
        "1. AST first: Glob/Grep, directory listings and raw source reads are blocked until you run `graphify query \"<1-2 concepts>\" --budget 800`, `graphify explain`, or `graphify path` (use the `graphify` CLI, not `python -m graphify`).\n" +
        `2. Reads are clamped to ${MAX_WINDOW_LINES} lines; more than ${MAX_CONSECUTIVE_PAGES} consecutive chunk reads of one file are blocked — jump to graphify locations (loc=Lxx) instead.\n` +
        "3. Run `graphify update .` once at the end of a milestone, not after every edit.",
    },
  });
}

// --------------------------------------------------------------- PreToolUse
function preTool() {
  const tool = String(payload.tool_name || "");
  const input = payload.tool_input || {};
  const unlocked = isUnlocked();

  // Native discovery tools
  if (tool === "Grep" || tool === "Glob") {
    if (hasGraph && !unlocked) deny(BLOCK_MSG);
    pass();
  }

  // Shell tools
  if (tool === "Bash" || tool === "PowerShell") {
    const cmd = String(input.command || "");
    const segments = splitCommand(cmd, tool === "Bash");
    let open = unlocked;

    // A graphify lookup anywhere in the command unlocks the session (it runs before later steps)
    if (segments.some((st) => st.some((s) => isGraphifyLookup(stageCommand(s))))) {
      unlock();
      open = true;
    }

    // Search over root node_modules (all projects): judged by real command names and path args
    if (!/--force-vendor/i.test(cmd) && segments.some(searchesRootNodeModules)) {
      deny(
        "[graphify-guard] Unscoped search in root node_modules is prohibited. Target node_modules/<pkg>/... or pass --force-vendor."
      );
    }

    if (hasGraph && !open) {
      const isDiscovery = segments.some((st) => st.some((s, i) => isDiscoveryStage(stageCommand(s), i)));
      if (isDiscovery) deny(BLOCK_MSG);
    }

    // Shell file reads of source files: same rules as Read (lock, 300-line window, paging ban)
    if (hasGraph) {
      for (const h of findShellReads(segments)) {
        if (!open) deny(BLOCK_MSG);
        if (h.bound > MAX_WINDOW_LINES) {
          deny(
            `[graphify-guard] Shell read of '${h.file}' would print ${h.bound === Infinity ? "the whole file" : h.bound + " lines"}. ` +
              `Use Read with offset/limit (max ${MAX_WINDOW_LINES} lines), or \`graphify explain "<symbol>"\` to jump to loc=Lxx.`
          );
        }
        if (h.start !== null && h.end !== Infinity) {
          const count = trackPaging(h.norm, h.start, h.end);
          if (count > MAX_CONSECUTIVE_PAGES) deny(pagingMsg(h.norm, count));
        }
      }
    }
    pass();
  }

  // Read
  if (tool === "Read") {
    if (!hasGraph) pass(); // all read rules are graph-project only

    const rawPath = String(input.file_path || "");
    if (!rawPath) pass();
    const abs = path.isAbsolute(rawPath) ? rawPath : path.resolve(workspaceRoot, rawPath);
    const norm = abs.replace(/\\/g, "/").toLowerCase();

    // Binary / rich files are rendered differently by Read — never clamp them
    if (/\.(png|jpe?g|gif|webp|bmp|svg|pdf|ipynb)$/i.test(norm)) pass();

    const isDoc =
      /(?:roadmap\.md|readme\.md|claude\.md|agents\.md|gemini\.md|package\.json|tsconfig[^/]*\.json)$/i.test(norm);
    if (isDoc) pass();

    if (!unlocked) {
      const isSource = /\/(?:src|lib|app|tools|public)\//.test(norm);
      if (isSource) deny(BLOCK_MSG);
    }

    const start = Number.isInteger(input.offset) && input.offset > 0 ? input.offset : 1;
    const requested = Number.isInteger(input.limit) && input.limit > 0 ? input.limit : null;
    const count = requested === null ? MAX_WINDOW_LINES : Math.min(requested, MAX_WINDOW_LINES);
    const end = start + count - 1;

    // Sequential paging tracker (shared with shell ranged reads)
    const pages = trackPaging(norm, start, end);
    if (pages > MAX_CONSECUTIVE_PAGES) deny(pagingMsg(norm, pages));

    if (requested === null || requested > MAX_WINDOW_LINES) {
      emit({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          permissionDecisionReason: `graphify-guard clamped Read to lines ${start}-${end} (max ${MAX_WINDOW_LINES}). Request further ranges explicitly if needed.`,
          updatedInput: { ...input, offset: start, limit: MAX_WINDOW_LINES },
        },
      });
    }
    pass();
  }

  pass();
}

// dispatch last: helpers above are const arrow functions (TDZ)
if (mode === "session-start") sessionStart();
else preTool();
