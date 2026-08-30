import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const packageRoot = join(repoRoot, "packages", "pi-hooks-rules");
const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));

test("package manifest exposes one Pi extension", () => {
  assert.equal(manifest.name, "@dianel/pi-hooks-rules");
  assert.equal(manifest.private, undefined);
  assert.deepEqual(manifest.pi.extensions, ["./index.ts"]);
  assert.equal(manifest.keywords.includes("pi-package"), true);
  assert.equal(existsSync(join(packageRoot, manifest.pi.extensions[0])), true);
});

test("publish files include runtime defaults, hooks, readme, and license but no personal rules", () => {
  for (const path of [
    "README.md",
    "LICENSE",
    "hooks.json",
    "hooks/secret-guard.mjs",
    "hooks/destructive-command-guard.mjs",
    "hooks/syntax-format-check.mjs",
  ]) {
    assert.equal(existsSync(join(packageRoot, path)), true, path);
  }
  assert.equal(existsSync(join(packageRoot, "rules")), false);
});
