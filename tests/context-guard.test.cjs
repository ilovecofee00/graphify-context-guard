const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

const SCRIPT_PATH = path.resolve(__dirname, "../scripts/context-guard.cjs");

// Mirrors key() in context-guard.cjs: md5(normalized workspace + "|" + session_id)
function stateKey(workspaceRoot, sessionId) {
  const norm = path.resolve(workspaceRoot).replace(/\\/g, "/").toLowerCase();
  return crypto.createHash("md5").update(norm + "|" + sessionId).digest("hex").slice(0, 12);
}

function runHook(mode, payload) {
  const result = spawnSync(process.execPath, [SCRIPT_PATH, mode], {
    input: JSON.stringify(payload),
    encoding: "utf-8",
  });
  let json = null;
  try {
    json = JSON.parse(result.stdout.trim());
  } catch {}
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, json };
}

const decision = (res) => res.json?.hookSpecificOutput?.permissionDecision ?? null;
const reason = (res) => res.json?.hookSpecificOutput?.permissionDecisionReason ?? "";

function assertPass(res) {
  assert.equal(res.status, 0);
  assert.equal(res.stdout.trim(), "", `expected pass-through, got: ${res.stdout}`);
}
function assertDeny(res, includes) {
  assert.equal(res.status, 0);
  assert.equal(decision(res), "deny", `expected deny, got: ${res.stdout}`);
  if (includes) assert.ok(reason(res).includes(includes), `reason missing "${includes}": ${reason(res)}`);
}

