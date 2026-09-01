import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, normalize } from "node:path";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import workspaceHistoryExtension from "../../packages/pi-workspace-history/.pi/extensions/workspace-history.ts";

type ExecResult = {
  code: number;
  stdout: string;
  stderr: string;
};

type ExecMock = (
  command: string,
  args: string[],
  options?: unknown,
) => Promise<ExecResult>;

type Command = {
  handler(
    args: string,
    ctx: ExtensionCommandContext,
  ): Promise<void> | void;
};

type EventHandler = (
  event: unknown,
  ctx: ExtensionCommandContext,
) => Promise<unknown> | unknown;

const baselineEntry = {
  id: "baseline",
  parentId: null,
  type: "custom",
  customType: "workspace-history.snapshot",
  data: {
    v: 1,
    kind: "baseline",
    commit: "base",
    createdAt: "2026-01-01T00:00:00.000Z",
  },
};

function ok(stdout = ""): ExecResult {
  return { code: 0, stdout, stderr: "" };
}

function commandExtension(exec?: ExecMock): {
  commands: Map<string, Command>;
  events: Map<string, EventHandler>;
  calls: string[][];
} {
  const commands = new Map<string, Command>();
  const events = new Map<string, EventHandler>();
  const calls: string[][] = [];
  const pi = {
    on(name: string, handler: EventHandler) {
      events.set(name, handler);
    },
    registerCommand(name: string, command: Command) {
      commands.set(name, command);
    },
    appendEntry() {},
    setLabel() {},
    exec: exec ?? (async () => ok()),
  } as unknown as ExtensionAPI;

  workspaceHistoryExtension(pi);
  return { commands, events, calls };
}

