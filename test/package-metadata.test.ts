import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageNames = ["pi-hooks-rules", "pi-hud", "pi-workspace-history"];

for (const packageName of packageNames) {
  test(`${packageName} uses the publishable Pi package manifest`, () => {
    const packageRoot = join(repoRoot, "packages", packageName);
    const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));

    assert.equal(manifest.author, "Dianel555");
    assert.equal(manifest.license, "MIT");
    assert.deepEqual(manifest.repository, {
      type: "git",
      url: "git+https://github.com/Dianel555/Pi-tools.git",
      directory: `packages/${packageName}`,
    });
    assert.equal(manifest.engines.node, ">=22.19.0");
    assert.equal(manifest.keywords.includes("pi-package"), true);
    assert.equal(manifest.keywords.includes("pi-coding-agent"), true);
    assert.equal(manifest.keywords.includes("pi-extension"), true);
    assert.equal(manifest.files.includes("README.md"), true);
    assert.equal(manifest.files.includes("LICENSE"), true);
    assert.equal(manifest.files.some((path: string) => path === "assets" || path.startsWith("assets/")), true);
    assert.equal(manifest.publishConfig.access, "public");
    assert.equal(manifest.peerDependencies["@earendil-works/pi-coding-agent"], "*");
    assert.equal(manifest.main, undefined);
    assert.equal(manifest.exports, undefined);
    assert.equal(Array.isArray(manifest.pi.extensions), true);
    assert.equal(existsSync(join(packageRoot, manifest.pi.extensions[0])), true);
    assert.equal(existsSync(join(packageRoot, "LICENSE")), true);
  });
}