describe("graphify-guard context-guard.cjs (Claude Code hook protocol)", () => {
  let ws;
  let sessionId;
  let lockFile;
  let trackerFile;

  const tool = (tool_name, tool_input) =>
    runHook("pre-tool", { session_id: sessionId, cwd: ws, hook_event_name: "PreToolUse", tool_name, tool_input });
  const unlock = () => fs.writeFileSync(lockFile, new Date().toISOString(), "utf-8");

  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), "guard-test-ws-"));
    fs.mkdirSync(path.join(ws, "graphify-out"), { recursive: true });
    fs.mkdirSync(path.join(ws, "src"), { recursive: true });
    sessionId = "test-" + crypto.randomUUID();
    const k = stateKey(ws, sessionId);
    lockFile = path.join(os.tmpdir(), `.graphify-guard-${k}.lock`);
    trackerFile = path.join(os.tmpdir(), `.graphify-guard-reads-${k}.json`);
  });

  afterEach(() => {
    for (const f of [lockFile, trackerFile]) {
      try {
        fs.unlinkSync(f);
      } catch {}
    }
    fs.rmSync(ws, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------- SessionStart
  describe("SessionStart", () => {
    test("injects guard rules when graphify-out/ exists", () => {
      const res = runHook("session-start", { session_id: sessionId, cwd: ws, hook_event_name: "SessionStart" });
      assert.equal(res.status, 0);
      assert.equal(res.json?.hookSpecificOutput?.hookEventName, "SessionStart");
      const ctx = res.json.hookSpecificOutput.additionalContext;
      assert.ok(ctx.includes("graphify-guard active"));
      assert.ok(ctx.includes("300 lines"));
    });

    test("is silent in workspaces without graphify-out/", () => {
      fs.rmSync(path.join(ws, "graphify-out"), { recursive: true });
      assertPass(runHook("session-start", { session_id: sessionId, cwd: ws }));
    });
  });

  // ----------------------------------------------------------- Graphify-first gate
  describe("Graphify-first gate (locked session)", () => {
    test("blocks Grep and Glob before a graphify lookup", () => {
      assertDeny(tool("Grep", { pattern: "createScene" }), "graphify query");
      assertDeny(tool("Glob", { pattern: "**/*.ts" }), "graphify query");
    });

    test("blocks shell discovery commands (ls, find, grep, Get-ChildItem)", () => {
      assertDeny(tool("Bash", { command: "ls src" }));
      assertDeny(tool("Bash", { command: "find . -name '*.ts'" }));
      assertDeny(tool("Bash", { command: "grep -rn useEffect src/" }));
      assertDeny(tool("PowerShell", { command: "Get-ChildItem -Recurse src" }));
    });

    test("blocks Read of source files but allows docs, non-source files and binaries", () => {
      assertDeny(tool("Read", { file_path: "src/index.ts", offset: 1, limit: 40 }));
      assertPass(tool("Read", { file_path: "README.md" }));
      assertPass(tool("Read", { file_path: "package.json" }));
      assertPass(tool("Read", { file_path: "src/logo.png" }));
      assertPass(tool("Read", { file_path: "notes/todo.txt", offset: 1, limit: 50 }));
    });

    test("blocks shell reads of source files", () => {
      assertDeny(tool("Bash", { command: "head -n 20 src/index.ts" }), "graphify query");
    });

    test("does not block non-discovery shell commands", () => {
      assertPass(tool("Bash", { command: "npm test" }));
      assertPass(tool("Bash", { command: "git status" }));
    });
  });

  describe("Unlocking", () => {
    test("graphify query / explain / path unlock the session", () => {
      for (const command of [
        'graphify query "auth flow" --budget 800',
        'graphify explain "createScene"',
        'graphify path "Router" "Store"',
      ]) {
        try {
          fs.unlinkSync(lockFile);
        } catch {}
        assertPass(tool("Bash", { command }));
        assert.ok(fs.existsSync(lockFile), `lock not written for: ${command}`);
        assertPass(tool("Grep", { pattern: "createScene" }));
      }
    });

    test("unlock is scoped to the session", () => {
      unlock();
      assertPass(tool("Glob", { pattern: "**/*.ts" }));
      const other = runHook("pre-tool", {
        session_id: sessionId + "-other",
        cwd: ws,
        tool_name: "Glob",
        tool_input: { pattern: "**/*.ts" },
      });
      assertDeny(other);
    });

    test("an expired lock (> 30 min) re-locks the session", () => {
      unlock();
      const old = new Date(Date.now() - 31 * 60 * 1000);
      fs.utimesSync(lockFile, old, old);
      assertDeny(tool("Grep", { pattern: "x" }));
      assert.equal(fs.existsSync(lockFile), false);
    });
  });

  // ----------------------------------------------------------------- Read clamp
  describe("Read window clamp (300 lines)", () => {
    beforeEach(unlock);

    test("clamps a Read with no limit to 300 lines via updatedInput", () => {
      const res = tool("Read", { file_path: "src/app.ts" });
      assert.equal(decision(res), "allow");
      assert.deepEqual(res.json.hookSpecificOutput.updatedInput, { file_path: "src/app.ts", offset: 1, limit: 300 });
    });

    test("clamps a Read whose limit exceeds 300, keeping the offset", () => {
      const res = tool("Read", { file_path: "src/app.ts", offset: 500, limit: 1000 });
      assert.equal(decision(res), "allow");
      assert.deepEqual(res.json.hookSpecificOutput.updatedInput, { file_path: "src/app.ts", offset: 500, limit: 300 });
      assert.ok(reason(res).includes("lines 500-799"));
    });

    test("passes a Read within the window untouched", () => {
      assertPass(tool("Read", { file_path: "src/app.ts", offset: 500, limit: 250 }));
    });
  });

  // -------------------------------------------------------------- Paging ban
  describe("Sequential paging ban", () => {
    beforeEach(unlock);

    test("blocks the 3rd consecutive Read chunk of the same file", () => {
      assertPass(tool("Read", { file_path: "src/engine.ts", offset: 1, limit: 300 }));
      assertPass(tool("Read", { file_path: "src/engine.ts", offset: 301, limit: 300 }));
      assertDeny(tool("Read", { file_path: "src/engine.ts", offset: 601, limit: 300 }), "Sequential paging");
    });

    test("non-contiguous reads reset the counter", () => {
      assertPass(tool("Read", { file_path: "src/engine.ts", offset: 1, limit: 100 }));
      assertPass(tool("Read", { file_path: "src/engine.ts", offset: 101, limit: 100 }));
      assertPass(tool("Read", { file_path: "src/engine.ts", offset: 900, limit: 100 }));
    });

    test("paging is tracked per file", () => {
      assertPass(tool("Read", { file_path: "src/a.ts", offset: 1, limit: 100 }));
      assertPass(tool("Read", { file_path: "src/a.ts", offset: 101, limit: 100 }));
      assertPass(tool("Read", { file_path: "src/b.ts", offset: 201, limit: 100 }));
    });

    test("ranged shell reads share the tracker with Read", () => {
      assertPass(tool("Read", { file_path: "src/engine.ts", offset: 1, limit: 100 }));
      assertPass(tool("Bash", { command: "sed -n '101,200p' src/engine.ts" }));
      assertDeny(tool("Bash", { command: "sed -n '201,300p' src/engine.ts" }), "Sequential paging");
    });
  });

  // --------------------------------------------------------- Shell read sizing
  describe("Shell source reads (unlocked)", () => {
    beforeEach(unlock);

    test("blocks whole-file dumps", () => {
      assertDeny(tool("Bash", { command: "cat src/index.ts" }), "the whole file");
      assertDeny(tool("PowerShell", { command: "Get-Content src/index.ts" }), "the whole file");
    });

    test("blocks bounded reads over 300 lines", () => {
      assertDeny(tool("Bash", { command: "head -n 500 src/index.ts" }), "500 lines");
    });

    test("allows bounded reads within 300 lines", () => {
      assertPass(tool("Bash", { command: "head -n 50 src/index.ts" }));
      assertPass(tool("PowerShell", { command: "Get-Content src/index.ts -TotalCount 100" }));
    });

    test("a limiting pipe stage bounds the read", () => {
      assertPass(tool("Bash", { command: "cat src/index.ts | head -n 40" }));
      assertPass(tool("Bash", { command: "cat src/index.ts | wc -l" }));
    });

    test("ignores in-place edits and non-source files", () => {
      assertPass(tool("Bash", { command: "sed -i 's/foo/bar/' src/index.ts" }));
      assertPass(tool("Bash", { command: "cat README.md" }));
      assertPass(tool("Bash", { command: "cat docs/notes.txt" }));
    });
  });

  // ------------------------------------------------------------ node_modules
  describe("Unscoped node_modules search", () => {
    beforeEach(unlock);

    test("blocks searching root node_modules", () => {
      assertDeny(tool("Bash", { command: "grep -rn 'createScene' node_modules/" }), "node_modules");
      assertDeny(tool("Bash", { command: "rg WebGLRenderer node_modules" }), "node_modules");
    });

    test("allows a package-scoped search or --force-vendor", () => {
      assertPass(tool("Bash", { command: "grep -rn 'WebGLRenderer' node_modules/three/src" }));
      assertPass(tool("Bash", { command: "rg WebGLRenderer node_modules --force-vendor" }));
    });

    test("applies outside graph projects too", () => {
      fs.rmSync(path.join(ws, "graphify-out"), { recursive: true });
      assertDeny(tool("Bash", { command: "grep -rn foo node_modules/" }), "node_modules");
    });
  });

  // ------------------------------------------- Command-structure parsing (v1.0.0)
  describe("No false positives from words inside strings or arguments", () => {
    test("node_modules mentioned in a string next to an output filter is allowed", () => {
      unlock();
      assertPass(
        tool("Bash", {
          command:
            `sed -i 's/"description": ".*"/"description": "unscoped node_modules search prevention."/' plugin.json && npm test 2>&1 | grep -E "^(tests|pass|fail)"`,
        })
      );
      assertPass(tool("Bash", { command: `git commit -m "block grep over node_modules"` }));
    });

    test("grep for the word node_modules in a file is not a node_modules search", () => {
      unlock();
      assertPass(tool("Bash", { command: "grep -n node_modules .gitignore" }));
      assertPass(tool("Bash", { command: "rg --exclude-dir node_modules foo src" }));
      assertPass(tool("Bash", { command: "grep -rn --exclude-dir=node_modules foo ." }));
    });

    test("discovery words inside strings or paths do not block a locked session", () => {
      assertPass(tool("Bash", { command: `git commit -m "fix tree view and find bug"` }));
      assertPass(tool("Bash", { command: `echo "ls the dir"` }));
      assertPass(tool("Bash", { command: "cat build/dir/out.log" }));
      assertPass(tool("PowerShell", { command: `Write-Output "C:\\tools\\dir\\"; git status` }));
    });

    test("a search tool fed by a pipe is an output filter, not discovery", () => {
      assertPass(tool("Bash", { command: "npm test 2>&1 | grep fail" }));
      assertPass(tool("PowerShell", { command: "npm test | Select-String fail" }));
    });

    test("graphify subcommand words elsewhere do not unlock", () => {
      assertPass(tool("Bash", { command: "graphify update . && echo path" }));
      assert.equal(fs.existsSync(lockFile), false);
      assertDeny(tool("Grep", { pattern: "x" }));
    });
  });

  describe("Real discovery and vendor searches are still caught", () => {
    test("discovery after && / ; / subshell is blocked when locked", () => {
      assertDeny(tool("Bash", { command: "npm test && ls src" }));
      assertDeny(tool("Bash", { command: "echo hi; find . -name '*.ts'" }));
      assertDeny(tool("Bash", { command: "echo $(ls src)" }));
      assertDeny(tool("Bash", { command: "FOO=1 sudo rg useEffect" }));
    });

    test("git ls-files, git ls-tree and git grep count as discovery", () => {
      assertDeny(tool("Bash", { command: "git ls-files" }));
      assertDeny(tool("Bash", { command: "git ls-tree -r HEAD" }));
      assertDeny(tool("Bash", { command: "git grep useEffect" }));
      assertPass(tool("Bash", { command: "git log --oneline -5" }));
    });

    test("a lookup earlier in the same command unlocks the rest", () => {
      assertPass(tool("Bash", { command: 'graphify explain "Router" && ls src' }));
      assertPass(tool("Bash", { command: 'python -m graphify query "auth" --budget 800' }));
    });

    test("node_modules searches in all forms", () => {
      unlock();
      for (const [t, command] of [
        ["Bash", "grep -rn foo ./node_modules"],
        ["Bash", 'rg -e foo "node_modules/"'],
        ["Bash", "grep -rn foo node_modules/*"],
        ["Bash", "find node_modules -name '*.js' | xargs grep foo"],
        ["Bash", "find node_modules -name '*.js' -exec grep -l foo {} +"],
        ["PowerShell", "Get-ChildItem node_modules -Recurse | Select-String foo"],
        ["PowerShell", "Select-String -Pattern foo -Path node_modules\\*"],
        ["PowerShell", "findstr /s foo node_modules\\*"],
      ]) {
        assertDeny(tool(t, { command }), "node_modules");
      }
      assertPass(tool("Bash", { command: "grep -rn foo node_modules/three/src" }));
      assertPass(tool("Bash", { command: "find node_modules -maxdepth 1" }));
    });

    test("quoted separators do not hide or split commands", () => {
      unlock();
      assertPass(tool("Bash", { command: `echo "a | grep b; ls" > out.txt` }));
      assertDeny(tool("Bash", { command: `echo "x;y" && cat src/index.ts` }), "the whole file");
    });
  });

  // ------------------------------------------------------- Non-graph projects
  describe("Workspaces without graphify-out/", () => {
    beforeEach(() => fs.rmSync(path.join(ws, "graphify-out"), { recursive: true }));

    test("all read/exploration rules are disabled", () => {
      assertPass(tool("Grep", { pattern: "x" }));
      assertPass(tool("Glob", { pattern: "**/*" }));
      assertPass(tool("Bash", { command: "ls src && cat src/index.ts" }));
      assertPass(tool("Read", { file_path: "src/index.ts" }));
    });
  });

  test("tolerates empty or invalid stdin", () => {
    const res = spawnSync(process.execPath, [SCRIPT_PATH, "pre-tool"], { input: "not json", encoding: "utf-8" });
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), "");
  });
});
