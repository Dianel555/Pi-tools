import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import test from "node:test";

const sourcePath = "packages/pi-workspace-history/.pi/extensions/workspace-history.ts";
const readmePath = "packages/pi-workspace-history/README.md";

test("README documents Pi workspace history settings", async () => {
  const readme = await readFile(readmePath, "utf8");

  for (const setting of [
    "workspaceHistory.storageDir",
    "workspaceHistory.maxSessionsPerWorkspace",
    "workspaceHistory.maxWorkspaces",
    "workspaceHistory.enabled",
    "workspaceHistory.allowHomeDirectory",
    "workspaceHistory.requireProjectMarker",
    "workspaceHistory.maxScanFiles",
    "workspaceHistory.maxScanDirs",
    "workspaceHistory.maxScanMs",
    "workspaceHistory.gitTimeoutMs",
  ]) {
    assert.ok(readme.includes(`\`${setting}\``));
  }

  assert.ok(readme.includes("~/.pi/agent/settings.json"));
  assert.ok(readme.includes(".pi/settings.json"));
  assert.doesNotMatch(readme, /Configure limits via environment variables/);
});

test("rewind reuses Pi tree UI instead of a bespoke picker", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /TreeSelectorComponent/);
  assert.doesNotMatch(source, /class _RewindPicker/);
  assert.doesNotMatch(source, /──────/);
});

test("rewind keeps restore before tree navigation", async () => {
  const source = await readFile(sourcePath, "utf8");
  const restoreIndex = source.indexOf("await restoreResolvedSnapshot(");
  const navigateIndex = source.indexOf("await ctx.navigateTree(targetId, { summarize: false })");

  assert.notEqual(restoreIndex, -1);
  assert.notEqual(navigateIndex, -1);
  assert.ok(restoreIndex < navigateIndex);
});
