import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const packageRoot = join(process.cwd(), "packages", "pi-workspace-history");
const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));

test("package manifest exposes the workspace history extension", () => {
  assert.equal(manifest.name, "pi-workspace-history");
  assert.equal(manifest.pi.extension, undefined);
  assert.deepEqual(manifest.pi.extensions, ["./.pi/extensions/workspace-history.ts"]);
  assert.equal(existsSync(join(packageRoot, manifest.pi.extensions[0])), true);
});
