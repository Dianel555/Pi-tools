import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const hooksDir = join(repoRoot, "packages", "pi-hooks-rules", "hooks");

function runHook(name: string, payload: unknown) {
  return spawnSync(process.execPath, [join(hooksDir, name)], {
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
}

test("secret guard denies credential-shaped content", () => {
  const secret = `sk-ant-${"A".repeat(24)}`;
  const result = runHook("secret-guard.mjs", { tool_name: "Write", tool_input: { content: secret } });
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, "deny");
});

test("destructive guard denies broad deletion and permits disposable targets", () => {
  const denied = runHook("destructive-command-guard.mjs", {
    tool_name: "Bash",
    tool_input: { command: "rm -fr important-data" },
  });
  const allowed = runHook("destructive-command-guard.mjs", {
    tool_name: "Bash",
    tool_input: { command: "rm -rf node_modules" },
  });
  const mixedCleanup = runHook("destructive-command-guard.mjs", {
    tool_name: "Bash",
    tool_input: { command: "echo done && rm -rf node_modules" },
  });
  const powershellDelete = runHook("destructive-command-guard.mjs", {
    tool_name: "PowerShell",
    tool_input: { command: "Remove-Item important -Recurse" },
  });
  assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, "deny");
  assert.equal(JSON.parse(allowed.stdout).hookSpecificOutput.permissionDecision, "allow");
  assert.equal(JSON.parse(mixedCleanup.stdout).hookSpecificOutput.permissionDecision, "deny");
  assert.equal(JSON.parse(powershellDelete.stdout).hookSpecificOutput.permissionDecision, "deny");
  const powershellSwitchDelete = runHook("destructive-command-guard.mjs", {
    tool_name: "PowerShell",
    tool_input: { command: "Remove-Item important -Recurse:$true -Force" },
  });
  assert.equal(JSON.parse(powershellSwitchDelete.stdout).hookSpecificOutput.permissionDecision, "deny");
});

test("destructive guard handles mixed-case protected Git commands", () => {
  for (const command of [
    "git COMMIT -m test",
    "git PUSH --FORCE",
    "git PUSH --FORCE-WITH-LEASE",
    "git RESET --HARD",
    "git.exe RESET --HARD",
    "git CLEAN -F",
    "git CHECKOUT \".\"",
    "git BRANCH -D old",
    "git STASH CLEAR",
  ]) {
    const result = runHook("destructive-command-guard.mjs", {
      tool_name: "PowerShell",
      tool_input: { command },
    });
    assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, "deny", command);
  }
});

test("syntax hook reports invalid JavaScript with exit code 2", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-hook-syntax-"));
  try {
    const valid = join(root, "valid.js");
    const invalid = join(root, "invalid.js");
    writeFileSync(valid, "const valid = true;\n");
    writeFileSync(invalid, "const = ;\n");

    assert.equal(
      runHook("syntax-format-check.mjs", { tool_name: "Write", tool_input: { file_path: valid } }).status,
      0,
    );
    const result = runHook("syntax-format-check.mjs", {
      tool_name: "Write",
      tool_input: { file_path: invalid },
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /syntax-check/);
    assert.equal(readFileSync(invalid, "utf8"), "const = ;\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
