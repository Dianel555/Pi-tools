import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("npm tarball contains every runtime file and no personal rules", () => {
  const npmCli = process.env.npm_execpath;
  assert.ok(npmCli, "npm_execpath is required");
  const result = spawnSync(
    process.execPath,
    [npmCli, "pack", "--workspace", "@dianel/pi-hooks-rules", "--dry-run", "--json", "--ignore-scripts"],
    { cwd: repoRoot, encoding: "utf8", windowsHide: true },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout)[0];
  const files = new Set<string>(report.files.map((file: { path: string }) => file.path));
  for (const path of [
    "index.ts",
    "hooks.json",
    "hooks/secret-guard.mjs",
    "hooks/destructive-command-guard.mjs",
    "hooks/syntax-format-check.mjs",
    "assets/demo.png",
    "README.md",
    "LICENSE",
    "package.json",
  ]) {
    assert.equal(files.has(path), true, `missing from tarball: ${path}`);
  }
  assert.equal([...files].some((path) => path.startsWith("rules/") || path.endsWith(".sh")), false);
});
