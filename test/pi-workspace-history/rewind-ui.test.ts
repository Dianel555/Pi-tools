import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import workspaceHistoryExtension from "../../packages/pi-workspace-history/.pi/extensions/workspace-history.ts";

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
