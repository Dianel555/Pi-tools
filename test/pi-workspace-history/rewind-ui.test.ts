import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import workspaceHistoryExtension, {
  collapseCleanExcludeGuards,
  selectPathsTrackedInCommit,
} from "../../packages/pi-workspace-history/.pi/extensions/workspace-history.ts";

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

test("rewind opens its tree picker before waiting for an active agent", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-workspace-history-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  let rewind:
    | {
        handler(
          args: string,
          ctx: ExtensionCommandContext,
        ): Promise<void> | void;
      }
    | undefined;

  try {
    const agentDir = join(cwd, "agent");
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({ workspaceHistory: { enabled: true } }),
    );
    process.env.PI_CODING_AGENT_DIR = agentDir;

    workspaceHistoryExtension({
      on() {},
      registerCommand(name: string, command: typeof rewind) {
        if (name === "rewind") rewind = command;
      },
    } as unknown as ExtensionAPI);

    assert.ok(rewind);
    const calls: string[] = [];
    await rewind.handler("", {
      cwd,
      waitForIdle: async () => {
        calls.push("idle");
      },
      sessionManager: {
        getSessionId: () => "session",
        getTree: () => [{}],
        getLeafId: () => "leaf",
      },
      ui: {
        custom: async () => {
          calls.push("custom");
          return undefined;
        },
        notify() {},
      },
    } as unknown as ExtensionCommandContext);

    assert.equal(calls[0], "custom");
  } finally {
    if (previousAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
    await rm(cwd, { recursive: true, force: true });
  }
});

test("selectPathsTrackedInCommit skips ignored paths absent from the commit tree", () => {
  // The expensive part of a restore is the excluded-path backup round-trip
  // (node_modules/temp can be hundreds of MB). Nothing tracked in the target
  // commit means nothing to back up.
  assert.deepEqual(
    selectPathsTrackedInCommit(
      ["node_modules", "temp", "dist"],
      ["src/index.ts", "package.json"],
    ),
    [],
  );
});

test("selectPathsTrackedInCommit keeps ignored paths the commit would materialize", () => {
  // A path ignored today but snapshotted before the .gitignore rule existed is
  // still tracked in older commits; reset --hard would overwrite the working copy.
  assert.deepEqual(
    selectPathsTrackedInCommit(
      ["node_modules", "dist", "coverage"],
      ["src/index.ts", "dist/out.js", "coverage"],
    ),
    ["dist", "coverage"],
  );
});

test("selectPathsTrackedInCommit matches directories by path segment, not prefix", () => {
  // "dist" must not be considered tracked because of "dist-backup/x".
  assert.deepEqual(
    selectPathsTrackedInCommit(["dist"], ["dist-backup/x.js"]),
    [],
  );
});

test("selectPathsTrackedInCommit normalizes Windows separators", () => {
  assert.deepEqual(
    selectPathsTrackedInCommit(
      ["packages\\app\\dist"],
      ["packages/app/dist/out.js"],
    ),
    ["packages\\app\\dist"],
  );
});

test("selectPathsTrackedInCommit matches an excluded dir via any file beneath it", () => {
  // Only a deep file is tracked; the excluded directory root still needs backing
  // up because reset --hard would recreate that file inside it.
  assert.deepEqual(
    selectPathsTrackedInCommit(["logs"], ["logs/a/b/c.log"]),
    ["logs"],
  );
});

test("restore guards clean -fd with the collapsed excluded set, not the backup subset", async () => {
  const source = await readFile(sourcePath, "utf8");
  const cleanStart = source.indexOf('"clean",');
  assert.notEqual(cleanStart, -1);
  const cleanCall = source.slice(
    cleanStart,
    source.indexOf('".",', cleanStart),
  );

  // The -e guards must cover the full excluded set (collapsed to ancestor roots
  // to stay inside argv), never the narrow backup subset that would delete
  // ignored siblings the target commit does not track.
  assert.match(cleanCall, /cleanGuards\.guards\.flatMap/);
  assert.doesNotMatch(cleanCall, /protectedPaths\.flatMap/);
});

test("collapseCleanExcludeGuards drops descendants covered by an ancestor guard", () => {
  const { guards, dropped } = collapseCleanExcludeGuards(
    ["dist", "dist/a", "dist/a/b.js", "coverage"],
    8_000,
  );
  // `-e dist` already shields everything under dist/, so the descendants are
  // redundant argv. coverage is a separate root and stays.
  assert.deepEqual(guards, ["coverage", "dist"]);
  assert.equal(dropped, 0);
});

test("collapseCleanExcludeGuards drops guards past the argv budget", () => {
  const many = Array.from({ length: 50 }, (_, i) => `dir${i}`);
  const { guards, dropped } = collapseCleanExcludeGuards(many, 20);
  // Tiny budget keeps only what fits; the rest are dropped but still covered by
  // info/exclude, so the drop is safe (and logged by the caller).
  assert.ok(guards.length > 0);
  assert.ok(guards.length < many.length);
  assert.equal(dropped, many.length - guards.length);
});

