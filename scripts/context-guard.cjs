/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const LOCK_TTL_MS = 30 * 60 * 1000; // 30 minutes session AST lock
const PAGING_TTL_MS = 5 * 60 * 1000; // 5 minutes sliding-window reset TTL

const MAX_WINDOW_LINES = 80; // Maximum lines allowed per single read
const MAX_CONSECUTIVE_PAGES = 2; // Maximum consecutive sequential reads on the same file

if (process.argv.includes("pre-invocation")) {
  runPreInvocation();
} else {
  runPreTool();
}

function getWorkspaceRoot(payload) {
  if (Array.isArray(payload?.workspacePaths) && payload.workspacePaths.length > 0) {
    return payload.workspacePaths[0];
  }
  return process.env.WORKSPACE_ROOT || process.cwd();
}

function getWorkspaceHash(workspaceRoot) {
  const normalized = path.resolve(workspaceRoot).replace(/\\/g, "/").toLowerCase();
  return crypto.createHash("md5").update(normalized).digest("hex").slice(0, 12);
}

function getLockPath(workspaceRoot) {
  const hash = getWorkspaceHash(workspaceRoot);
  return path.join(os.tmpdir(), `.graphify-session-${hash}.lock`);
}

function getTrackerPath(workspaceRoot) {
  const hash = getWorkspaceHash(workspaceRoot);
  return path.join(os.tmpdir(), `.guard-read-tracker-${hash}.json`);
}

