import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

// The extension resolves the agent directory at import time, so isolate it before importing.
const root = mkdtempSync(join(tmpdir(), "pi-hooks-rules-events-"));
const agentDir = join(root, "agent");
const cwd = join(root, "project");
mkdirSync(agentDir, { recursive: true });
mkdirSync(cwd, { recursive: true });
const script = join(root, "hook.mjs");
// Logs each payload as one JSON line, then allows, denies, adds context, or exits as asked.
writeFileSync(
  script,
  [
    'import { appendFileSync } from "node:fs";',
    'let input = "";',
    'process.stdin.setEncoding("utf8").on("data", (chunk) => (input += chunk)).on("end", () => {',
    "  const [log, mode, value] = process.argv.slice(2);",
    '  appendFileSync(log, input + "\\n");',
    '  if (mode === "deny") process.stdout.write(JSON.stringify({ decision: "block", reason: value }));',
    '  else if (mode === "context") process.stdout.write(JSON.stringify({ hookSpecificOutput: { additionalContext: value } }));',
    '  else if (mode === "exit") process.exit(Number(value));',
    "});",
  ].join("\n"),
);
process.env.PI_CODING_AGENT_DIR = agentDir;
after(() => rmSync(root, { recursive: true, force: true }));

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;
type HookSpec = { event: string; mode: "allow" | "deny" | "context" | "exit"; value?: string };
let configCount = 0;

