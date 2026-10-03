import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import test, { after } from "node:test";

// The extension resolves the agent directory at import time, so isolate it before importing.
const root = mkdtempSync(join(tmpdir(), "pi-hooks-rules-lifecycle-"));
const agentDir = join(root, "agent");
const cwd = join(root, "project");
mkdirSync(join(agentDir, "rules"), { recursive: true });
mkdirSync(cwd, { recursive: true });
writeFileSync(join(agentDir, "rules", "global.md"), "Always cite sources.\n");
writeFileSync(join(agentDir, "rules", "docs.md"), '---\npaths: ["docs/**"]\n---\nDocs rule.\n');
writeFileSync(
  join(agentDir, "rules", "openspec.md"),
  '---\npaths: ["openspec/**", "**/openspec/**"]\n---\nOpenSpec rule.\n',
);
writeFileSync(
  join(agentDir, "hooks-rules.json"),
  JSON.stringify({
    version: 1,
    hooks: [
      {
        id: "failing-result-hook",
        event: "tool_result",
        tools: ["bash"],
        command: "${node}",
        args: ["-e", "process.exit(3)"],
      },
    ],
  }),
);
process.env.PI_CODING_AGENT_DIR = agentDir;
after(() => rmSync(root, { recursive: true, force: true }));

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

async function loadExtension() {
  const { default: hooksAndRulesExtension } = await import("../../packages/pi-hooks-rules/index.ts");
  const handlers = new Map<string, Handler>();
  hooksAndRulesExtension({
    registerCommand() {},
    on(name: string, handler: Handler) {
      handlers.set(name, handler);
    },
  } as never);
  const ctx = {
    cwd,
    mode: "print",
    signal: undefined,
    isProjectTrusted: () => false,
    ui: { setStatus() {}, notify() {} },
  };
  await handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx);
  return { handlers, ctx };
}

test("unscoped rules are added as a prompt section instead of forcing the whole system prompt", async () => {
  const { handlers, ctx } = await loadExtension();
  const sections: Record<string, string> = {};
  const result = await handlers.get("before_agent_start")!(
    { type: "before_agent_start", prompt: "hi", systemPrompt: "BASE", systemPromptOptions: { sections } },
    ctx,
  );
  assert.equal(result, undefined);
  assert.match(sections.auto_loaded_rules ?? "", /Always cite sources\./);
});