function isSessionQueried(workspaceRoot) {
  const lp = getLockPath(workspaceRoot);
  if (!fs.existsSync(lp)) return false;
  try {
    const stat = fs.statSync(lp);
    if (Date.now() - stat.mtimeMs > LOCK_TTL_MS) {
      fs.unlinkSync(lp);
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function markSessionQueried(workspaceRoot) {
  try {
    fs.writeFileSync(getLockPath(workspaceRoot), new Date().toISOString(), "utf-8");
  } catch {}
}

function getReadHistory(workspaceRoot) {
  const tp = getTrackerPath(workspaceRoot);
  if (!fs.existsSync(tp)) return {};
  try {
    return JSON.parse(fs.readFileSync(tp, "utf-8"));
  } catch {
    return {};
  }
}

function saveReadHistory(workspaceRoot, history) {
  try {
    fs.writeFileSync(getTrackerPath(workspaceRoot), JSON.stringify(history), "utf-8");
  } catch {}
}

// -------------------------------------------------------------
// PreInvocation Handler
// -------------------------------------------------------------
function runPreInvocation() {
  let raw = "";
  try {
    raw = fs.readFileSync(0, "utf-8");
  } catch {
    raw = "";
  }

  let payload = {};
  if (raw.trim()) {
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = {};
    }
  }

  const workspaceRoot = getWorkspaceRoot(payload);
  const queried = isSessionQueried(workspaceRoot);

  const response = {
    injectSteps: [
      {
        ephemeralMessage:
          `Context Guard Active (Session AST Unlocked: ${queried}):\n` +
          `1. Targeted Reads: Max read slice is strictly ${MAX_WINDOW_LINES} lines. Broad dumps are auto-clamped.\n` +
          `2. Sequential Paging Ban: Sliding window reads (e.g. 1-80, 81-160...) on the same file are rejected after ${MAX_CONSECUTIVE_PAGES} consecutive pages. Use Graphify symbol offsets (loc=Lxx).\n` +
          `3. State 1 (AST First): Unverified exploration commands remain blocked until 'graphify query', 'explain', or 'path' is executed.`,
      },
    ],
    terminationBehavior: "",
  };
  process.stdout.write(JSON.stringify(response));
  process.exit(0);
}

// -------------------------------------------------------------
// PreToolUse Handler
// -------------------------------------------------------------
function runPreTool() {
  let raw = "";
  try {
    raw = fs.readFileSync(0, "utf-8");
  } catch {
    raw = "";
  }

  let payload = {};
  if (raw.trim()) {
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = {};
    }
  }

  const toolName = payload?.toolCall?.name ?? "";
  const args = payload?.toolCall?.args ?? {};
  const workspaceRoot = getWorkspaceRoot(payload);
  const hasGraphifyOut = fs.existsSync(path.join(workspaceRoot, "graphify-out"));
  const hasGraphifySessionQueried = isSessionQueried(workspaceRoot);

  const BLOCK_MSG =
    "[HOOK BLOCKED]: Directory scanning and raw file search are strictly disabled when 'graphify-out' exists. Execute a focused 'graphify query', 'explain', or 'path' command FIRST.";

  function outputResponse(resp) {
    process.stdout.write(JSON.stringify(resp));
    process.exit(0);
  }

  function blockTool(reason) {
    process.stderr.write(reason + "\n");
    process.stdout.write(
      JSON.stringify({
        decision: "deny",
        reason: reason,
      })
    );
    process.exit(1);
  }

  // -----------------------------------------------------------
  // GATEKEEPER 0: Native Discovery / Search Tools
  // -----------------------------------------------------------
  const nativeDiscoveryTools = new Set([
    "list_dir",
    "find_by_name",
    "grep_search",
    "glob",
    "Grep",
    "Glob",
    "LS",
  ]);

  if (nativeDiscoveryTools.has(toolName)) {
    if (hasGraphifyOut && !hasGraphifySessionQueried) {
      blockTool(BLOCK_MSG);
    }
    outputResponse({ decision: "allow" });
  }

  // -----------------------------------------------------------
  // Tool: run_command / Bash / shell
  // -----------------------------------------------------------
  if (toolName === "run_command" || toolName === "Bash" || toolName === "shell") {
    const cmdKey = ["CommandLine", "command", "cmd"].find((k) => k in args) || "CommandLine";
    const cmd = String(args[cmdKey] ?? "").trim();
    const lowerCmd = cmd.toLowerCase();

    const isGraphifyLookup = /\bgraphify\b.*?\b(?:query|explain|path)\b/i.test(cmd);
    if (isGraphifyLookup) {
      markSessionQueried(workspaceRoot);
    }

    if (hasGraphifyOut && !hasGraphifySessionQueried && !isGraphifyLookup) {
      const isDiscoveryCommand =
        /\b(?:get-childitem|gci|dir|ls|find|tree|grep|rg|ripgrep|select-string|findstr|test-path)\b/i.test(cmd);
      if (isDiscoveryCommand) {
        blockTool(BLOCK_MSG);
      }
    }

    const isGitGrep = /\bgit\s+grep\b/i.test(cmd);
    if (isGitGrep) {
      outputResponse({ decision: "allow" });
    }

    const isGrep = /\bgrep\b/i.test(cmd);
    const isRipgrep = /\b(rg|ripgrep)\b/i.test(cmd);
    const isFindstr = /\bfindstr\b/i.test(cmd);
    const isSelectString =
      /\bselect-string\b/i.test(cmd) &&
      (/-path\b/i.test(cmd) || /\bget-childitem\b/i.test(cmd));

    const isSearchCommand = isGrep || isRipgrep || isFindstr || isSelectString;

    // Allow scoped package searches (e.g. node_modules/three/...), block root node_modules dumps
    const isUnscopedNodeModules =
      /(?:^|[\s"'/\\])node_modules(?:\/?\s*$|\/?\s+|\/?\*+|["'])/i.test(cmd);

    if (isSearchCommand && isUnscopedNodeModules && !lowerCmd.includes("--force-vendor")) {
      blockTool(
        "BLOCKED by context-guard: Unscoped search in root node_modules prohibited. Target a specific package (node_modules/<pkg>) or pass --force-vendor."
      );
    }

    if (isGrep && !cmd.includes("--exclude-dir") && !lowerCmd.includes("node_modules")) {
      const rewritten = cmd.replace(
        /\bgrep\b/i,
        "grep --exclude-dir=node_modules --exclude-dir=.next --exclude-dir=.git"
      );
      outputResponse({
        decision: "allow",
        overwrite: { [cmdKey]: rewritten },
      });
    }

    outputResponse({ decision: "allow" });
  }

  // -----------------------------------------------------------
  // Tool: read_file / Read / view_file
  // -----------------------------------------------------------
  if (toolName === "read_file" || toolName === "Read" || toolName === "view_file") {
    const rawPath = String(args.Path ?? args.file_path ?? args.path ?? "");
    const resolvedPath = path.isAbsolute(rawPath)
      ? rawPath
      : path.resolve(workspaceRoot, rawPath);
    const normalizedPath = resolvedPath.replace(/\\/g, "/").toLowerCase();

    // Turn-1 AST Control
    if (hasGraphifyOut && !hasGraphifySessionQueried) {
      const isAllowedDoc =
        /(?:roadmap\.md|readme\.md|gemini\.md|agents\.md|claude\.md|package\.json|tsconfig.*\.json)$/i.test(
          normalizedPath
        );
      const isSourcePath =
        normalizedPath.includes("/src/") ||
        normalizedPath.includes("/lib/") ||
        normalizedPath.includes("/app/") ||
        normalizedPath.includes("/tools/") ||
        normalizedPath.includes("/public/");

      if (!isAllowedDoc && isSourcePath) {
        blockTool(BLOCK_MSG);
      }
    }

    // Normalize line slice parameters across different host schemas
    const startKey =
      ["StartLine", "start_line", "offset", "line_offset"].find((k) => k in args) || "start_line";
    const endKey =
      ["EndLine", "end_line", "limit", "line_count"].find((k) => k in args) || "end_line";
    const isCountBased = endKey === "limit" || endKey === "line_count";

    const start = typeof args[startKey] === "number" && args[startKey] > 0 ? args[startKey] : 1;
    let end = null;

    if (typeof args[endKey] === "number" && args[endKey] > 0) {
      end = isCountBased ? start + args[endKey] - 1 : args[endKey];
    }

    const needsUnboundedClamp = end === null;
    if (needsUnboundedClamp) {
      end = start + MAX_WINDOW_LINES - 1;
    }

    const requestedWindow = end - start + 1;

    // --- SEQUENTIAL PAGING / READ TRACKER CONTROL ---
    const history = getReadHistory(workspaceRoot);
    const now = Date.now();
    const fileRecord = history[normalizedPath] || { count: 0, lastEnd: 0, timestamp: 0 };

    const isWithinTtl = now - fileRecord.timestamp < PAGING_TTL_MS;
    const isSequentialContinuation = isWithinTtl && Math.abs(start - (fileRecord.lastEnd + 1)) <= 5;

    if (isSequentialContinuation) {
      fileRecord.count += 1;
    } else {
      fileRecord.count = 1;
    }
    fileRecord.lastEnd = Math.min(end, start + MAX_WINDOW_LINES - 1);
    fileRecord.timestamp = now;

    if (fileRecord.count > MAX_CONSECUTIVE_PAGES) {
      saveReadHistory(workspaceRoot, history);
      blockTool(
        `[BLOCKED by context-guard]: Sequential paging detected on '${path.basename(normalizedPath)}' ` +
          `(${fileRecord.count} consecutive reads). Do not drain context by reading entire files in chunks.\n` +
          `Action: Use Graphify to locate the exact symbol line (loc=Lxx), then read strictly 30-50 lines around it.`
      );
    }

    history[normalizedPath] = fileRecord;
    saveReadHistory(workspaceRoot, history);

    // --- SLICE CLAMPING ---
    if (needsUnboundedClamp || requestedWindow > MAX_WINDOW_LINES) {
      const clampedEnd = start + MAX_WINDOW_LINES - 1;
      outputResponse({
        decision: "allow",
        overwrite: {
          [startKey]: start,
          [endKey]: isCountBased ? MAX_WINDOW_LINES : clampedEnd,
        },
      });
    }

    outputResponse({ decision: "allow" });
  }

  outputResponse({ decision: "allow" });
}