async function setup(specs: HookSpec[]) {
  const log = join(root, `payloads-${++configCount}.jsonl`);
  writeFileSync(
    join(agentDir, "hooks-rules.json"),
    JSON.stringify({
      version: 1,
      hooks: specs.map((spec, index) => ({
        id: `hook-${index}`,
        event: spec.event,
        command: "${node}",
        args: [script, log, spec.mode, spec.value ?? "-"],
      })),
    }),
  );
  const { default: hooksAndRulesExtension } = await import("../../packages/pi-hooks-rules/index.ts");
  const handlers = new Map<string, Handler>();
  hooksAndRulesExtension({
    registerCommand() {},
    on(name: string, handler: Handler) {
      handlers.set(name, handler);
    },
  } as never);
  const notices: Array<{ message: string; level: string }> = [];
  const ctx = {
    cwd,
    mode: "print",
    signal: undefined,
    isProjectTrusted: () => false,
    ui: {
      setStatus() {},
      notify(message: string, level: string) {
        notices.push({ message, level });
      },
    },
  };
  const emit = (name: string, event: Record<string, unknown> = {}) => handlers.get(name)!({ type: name, ...event }, ctx);
  const payloads = (): Array<Record<string, any>> =>
    existsSync(log)
      ? readFileSync(log, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  await emit("session_start", { reason: "startup" });
  return { emit, notices, payloads };
}

const settleEvent = (entries: unknown[] = [], outcome = "completed") => ({
  outcome,
  entries,
  continue: false,
  context: {},
});

test("input hooks receive the prompt and can block it", async () => {
  const { emit, notices, payloads } = await setup([{ event: "input", mode: "deny", value: "no secrets in prompts" }]);
  assert.deepEqual(await emit("input", { text: "hello", source: "interactive" }), { action: "handled" });
  assert.match(notices.at(-1)?.message ?? "", /no secrets in prompts/);
  const [payload] = payloads();
  assert.equal(payload.hook_event_name, "input");
  assert.equal(payload.prompt, "hello");
  assert.equal(payload.source, "interactive");
  assert.equal(payload.cwd, cwd);
});

test("failing gate hooks block input", async () => {
  const { emit, notices } = await setup([{ event: "input", mode: "exit", value: "4" }]);
  assert.deepEqual(await emit("input", { text: "hello", source: "interactive" }), { action: "handled" });
  assert.match(notices.at(-1)?.message ?? "", /hook-0 failed with exit 4/);
});

test("allowing lifecycle hooks pass events through unchanged", async () => {
  const { emit, payloads } = await setup([
    { event: "input", mode: "allow" },
    { event: "user_bash", mode: "allow" },
    { event: "session_before_compact", mode: "allow" },
  ]);
  assert.equal(await emit("input", { text: "hello", source: "interactive" }), undefined);
  assert.equal(await emit("user_bash", { command: "ls", excludeFromContext: false, cwd }), undefined);
  assert.equal(
    await emit("session_before_compact", { reason: "manual", willRetry: false, signal: new AbortController().signal }),
    undefined,
  );
  assert.deepEqual(
    payloads().map((payload) => payload.hook_event_name),
    ["input", "user_bash", "session_before_compact"],
  );
});

test("user_bash hooks see a Bash tool envelope and can block the command", async () => {
  const { emit, payloads } = await setup([{ event: "user_bash", mode: "deny", value: "recursive delete" }]);
  const result = (await emit("user_bash", { command: "rm -rf data", excludeFromContext: true, cwd })) as {
    result?: { output: string; exitCode: number; cancelled: boolean; truncated: boolean };
  };
  assert.equal(result.result?.exitCode, 1);
  assert.equal(result.result?.cancelled, false);
  assert.equal(result.result?.truncated, false);
  assert.match(result.result?.output ?? "", /recursive delete/);
  const [payload] = payloads();
  assert.equal(payload.tool_name, "Bash");
  assert.deepEqual(payload.tool_input, { command: "rm -rf data" });
  assert.equal(payload.exclude_from_context, true);
});

test("session_before_compact hooks can cancel compaction", async () => {
  const { emit, notices, payloads } = await setup([
    { event: "session_before_compact", mode: "deny", value: "keep full history" },
  ]);
  const result = await emit("session_before_compact", {
    reason: "threshold",
    willRetry: true,
    signal: new AbortController().signal,
  });
  assert.deepEqual(result, { cancel: true });
  assert.match(notices.at(-1)?.message ?? "", /keep full history/);
  const [payload] = payloads();
  assert.equal(payload.reason, "threshold");
  assert.equal(payload.will_retry, true);
});

test("agent_before_settle hooks continue the run with their reason at most three times per run", async () => {
  const { emit, notices, payloads } = await setup([
    { event: "agent_before_settle", mode: "deny", value: "tests are failing" },
  ]);
  const prior = { type: "custom", customType: "other-extension" };
  const continued = {
    entries: [
      prior,
      { type: "custom_message", customType: "hooks-rules-continue", content: "tests are failing", display: true },
    ],
    continue: true,
  };
  for (let index = 0; index < 3; index += 1) {
    assert.deepEqual(await emit("agent_before_settle", settleEvent([prior])), continued);
  }
  assert.equal(await emit("agent_before_settle", settleEvent([prior])), undefined);
  assert.match(notices.at(-1)?.message ?? "", /continuation limit/);
  assert.deepEqual(
    payloads().map((payload) => payload.stop_hook_active),
    [false, true, true],
  );

  await emit("agent_settled");
  assert.deepEqual(await emit("agent_before_settle", settleEvent([prior])), continued);
  assert.equal(payloads().at(-1)?.stop_hook_active, false);
});

test("agent_before_settle ignores aborted runs and hooks without a reason", async () => {
  const { emit, notices, payloads } = await setup([{ event: "agent_before_settle", mode: "deny", value: "" }]);
  assert.equal(await emit("agent_before_settle", settleEvent([], "aborted")), undefined);
  assert.equal(payloads().length, 0);
  assert.equal(await emit("agent_before_settle", settleEvent()), undefined);
  assert.equal(payloads().length, 1);
  assert.match(notices.at(-1)?.message ?? "", /without a reason/);
});

test("agent_before_settle does not continue when the hook fails", async () => {
  const { emit, notices } = await setup([{ event: "agent_before_settle", mode: "exit", value: "2" }]);
  assert.equal(await emit("agent_before_settle", settleEvent()), undefined);
  assert.match(notices.at(-1)?.message ?? "", /hook-0 failed with exit 2/);
});

test("session_start context is injected once and before_agent_start context on every run", async () => {
  const { emit, payloads } = await setup([
    { event: "session_start", mode: "context", value: "repo is on branch main" },
    { event: "before_agent_start", mode: "context", value: "today is Monday" },
  ]);
  const start = () =>
    emit("before_agent_start", { prompt: "hi", systemPrompt: "BASE", systemPromptOptions: { sections: {} } });
  assert.deepEqual(await start(), {
    message: {
      customType: "hooks-rules-context",
      content: "repo is on branch main\n\ntoday is Monday",
      display: false,
    },
  });
  assert.deepEqual(await start(), {
    message: { customType: "hooks-rules-context", content: "today is Monday", display: false },
  });
  const [sessionStart, agentStart] = payloads();
  assert.equal(sessionStart.hook_event_name, "session_start");
  assert.equal(sessionStart.reason, "startup");
  assert.equal(agentStart.hook_event_name, "before_agent_start");
  assert.equal(agentStart.prompt, "hi");
});

test("session_shutdown hooks receive the reason and report failures", async () => {
  const { emit, notices, payloads } = await setup([{ event: "session_shutdown", mode: "exit", value: "5" }]);
  assert.equal(await emit("session_shutdown", { reason: "quit" }), undefined);
  assert.match(notices.at(-1)?.message ?? "", /hook-0 failed with exit 5/);
  assert.equal(payloads()[0]?.reason, "quit");
});
