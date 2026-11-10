const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

const SCRIPT_PATH = path.resolve(__dirname, "../scripts/context-guard.cjs");

function getWorkspaceHash(workspaceRoot) {
  const normalized = path.resolve(workspaceRoot).replace(/\\/g, "/").toLowerCase();
  return crypto.createHash("md5").update(normalized).digest("hex").slice(0, 12);
}

function runHook(mode, payload) {
  const result = spawnSync(process.execPath, [SCRIPT_PATH, mode], {
    input: JSON.stringify(payload),
    encoding: "utf-8",
  });
  let parsed = null;
  try {
    parsed = JSON.parse(result.stdout.trim());
  } catch {}
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    json: parsed,
  };
}

describe("Graphify Context Guard Middleware Suite", () => {
  let tempWorkspace;
  let lockFile;
  let trackerFile;

  beforeEach(() => {
    tempWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "guard-test-ws-"));
    fs.mkdirSync(path.join(tempWorkspace, "graphify-out"), { recursive: true });
    fs.mkdirSync(path.join(tempWorkspace, "src"), { recursive: true });

    const hash = getWorkspaceHash(tempWorkspace);
    lockFile = path.join(os.tmpdir(), `.graphify-session-${hash}.lock`);
    trackerFile = path.join(os.tmpdir(), `.guard-read-tracker-${hash}.json`);
  });

  afterEach(() => {
    try {
      fs.rmSync(tempWorkspace, { recursive: true, force: true });
      if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);
      if (fs.existsSync(trackerFile)) fs.unlinkSync(trackerFile);
    } catch {}
  });

  test("1. PreInvocation injects ephemeral state-machine rules", () => {
    const res = runHook("pre-invocation", { workspacePaths: [tempWorkspace] });
    assert.equal(res.status, 0);
    assert.ok(res.json?.injectSteps?.[0]?.ephemeralMessage.includes("Session AST Unlocked: false"));
  });

  test("2. Turn-1 Gatekeeper blocks native discovery tools before AST query", () => {
    const res = runHook("pre-tool", {
      workspacePaths: [tempWorkspace],
      toolCall: { name: "list_dir", args: { path: "." } },
    });
    assert.equal(res.status, 1);
    assert.equal(res.json?.decision, "deny");
  });

  test("3. Turn-1 Gatekeeper blocks source file reads before AST query, allows README.md", () => {
    const blockedRes = runHook("pre-tool", {
      workspacePaths: [tempWorkspace],
      toolCall: { name: "read_file", args: { path: "src/index.ts", start_line: 1, end_line: 40 } },
    });
    assert.equal(blockedRes.status, 1);
    assert.equal(blockedRes.json?.decision, "deny");

    const allowedRes = runHook("pre-tool", {
      workspacePaths: [tempWorkspace],
      toolCall: { name: "read_file", args: { path: "README.md", start_line: 1, end_line: 40 } },
    });
    assert.equal(allowedRes.status, 0);
    assert.equal(allowedRes.json?.decision, "allow");
  });

  test("4. Executing graphify query unlocks session for subsequent reads and searches", () => {
    const queryRes = runHook("pre-tool", {
      workspacePaths: [tempWorkspace],
      toolCall: {
        name: "run_command",
        args: { CommandLine: 'python -m graphify query "auth" --budget 800' },
      },
    });
    assert.equal(queryRes.status, 0);
    assert.equal(queryRes.json?.decision, "allow");

    // Source read should now succeed
    const readRes = runHook("pre-tool", {
      workspacePaths: [tempWorkspace],
      toolCall: { name: "read_file", args: { path: "src/index.ts", start_line: 1, end_line: 50 } },
    });
    assert.equal(readRes.status, 0);
    assert.equal(readRes.json?.decision, "allow");
  });

  test("5. Clamps read_file window > 80 lines for both end_line and limit schemas", () => {
    // Unlock session first
    fs.writeFileSync(lockFile, new Date().toISOString(), "utf-8");

    // Schema A: start_line / end_line
    const resEndLine = runHook("pre-tool", {
      workspacePaths: [tempWorkspace],
      toolCall: {
        name: "read_file",
        args: { path: "src/app.ts", start_line: 100, end_line: 350 },
      },
    });
    assert.equal(resEndLine.status, 0);
    assert.deepEqual(resEndLine.json?.overwrite, { start_line: 100, end_line: 179 });

    // Schema B: offset / limit
    const resLimit = runHook("pre-tool", {
      workspacePaths: [tempWorkspace],
      toolCall: {
        name: "Read",
        args: { file_path: "src/other.ts", offset: 500, limit: 250 },
      },
    });
    assert.equal(resLimit.status, 0);
    assert.deepEqual(resLimit.json?.overwrite, { offset: 500, limit: 80 });
  });

  test("6. Blocks sequential sliding-window paging after 2 consecutive chunks", () => {
    fs.writeFileSync(lockFile, new Date().toISOString(), "utf-8");

    // Page 1: lines 1-80 (Allowed)
    const p1 = runHook("pre-tool", {
      workspacePaths: [tempWorkspace],
      toolCall: { name: "read_file", args: { path: "src/engine.ts", start_line: 1, end_line: 80 } },
    });
    assert.equal(p1.status, 0);

    // Page 2: lines 81-160 (Allowed)
    const p2 = runHook("pre-tool", {
      workspacePaths: [tempWorkspace],
      toolCall: { name: "read_file", args: { path: "src/engine.ts", start_line: 81, end_line: 160 } },
    });
    assert.equal(p2.status, 0);

    // Page 3: lines 161-240 (Blocked!)
    const p3 = runHook("pre-tool", {
      workspacePaths: [tempWorkspace],
      toolCall: { name: "read_file", args: { path: "src/engine.ts", start_line: 161, end_line: 240 } },
    });
    assert.equal(p3.status, 1);
    assert.equal(p3.json?.decision, "deny");
    assert.ok(p3.json?.reason.includes("Sequential paging detected"));
  });

  test("7. Blocks unscoped root node_modules grep, allows scoped package grep, and auto-rewrites standard grep", () => {
    fs.writeFileSync(lockFile, new Date().toISOString(), "utf-8");

    // Root node_modules -> Blocked
    const blockedVendor = runHook("pre-tool", {
      workspacePaths: [tempWorkspace],
      toolCall: { name: "Bash", args: { command: "grep -rn 'createScene' node_modules/" } },
    });
    assert.equal(blockedVendor.status, 1);

    // Scoped node_modules/<pkg> -> Allowed
    const allowedVendor = runHook("pre-tool", {
      workspacePaths: [tempWorkspace],
      toolCall: { name: "Bash", args: { command: "grep -rn 'WebGLRenderer' node_modules/three/src" } },
    });
    assert.equal(allowedVendor.status, 0);
    assert.equal(allowedVendor.json?.decision, "allow");

    // Standard grep without exclusions -> Auto-rewritten on matching key ('command')
    const rewrittenGrep = runHook("pre-tool", {
      workspacePaths: [tempWorkspace],
      toolCall: { name: "Bash", args: { command: "grep -rn 'useEffect' src/" } },
    });
    assert.equal(rewrittenGrep.status, 0);
    assert.equal(
      rewrittenGrep.json?.overwrite?.command,
      "grep --exclude-dir=node_modules --exclude-dir=.next --exclude-dir=.git -rn 'useEffect' src/"
    );
  });
});