function contextFor(cwd: string, sessionId: string): ExtensionCommandContext {
  const entries = [baselineEntry];
  return {
    cwd,
    sessionManager: {
      getSessionId: () => sessionId,
      getEntries: () => entries,
      getEntry: (id: string) => entries.find((entry) => entry.id === id),
      getLeafId: () => "baseline",
      getTree: () => entries,
      getBranch: () => entries,
    },
    waitForIdle: async () => {},
    ui: {
      notify() {},
    },
  } as unknown as ExtensionCommandContext;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function activeMarkerNames(activeDir: string): Promise<string[]> {
  const entries = await readdir(activeDir, { withFileTypes: true }).catch(
    () => [],
  );
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();
}

async function hasActiveMarker(activeDir: string): Promise<boolean> {
  return (await activeMarkerNames(activeDir)).length > 0;
}

async function shadowGitDir(
  cwd: string,
  storageDir: string,
  sessionId: string,
): Promise<string> {
  const resolved = await realpath(cwd);
  const workspaceHash = createHash("sha256")
    .update(normalize(resolved))
    .digest("hex")
    .slice(0, 24);
  return join(
    storageDir,
    "workspaces",
    workspaceHash,
    "sessions",
    sessionId,
    "repo.git",
  );
}

async function createCheckpointFixture(
  mode: "tracked-nul" | "changing-index" | "invalid-repo",
): Promise<{
  root: string;
  cwd: string;
  storageDir: string;
  shadowDir: string;
  commands: Map<string, Command>;
  calls: string[][];
  pathspecs: string[];
  setTrackedPaths(paths: string): void;
  cleanup(): Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "pi-workspace-history-regression-"));
  const cwd = join(root, "repo");
  const storageDir = join(root, "storage");
  const agentDir = join(root, "agent");
  const sessionId = "session";
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    join(cwd, ".pi", "settings.json"),
    JSON.stringify({
      workspaceHistory: {
        enabled: true,
        storageDir,
      },
    }),
  );

  const shadowDir = await shadowGitDir(cwd, storageDir, sessionId);
  await mkdir(shadowDir, { recursive: true });

  let nulRemoved = false;
  let trackedPaths = mode === "tracked-nul" ? "nul\0" : "";
  let workspaceChanged = false;
  const pathspecs: string[] = [];
  let invalidRepo = mode === "invalid-repo";
  const fixture = commandExtension(async (_command, args) => {
    fixture.calls.push(args);

    if (args.includes("--is-bare-repository")) {
      return invalidRepo ? { code: 1, stdout: "", stderr: "not a repository" } : ok("true\n");
    }
    if (args.includes("ls-files")) {
      return ok(invalidRepo ? "" : trackedPaths);
    }
    if (args.includes("rm") && args.includes("--cached")) {
      const pathspecIndex = args.indexOf("--pathspec-from-file");
      if (pathspecIndex >= 0) {
        pathspecs.push(await readFile(args[pathspecIndex + 1], "utf8"));
      }
      nulRemoved = true;
      return ok();
    }
    if (args.includes("init")) {
      invalidRepo = false;
      await mkdir(shadowDir, { recursive: true });
      return ok();
    }
    if (args.includes("status")) {
      return ok(workspaceChanged ? " M workspace-file\0" : "");
    }
    if (args.includes("add")) {
      if ((trackedPaths.includes("nul") && !nulRemoved) || (mode === "invalid-repo" && invalidRepo)) {
        return { code: 1, stdout: "", stderr: "error: unable to index nul" };
      }
      return ok();
    }
    if (args.includes("rev-parse")) {
      return args.includes("--verify")
        ? { code: 1, stdout: "", stderr: "fatal: ambiguous argument 'HEAD'" }
        : ok("snapshot-commit\n");
    }
    return ok();
  });

  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;

  return {
    root,
    cwd,
    storageDir,
    shadowDir,
    commands: fixture.commands,
    calls: fixture.calls,
    pathspecs,
    setTrackedPaths(paths: string) {
      trackedPaths = paths;
      workspaceChanged = paths.length > 0;
      nulRemoved = false;
    },
    cleanup: async () => {
      if (previousAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      }
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function createReusableFixture(
  mode: "shared-clone" | "dependent-invalid-reusable",
): Promise<{
  root: string;
  cwd: string;
  reusableDir: string;
  shadowDir: string;
  commands: Map<string, Command>;
  calls: string[][];
  cleanup(): Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "pi-workspace-history-reuse-"));
  const cwd = join(root, "repo");
  const storageDir = join(root, "storage");
  const agentDir = join(root, "agent");
  const sessionId = "session";
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    join(cwd, ".pi", "settings.json"),
    JSON.stringify({
      workspaceHistory: {
        enabled: true,
        storageDir,
      },
    }),
  );

  const shadowDir = await shadowGitDir(cwd, storageDir, sessionId);
  const workspaceRoot = dirname(dirname(dirname(shadowDir)));
  const reusableDir = join(workspaceRoot, "repo.git");
  if (mode === "shared-clone") {
    await mkdir(reusableDir, { recursive: true });
  } else {
    await mkdir(reusableDir, { recursive: true });
    const alternateRepo = join(
      workspaceRoot,
      "sessions",
      "other",
      "repo.git",
    );
    await mkdir(join(alternateRepo, "objects", "info"), { recursive: true });
    await writeFile(
      join(alternateRepo, "objects", "info", "alternates"),
      `${reusableDir}\n`,
    );
  }

  let invalidReusable = mode === "dependent-invalid-reusable";
  const fixture = commandExtension(async (_command, args) => {
    fixture.calls.push(args);

    if (args.includes("--is-bare-repository")) {
      const gitDirIndex = args.indexOf("--git-dir");
      const gitDir = gitDirIndex >= 0 ? args[gitDirIndex + 1] : undefined;
      return gitDir === reusableDir && invalidReusable
        ? { code: 1, stdout: "", stderr: "not a repository" }
        : ok("true\n");
    }
    if (args.includes("HEAD^{commit}")) {
      return mode === "shared-clone"
        ? ok("reusable-commit\n")
        : { code: 1, stdout: "", stderr: "no commit" };
    }
    if (args.includes("clone")) {
      if (args.at(-1) === shadowDir) {
        await mkdir(shadowDir, { recursive: true });
      }
      return ok();
    }
    if (args.includes("init")) {
      invalidReusable = false;
      await mkdir(shadowDir, { recursive: true });
      return ok();
    }
    if (args.includes("ls-files") || args.includes("add")) {
      return ok();
    }
    if (args.includes("rev-parse")) {
      return args.includes("--verify")
        ? { code: 1, stdout: "", stderr: "no HEAD" }
        : ok("snapshot-commit\n");
    }
    return ok();
  });

  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;

  return {
    root,
    cwd,
    reusableDir,
    shadowDir,
    commands: fixture.commands,
    calls: fixture.calls,
    cleanup: async () => {
      if (previousAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      }
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("new session clones an independent reusable repository", async () => {
  const fixture = await createReusableFixture("shared-clone");
  try {
    const checkpoint = fixture.commands.get("checkpoint");
    assert.ok(checkpoint);
    await checkpoint.handler("", contextFor(fixture.cwd, "session"));

    const cloneArgs = fixture.calls.find(
      (args) => args.includes("clone") && args.at(-1) === fixture.shadowDir,
    );
    assert.ok(cloneArgs);
    assert.ok(cloneArgs.includes("--no-local"));
    assert.equal(cloneArgs.includes("--shared"), false);
  } finally {
    await fixture.cleanup();
  }
});

test("invalid reusable repositories with dependents are preserved", async () => {
  const fixture = await createReusableFixture("dependent-invalid-reusable");
  try {
    const checkpoint = fixture.commands.get("checkpoint");
    assert.ok(checkpoint);
    await checkpoint.handler("", contextFor(fixture.cwd, "session"));
    assert.equal(await pathExists(fixture.reusableDir), true);
    const siblings = await readdir(dirname(fixture.reusableDir));
    assert.equal(
      siblings.some((name) => name.startsWith("repo.git.invalid-")),
      false,
    );
  } finally {
    await fixture.cleanup();
  }
});

async function waitForStorageLockRelease(storageDir: string): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  const lockPath = join(storageDir, ".lock");
  const deadline = Date.now() + 2_000;
  while (await pathExists(lockPath)) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for storage lock: ${lockPath}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForLogLine(
  logFile: string,
  text: string,
  occurrence = 1,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  for (;;) {
    const source = await readFile(logFile, "utf8").catch(() => "");
    if (source.split(text).length - 1 >= occurrence) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for log line: ${text}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

test("first snapshot removes a tracked nul before staging", async () => {
  const fixture = await createCheckpointFixture("tracked-nul");
  try {
    const checkpoint = fixture.commands.get("checkpoint");
    assert.ok(checkpoint);
    await checkpoint.handler("", contextFor(fixture.cwd, "session"));
    await waitForStorageLockRelease(fixture.storageDir);

    const removeIndex = fixture.calls.findIndex(
      (args) => args.includes("rm") && args.includes("--cached"),
    );
    const addIndex = fixture.calls.findIndex((args) => args.includes("add"));
    assert.ok(removeIndex >= 0);
    assert.ok(addIndex >= 0);
    assert.ok(removeIndex < addIndex);
  } finally {
    await fixture.cleanup();
  }
});

test("a changed shadow index is re-pruned without a gitignore change", async () => {
  const fixture = await createCheckpointFixture("changing-index");
  try {
    const checkpoint = fixture.commands.get("checkpoint");
    assert.ok(checkpoint);
    await checkpoint.handler("", contextFor(fixture.cwd, "session"));

    fixture.setTrackedPaths("nul\0");
    await checkpoint.handler("", contextFor(fixture.cwd, "session"));
    await waitForStorageLockRelease(fixture.storageDir);
  } finally {
    await fixture.cleanup();
  }
});

test("NUL-delimited index output preserves leading whitespace", async () => {
  const fixture = await createCheckpointFixture("changing-index");
  try {
    const checkpoint = fixture.commands.get("checkpoint");
    assert.ok(checkpoint);
    await checkpoint.handler("", contextFor(fixture.cwd, "session"));

    fixture.setTrackedPaths(" nul\0");
    await checkpoint.handler("", contextFor(fixture.cwd, "session"));
    await waitForStorageLockRelease(fixture.storageDir);
    assert.equal(fixture.pathspecs.at(-1), " nul\0");
  } finally {
    await fixture.cleanup();
  }
});

test("invalid shadow repositories are preserved and rebuilt", async () => {
  const fixture = await createCheckpointFixture("invalid-repo");
  try {
    const checkpoint = fixture.commands.get("checkpoint");
    assert.ok(checkpoint);
    await checkpoint.handler("", contextFor(fixture.cwd, "session"));
    await waitForStorageLockRelease(fixture.storageDir);

    assert.equal(await pathExists(fixture.shadowDir), true);
    const siblings = await readdir(dirname(fixture.shadowDir));
    assert.ok(siblings.some((name) => name.startsWith("repo.git.invalid-")));
  } finally {
    await fixture.cleanup();
  }
});

test("retention does not remove a live session from another Pi context", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workspace-history-retention-"));
  const cwd = join(root, "repo");
  const storageDir = join(root, "storage");
  const agentDir = join(root, "agent");
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    join(cwd, ".pi", "settings.json"),
    JSON.stringify({
      workspaceHistory: {
        enabled: true,
        storageDir,
        maxSessionsPerWorkspace: 1,
      },
    }),
  );

  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousLogSetting = process.env.PI_WORKSPACE_HISTORY_LOG;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_WORKSPACE_HISTORY_LOG = "1";
  const logFile = join(storageDir, "logs", "timemachine.log");
  const extension = commandExtension();
  const sessionStart = extension.events.get("session_start");
  const sessionShutdown = extension.events.get("session_shutdown");
  assert.ok(sessionStart);
  assert.ok(sessionShutdown);

  try {
    const contextA = contextFor(cwd, "session-a");
    const contextB = contextFor(cwd, "session-b");
    const contextC = contextFor(cwd, "session-c");
    const shadowA = await shadowGitDir(cwd, storageDir, "session-a");
    const staleTombstone = join(dirname(dirname(shadowA)), ".deleting-stale");
    await mkdir(staleTombstone, { recursive: true });

    await sessionStart({}, contextA);
    await waitForLogLine(logFile, "cleanup done session=session-a");
    const activeDir = shadowA.replace(/repo\.git$/, ".active");
    assert.equal(await hasActiveMarker(activeDir), true);
    assert.equal(await pathExists(staleTombstone), true);

    await sessionStart({}, contextB);
    await waitForLogLine(logFile, "cleanup done session=session-b");
    assert.equal(await pathExists(dirname(shadowA)), true);
    assert.equal(await pathExists(staleTombstone), true);

    await sessionShutdown({}, contextA);
    assert.equal(
      await hasActiveMarker(shadowA.replace(/repo\.git$/, ".active")),
      false,
    );

    await sessionStart({}, contextC);
    await waitForLogLine(logFile, "cleanup done session=session-c");
    assert.equal(await pathExists(dirname(shadowA)), false);
    assert.equal(await pathExists(staleTombstone), true);
    await sessionShutdown({}, contextB);
    await sessionShutdown({}, contextC);
  } finally {
    if (previousAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
    if (previousLogSetting === undefined) {
      delete process.env.PI_WORKSPACE_HISTORY_LOG;
    } else {
      process.env.PI_WORKSPACE_HISTORY_LOG = previousLogSetting;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("one same-session shutdown does not clear another owner's marker", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workspace-history-owner-"));
  const cwd = join(root, "repo");
  const storageDir = join(root, "storage");
  const agentDir = join(root, "agent");
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    join(cwd, ".pi", "settings.json"),
    JSON.stringify({
      workspaceHistory: {
        enabled: true,
        storageDir,
        maxSessionsPerWorkspace: 1,
      },
    }),
  );

  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousLogSetting = process.env.PI_WORKSPACE_HISTORY_LOG;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_WORKSPACE_HISTORY_LOG = "1";
  const logFile = join(storageDir, "logs", "timemachine.log");
  const ownerA = commandExtension();
  const ownerB = commandExtension();
  const cleaner = commandExtension();
  const startA = ownerA.events.get("session_start");
  const startB = ownerB.events.get("session_start");
  const shutdownA = ownerA.events.get("session_shutdown");
  const shutdownB = ownerB.events.get("session_shutdown");
  const startCleaner = cleaner.events.get("session_start");
  const shutdownCleaner = cleaner.events.get("session_shutdown");
  assert.ok(startA);
  assert.ok(startB);
  assert.ok(shutdownA);
  assert.ok(shutdownB);
  assert.ok(startCleaner);
  assert.ok(shutdownCleaner);

  try {
    const ownerContextA = contextFor(cwd, "same-session");
    const ownerContextB = contextFor(cwd, "same-session");
    const cleanerContext = contextFor(cwd, "cleaner");
    const shadow = await shadowGitDir(cwd, storageDir, "same-session");
    const activeMarker = shadow.replace(/repo\.git$/, ".active");

    await startA({}, ownerContextA);
    await waitForLogLine(logFile, "cleanup done session=same-session");
    const markersA = await activeMarkerNames(activeMarker);
    assert.equal(markersA.length, 1);

    await startB({}, ownerContextB);
    await waitForLogLine(logFile, "cleanup done session=same-session", 2);
    const markersB = await activeMarkerNames(activeMarker);
    assert.equal(markersB.length, 2);
    assert.ok(markersB.includes(markersA[0]));

    await shutdownA({}, ownerContextA);
    assert.deepEqual(
      await activeMarkerNames(activeMarker),
      markersB.filter((marker) => marker !== markersA[0]),
    );

    await startCleaner({}, cleanerContext);
    await waitForLogLine(logFile, "cleanup done session=cleaner");
    assert.equal(await pathExists(dirname(shadow)), true);
    await shutdownB({}, ownerContextB);
    await shutdownCleaner({}, cleanerContext);
  } finally {
    if (previousAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
    if (previousLogSetting === undefined) {
      delete process.env.PI_WORKSPACE_HISTORY_LOG;
    } else {
      process.env.PI_WORKSPACE_HISTORY_LOG = previousLogSetting;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("stale markers from a reused PID do not keep history forever", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workspace-history-stale-marker-"));
  const cwd = join(root, "repo");
  const storageDir = join(root, "storage");
  const agentDir = join(root, "agent");
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    join(cwd, ".pi", "settings.json"),
    JSON.stringify({
      workspaceHistory: {
        enabled: true,
        storageDir,
        maxSessionsPerWorkspace: 1,
      },
    }),
  );

  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousLogSetting = process.env.PI_WORKSPACE_HISTORY_LOG;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_WORKSPACE_HISTORY_LOG = "1";
  const logFile = join(storageDir, "logs", "timemachine.log");
  const extension = commandExtension();
  const sessionStart = extension.events.get("session_start");
  const sessionShutdown = extension.events.get("session_shutdown");
  assert.ok(sessionStart);
  assert.ok(sessionShutdown);

  try {
    const contextA = contextFor(cwd, "session-a");
    const contextB = contextFor(cwd, "session-b");
    const contextC = contextFor(cwd, "session-c");
    const shadowA = await shadowGitDir(cwd, storageDir, "session-a");
    const shadowB = await shadowGitDir(cwd, storageDir, "session-b");
    const activeDir = shadowA.replace(/repo\.git$/, ".active");
    const sessionRoot = dirname(activeDir);

    await sessionStart({}, contextA);
    await waitForLogLine(logFile, "cleanup done session=session-a");
    await sessionShutdown({}, contextA);
    await writeFile(
      join(sessionRoot, ".active.json"),
      JSON.stringify({
        version: 1,
        pid: process.pid,
        sessionId: "session-a",
        startedAt: new Date().toISOString(),
      }),
    );

    await sessionStart({}, contextB);
    await waitForLogLine(logFile, "cleanup done session=session-b");
    assert.equal(await pathExists(dirname(shadowA)), true);
    await sessionShutdown({}, contextB);
    await rm(dirname(shadowB), { recursive: true, force: true });
    await writeFile(
      join(activeDir, "stale.json"),
      JSON.stringify({
        version: 1,
        pid: process.pid,
        processStartedAt: 0,
        sessionId: "session-a",
        token: "stale",
        startedAt: "2020-01-01T00:00:00.000Z",
        heartbeatAt: "2020-01-01T00:00:00.000Z",
      }),
    );
    await writeFile(
      join(sessionRoot, ".active.json"),
      JSON.stringify({
        version: 1,
        pid: process.pid,
        sessionId: "session-a",
        startedAt: "2020-01-01T00:00:00.000Z",
      }),
    );

    await sessionStart({}, contextC);
    await waitForLogLine(logFile, "cleanup done session=session-c");
    assert.equal(await pathExists(dirname(shadowA)), false);
    await sessionShutdown({}, contextC);
  } finally {
    if (previousAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
    if (previousLogSetting === undefined) {
      delete process.env.PI_WORKSPACE_HISTORY_LOG;
    } else {
      process.env.PI_WORKSPACE_HISTORY_LOG = previousLogSetting;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("retention does not remove a live workspace from another Pi context", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workspace-history-workspace-retention-"));
  const cwdA = join(root, "repo-a");
  const cwdB = join(root, "repo-b");
  const storageDir = join(root, "storage");
  const agentDir = join(root, "agent");
  await mkdir(join(cwdA, ".pi"), { recursive: true });
  await mkdir(join(cwdB, ".pi"), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  const settings = JSON.stringify({
    workspaceHistory: {
      enabled: true,
      storageDir,
      maxWorkspaces: 1,
    },
  });
  await writeFile(join(cwdA, ".pi", "settings.json"), settings);
  await writeFile(join(cwdB, ".pi", "settings.json"), settings);

  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousLogSetting = process.env.PI_WORKSPACE_HISTORY_LOG;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_WORKSPACE_HISTORY_LOG = "1";
  const logFile = join(storageDir, "logs", "timemachine.log");
  const extension = commandExtension();
  const sessionStart = extension.events.get("session_start");
  const sessionShutdown = extension.events.get("session_shutdown");
  assert.ok(sessionStart);
  assert.ok(sessionShutdown);

  try {
    const contextA = contextFor(cwdA, "session-a");
    const contextB = contextFor(cwdB, "session-b");
    const contextC = contextFor(cwdB, "session-c");
    const shadowA = await shadowGitDir(cwdA, storageDir, "session-a");
    const workspaceA = dirname(dirname(dirname(shadowA)));

    await sessionStart({}, contextA);
    await waitForLogLine(logFile, "cleanup done session=session-a");
    assert.equal(
      await hasActiveMarker(shadowA.replace(/repo\.git$/, ".active")),
      true,
    );

    await sessionStart({}, contextB);
    await waitForLogLine(logFile, "cleanup done session=session-b");
    assert.equal(await pathExists(workspaceA), true);

    await sessionShutdown({}, contextA);
    await sessionStart({}, contextC);
    await waitForLogLine(logFile, "cleanup done session=session-c");
    assert.equal(await pathExists(workspaceA), false);
    await sessionShutdown({}, contextB);
    await sessionShutdown({}, contextC);
  } finally {
    if (previousAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
    if (previousLogSetting === undefined) {
      delete process.env.PI_WORKSPACE_HISTORY_LOG;
    } else {
      process.env.PI_WORKSPACE_HISTORY_LOG = previousLogSetting;
    }
    await rm(root, { recursive: true, force: true });
  }
});