test("collapseCleanExcludeGuards does not treat a name prefix as an ancestor", () => {
  // "dist-backup" is not under "dist"; both must survive as separate guards.
  const { guards } = collapseCleanExcludeGuards(["dist", "dist-backup"], 8_000);
  assert.deepEqual(guards, ["dist", "dist-backup"]);
});

test("rewind rolls files back when tree navigation does not complete", async () => {
  const source = await readFile(sourcePath, "utf8");
  const doRewind = source.slice(source.indexOf("async function doRewind("));

  // Restore lands on disk before navigateTree; a cancel/throw there would leave
  // the workspace and session tree out of sync unless the files are put back.
  assert.match(doRewind, /rollbackCommit = await restoreResolvedSnapshot\(/);
  assert.match(doRewind, /result\.cancelled[\s\S]*?undoRestoredFiles\(/);
  assert.match(doRewind, /catch \(error\)[\s\S]*?undoRestoredFiles\(/);
});

test("rewind does not roll files back when navigateTree threw after committing the leaf", async () => {
  const source = await readFile(sourcePath, "utf8");
  const doRewind = source.slice(source.indexOf("async function doRewind("));
  const afterNavigate = doRewind.slice(
    doRewind.indexOf("await ctx.navigateTree(targetId"),
  );

  // A post-commit throw is detected via the leaf pointer moving off the
  // pre-navigate leaf; only a pre-commit failure (leaf unchanged) rolls back.
  assert.match(afterNavigate, /getLeafId\(\)\s*!==\s*currentLeafId/);
  // The committed branch returns without calling undoRestoredFiles. Anchor the
  // undo search forward from `if (committed)`, since the cancelled branch above
  // also calls undoRestoredFiles.
  const committedStart = afterNavigate.indexOf("if (committed)");
  const committedBranch = afterNavigate.slice(
    committedStart,
    afterNavigate.indexOf("await undoRestoredFiles(", committedStart),
  );
  assert.notEqual(committedBranch, "");
  assert.doesNotMatch(committedBranch, /undoRestoredFiles\(/);
});

test("rewind reports post-restore failures through a stale-safe notify", async () => {
  const source = await readFile(sourcePath, "utf8");
  const doRewind = source.slice(source.indexOf("async function doRewind("));
  const afterRestore = doRewind.slice(doRewind.indexOf("restoreResolvedSnapshot("));

  // ctx members are guarded getters: a /reload during the restore kills the ctx,
  // so a raw ctx.ui.notify() after that point throws and masks the real outcome.
  assert.doesNotMatch(afterRestore, /ctx\.ui\.notify\(/);
  assert.match(afterRestore, /notifyIfLive\(/);
});

test("README documents the log environment variable, not a settings key", async () => {
  const readme = await readFile(readmePath, "utf8");

  assert.match(readme, /PI_WORKSPACE_HISTORY_LOG/);
  // It is read via process.env, so documenting it as a settings key would be wrong.
  assert.doesNotMatch(readme, /"PI_WORKSPACE_HISTORY_LOG"\s*:/);
});

test("README documents built-in excludes and the excludePatterns setting", async () => {
  const readme = await readFile(readmePath, "utf8");

  assert.match(readme, /workspaceHistory\.excludePatterns/);
  // The whole point of the defaults is that they work with no Git repo present.
  assert.match(readme, /no `\.gitignore` and no Git repository/);
  for (const builtIn of ["temp", "__pycache__", ".venv", "logs"]) {
    assert.match(readme, new RegExp(`\`${builtIn.replace(".", "\\.")}\``));
  }
});

test("extension registers the built-in temp/log excludes for gitignore-less projects", async () => {
  const source = await readFile(sourcePath, "utf8");
  const defaults = source.slice(
    source.indexOf("const DEFAULT_EXCLUDES = ["),
    source.indexOf("];", source.indexOf("const DEFAULT_EXCLUDES = [")),
  );
  // Without these, a project that has no .gitignore snapshots temp/ and logs/
  // into the shadow repo — the regression this change fixes.
  for (const entry of ['"temp"', '"tmp"', '"logs"', '"__pycache__"', '".venv"']) {
    assert.ok(defaults.includes(entry), `DEFAULT_EXCLUDES missing ${entry}`);
  }
});

test("excludePatterns feeds both the ignore matcher and the shadow info/exclude", async () => {
  const source = await readFile(sourcePath, "utf8");
  // Matcher path (used for the filesystem scan).
  assert.match(source, /matcher\.add\(excludePatterns\)/);
  // info/exclude path (used by git clean -fd), so the two agree.
  assert.match(source, /\.\.\.excludePatterns\.map\(normalizeSnapshotPath\)/);
});