test("rules are appended when an earlier handler already forced the system prompt", async () => {
  const { handlers, ctx } = await loadExtension();
  const sections: Record<string, string> = {};
  // An earlier extension returned systemPrompt, so Pi set forceSystemPrompt and ignores sections.
  const result = (await handlers.get("before_agent_start")!(
    {
      type: "before_agent_start",
      prompt: "hi",
      systemPrompt: "FORCED",
      systemPromptOptions: { sections, forceSystemPrompt: "FORCED" },
    },
    ctx,
  )) as { systemPrompt?: string } | undefined;
  assert.match(result?.systemPrompt ?? "", /^FORCED\n\n## Auto-loaded Rules\n\n[\s\S]*Always cite sources\./);
  assert.equal(sections.auto_loaded_rules, undefined);
});

test("tool_result keeps structuredContent when rules or hook failures are appended", async () => {
  const { handlers, ctx } = await loadExtension();
  const structuredContent = { output: "ok", exitCode: 0 };

  const failed = (await handlers.get("tool_result")!(
    {
      type: "tool_result",
      toolName: "bash",
      input: { command: "echo ok" },
      content: [{ type: "text", text: "ok" }],
      structuredContent,
      isError: false,
    },
    ctx,
  )) as { content?: Array<{ text: string }>; isError?: boolean; structuredContent?: unknown } | undefined;
  assert.equal(failed?.isError, true);
  assert.match(failed?.content?.at(-1)?.text ?? "", /failing-result-hook failed with exit 3/);
  assert.deepEqual(failed?.structuredContent, structuredContent);

  const scoped = (await handlers.get("tool_result")!(
    {
      type: "tool_result",
      toolName: "read",
      input: { path: "docs/guide.md" },
      content: [{ type: "text", text: "guide" }],
      structuredContent,
      isError: false,
    },
    ctx,
  )) as { content?: Array<{ text: string }>; structuredContent?: unknown } | undefined;
  assert.match(scoped?.content?.at(-1)?.text ?? "", /Docs rule\./);
  assert.deepEqual(scoped?.structuredContent, structuredContent);
});

test("path-scoped OpenSpec rules load when Pi starts inside the openspec directory", async () => {
  const { handlers, ctx } = await loadExtension();
  const openspecCwd = join(root, "openspec");
  mkdirSync(openspecCwd, { recursive: true });
  const openspecContext = { ...ctx, cwd: openspecCwd };
  await handlers.get("session_start")!({ type: "session_start", reason: "startup" }, openspecContext);
  const promptSections: Record<string, string> = {};
  await handlers.get("before_agent_start")!(
    { type: "before_agent_start", prompt: "start", systemPrompt: "BASE", systemPromptOptions: { sections: promptSections } },
    openspecContext,
  );
  assert.doesNotMatch(promptSections.auto_loaded_rules ?? "", /OpenSpec rule\./);

  if (process.platform === "win32") {
    const otherDrive = openspecCwd[0]?.toLowerCase() === "c" ? "D:" : "C:";
    const outside = await handlers.get("tool_result")!(
      {
        type: "tool_result",
        toolName: "read",
        input: { path: `${otherDrive}/openspec/changes/tasks.md` },
        content: [{ type: "text", text: "outside" }],
        isError: false,
      },
      openspecContext,
    );
    assert.equal(outside, undefined, "scoped rules must not match files on another drive");
  }

  const result = (await handlers.get("tool_result")!(
    {
      type: "tool_result",
      toolName: "read",
      input: { path: "changes/add-feature/tasks.md" },
      content: [{ type: "text", text: "task list" }],
      isError: false,
    },
    openspecContext,
  )) as { content?: Array<{ text: string }> } | undefined;
  assert.match(result?.content?.at(-1)?.text ?? "", /OpenSpec rule\./);
});

test("path-scoped rules reject a parent-directory read outside cwd", async () => {
  const { handlers, ctx } = await loadExtension();
  const nestedCwd = join(root, "openspec", "changes", "nested");
  mkdirSync(nestedCwd, { recursive: true });
  const nestedContext = { ...ctx, cwd: nestedCwd };
  await handlers.get("session_start")!({ type: "session_start", reason: "startup" }, nestedContext);

  for (const path of ["..", "../outside.md"]) {
    const result = await handlers.get("tool_result")!(
      {
        type: "tool_result",
        toolName: "read",
        input: { path },
        content: [{ type: "text", text: "outside cwd" }],
        isError: false,
      },
      nestedContext,
    );
    assert.equal(result, undefined, `path ${path} must not match outside cwd`);
  }
});

test("path-scoped rules reject another drive root on Windows", async () => {
  if (process.platform !== "win32") return;
  const catchAllRule = join(agentDir, "rules", "catch-all.md");
  writeFileSync(catchAllRule, '---\npaths: ["**"]\n---\nCatch-all rule.\n');
  try {
    const { handlers, ctx } = await loadExtension();
    const otherDrive = ctx.cwd[0]?.toLowerCase() === "c" ? "D:" : "C:";
    await handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx);
    const result = await handlers.get("tool_result")!(
      {
        type: "tool_result",
        toolName: "read",
        input: { path: `${otherDrive}/` },
        content: [{ type: "text", text: "other drive root" }],
        isError: false,
      },
      ctx,
    );
    assert.equal(result, undefined);
  } finally {
    rmSync(catchAllRule, { force: true });
  }
});

test("path-scoped rules match when cwd is below the filesystem root", async () => {
  const { handlers, ctx } = await loadExtension();
  const rootOpenSpecCwd = join(parse(cwd).root, "openspec");
  const rootContext = { ...ctx, cwd: rootOpenSpecCwd };
  await handlers.get("session_start")!({ type: "session_start", reason: "startup" }, rootContext);

  const result = (await handlers.get("tool_result")!(
    {
      type: "tool_result",
      toolName: "read",
      input: { path: "changes/tasks.md" },
      content: [{ type: "text", text: "task list" }],
      isError: false,
    },
    rootContext,
  )) as { content?: Array<{ text: string }> } | undefined;
  assert.match(result?.content?.at(-1)?.text ?? "", /OpenSpec rule\./);
});

test("hosts without prompt sections still receive rules through systemPrompt", async () => {
  const { handlers, ctx } = await loadExtension();
  const result = (await handlers.get("before_agent_start")!(
    { type: "before_agent_start", prompt: "hi", systemPrompt: "BASE", systemPromptOptions: {} },
    ctx,
  )) as { systemPrompt?: string } | undefined;
  assert.match(result?.systemPrompt ?? "", /^BASE\n\n## Auto-loaded Rules\n\n[\s\S]*Always cite sources\./);
});
