import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import hooksAndRulesExtension, {
  collectRules,
  countLoadedRules,
  denialReason,
  hasProjectTrustMarker,
  matchesHook,
  matchesRulePath,
  mergeHookSources,
  parseHookResult,
  readHookFile,
  validateHook,
} from "../../packages/pi-hooks-rules/index.ts";

test("validates and normalizes hook definitions", () => {
  assert.deepEqual(
    validateHook(
      {
        id: "guard",
        event: "tool_call",
        tools: ["Bash"],
        command: "bash",
      },
      "test",
    ),
    {
      id: "guard",
      event: "tool_call",
      tools: ["bash"],
      command: "bash",
      args: [],
      timeoutMs: 5000,
      enabled: true,
    },
  );
  assert.throws(() => validateHook({ id: "bad id" }, "test"), /hook id/);
});

test("parses hook decisions after diagnostic output", () => {
  const result = parseHookResult('diagnostic\n{"decision":"block","reason":"no"}');
  assert.equal(denialReason(result), "no");
  assert.equal(
    denialReason({
      hookSpecificOutput: {
        permissionDecision: "deny",
        permissionDecisionReason: "secret",
      },
    }),
    "secret",
  );
});

test("matches enabled hooks by event and tool", () => {
  const hook = {
    id: "guard",
    event: "tool_call" as const,
    tools: ["bash"],
    command: "bash",
    enabled: true,
    scope: "default" as const,
    configPath: "hooks.json",
    configDir: ".",
    isBundled: true,
  };
  assert.equal(matchesHook(hook, "tool_call", "BASH"), true);
  assert.equal(matchesHook(hook, "tool_result", "bash"), false);
  assert.equal(matchesHook({ ...hook, enabled: false }, "tool_call", "bash"), false);
});

test("counts always-on and injected path-scoped rules", () => {
  const rules = [
    { path: "always.md", content: "always" },
    { path: "openspec.md", content: "openspec", paths: ["openspec/**"] },
  ];
  assert.equal(countLoadedRules(rules, new Set()), 1);
  assert.equal(countLoadedRules(rules, new Set(["openspec.md"])), 2);
});

test("enabled-only overrides preserve upgraded bundled definitions", () => {
  const bundled = validateHook(
    { id: "guard", event: "tool_call", tools: ["bash", "write"], command: "new-command", timeoutMs: 9000 },
    "bundled",
  );
  const [merged] = mergeHookSources([
    { scope: "default", path: "/package/hooks.json", file: { version: 1, hooks: [bundled], overrides: {} } },
    {
      scope: "global",
      path: "/user/hooks-rules.json",
      file: { version: 1, hooks: [], overrides: { guard: { enabled: false } } },
    },
  ]);
  assert.equal(merged.command, "new-command");
  assert.deepEqual(merged.tools, ["bash", "write"]);
  assert.equal(merged.timeoutMs, 9000);
  assert.equal(merged.enabled, false);
  assert.equal(merged.isBundled, true);
});

test("loads global rules and gates project rules behind trust markers", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-hooks-rules-"));
  try {
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    mkdirSync(join(agentDir, "rules"), { recursive: true });
    mkdirSync(join(cwd, ".pi", "rules"), { recursive: true });
    writeFileSync(join(agentDir, "rules", "global.md"), "global rule\n");
    writeFileSync(join(cwd, ".pi", "rules", "project.md"), "project rule\n");

    assert.deepEqual(collectRules(cwd, false, { agentDir }).map((rule) => rule.content), ["global rule"]);
    writeFileSync(
      join(agentDir, "rules", "openspec.md"),
      '---\npaths:\n  - "openspec/**"\n  - "**/openspec/**"\n---\nOpenSpec rule\n',
    );
    const scopedRule = collectRules(cwd, false, { agentDir }).find((rule) => rule.content === "OpenSpec rule");
    assert.deepEqual(scopedRule?.paths, ["openspec/**", "**/openspec/**"]);
    assert.equal(scopedRule?.content, "OpenSpec rule");
    assert.equal(matchesRulePath("openspec/changes/task.md", scopedRule?.paths ?? []), true);
    assert.equal(matchesRulePath("src/openspec/changes/task.md", scopedRule?.paths ?? []), true);
    assert.equal(matchesRulePath("openspec\\changes\\task.md", scopedRule?.paths ?? []), true);
    assert.equal(matchesRulePath("src/index.ts", scopedRule?.paths ?? []), false);
    writeFileSync(join(agentDir, "rules", "flow.md"), '---\npaths: ["src/{api,web}/**"] # comment\n---\nFlow rule\n');
    const flowRule = collectRules(cwd, false, { agentDir }).find((rule) => rule.content === "Flow rule");
    assert.deepEqual(flowRule?.paths, ["src/{api,web}/**"]);
    assert.equal(matchesRulePath("src/api/index.ts", flowRule?.paths ?? []), true);
    assert.equal(matchesRulePath("src/web/index.ts", flowRule?.paths ?? []), true);
    writeFileSync(join(agentDir, "rules", "shared-global.md"), "Shared rule\n");
    writeFileSync(join(agentDir, "rules", "shared-docs.md"), '---\npaths: ["docs/**"]\n---\nShared rule\n');
    writeFileSync(join(agentDir, "rules", "shared-src.md"), '---\npaths: ["src/**"]\n---\nShared rule\n');
    const sharedRules = collectRules(cwd, false, { agentDir }).filter((rule) => rule.content === "Shared rule");
    assert.equal(sharedRules.length, 3);
    assert.equal(sharedRules.some((rule) => !rule.paths), true);
    assert.equal(matchesRulePath("docs/readme.md", sharedRules.find((rule) => rule.paths?.[0] === "docs/**")?.paths ?? []), true);
    assert.equal(matchesRulePath("src/index.ts", sharedRules.find((rule) => rule.paths?.[0] === "src/**")?.paths ?? []), true);
    assert.equal(collectRules(cwd, true, { agentDir }).some((rule) => rule.content === "project rule"), true);
    assert.equal(hasProjectTrustMarker(cwd), false);
    mkdirSync(join(root, ".agents", "skills"), { recursive: true });
    assert.equal(hasProjectTrustMarker(cwd), true);
    rmSync(join(root, ".agents"), { recursive: true });
    assert.equal(hasProjectTrustMarker(cwd), false);
    writeFileSync(join(cwd, ".pi", "settings.json"), "{}\n");
    assert.equal(hasProjectTrustMarker(cwd), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reads optional configuration and registers Pi surfaces", () => {
  assert.deepEqual(readHookFile(join(tmpdir(), "missing-pi-hooks.json"), true), {
    version: 1,
    hooks: [],
    overrides: {},
  });

  const commands = new Map<string, unknown>();
  const events: string[] = [];
  hooksAndRulesExtension({
    registerCommand(name: string, definition: unknown) {
      commands.set(name, definition);
    },
    on(name: string) {
      events.push(name);
    },
  } as never);

  assert.equal(commands.has("hooks"), true);
  assert.deepEqual(events, ["session_start", "before_agent_start", "tool_call", "tool_result"]);
});
