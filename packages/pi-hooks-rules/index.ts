import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  hasTrustRequiringProjectResources,
  parseFrontmatter,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const TOOL_HOOK_EVENTS = ["tool_call", "tool_result"] as const;
const LIFECYCLE_HOOK_EVENTS = [
  "session_start",
  "input",
  "user_bash",
  "before_agent_start",
  "agent_before_settle",
  "session_before_compact",
  "session_shutdown",
] as const;
export type ToolHookEvent = (typeof TOOL_HOOK_EVENTS)[number];
export type LifecycleHookEvent = (typeof LIFECYCLE_HOOK_EVENTS)[number];
export type HookEvent = ToolHookEvent | LifecycleHookEvent;
const HOOK_EVENTS: readonly HookEvent[] = [...TOOL_HOOK_EVENTS, ...LIFECYCLE_HOOK_EVENTS];

function isToolEvent(event: HookEvent): event is ToolHookEvent {
  return event === "tool_call" || event === "tool_result";
}

export type HookScope = "default" | "global" | "project";
type HookStatus = "passed" | "blocked" | "failed" | "error";

export type HookDefinition = {
  id: string;
  event: HookEvent;
  /** Tool selector; present only for tool_call and tool_result hooks. */
  tools?: string[];
  command: string;
  args?: string[];
  timeoutMs?: number;
  enabled?: boolean;
};

export type HookFile = {
  version: 1;
  hooks: HookDefinition[];
  overrides: Record<string, { enabled: boolean }>;
};

export type LoadedHook = HookDefinition & {
  scope: HookScope;
  configPath: string;
  configDir: string;
  isBundled: boolean;
};

type HookResult = {
  decision?: string;
  reason?: string;
  hookSpecificOutput?: {
    permissionDecision?: string;
    permissionDecisionReason?: string;
    additionalContext?: string;
  };
};

type HookRun = {
  at: string;
  id: string;
  event: HookEvent;
  tool?: string;
  status: HookStatus;
  code: number | null;
  durationMs: number;
};

export type RuleDocument = {
  path: string;
  content: string;
  paths?: string[];
};

export function countLoadedRules(rules: RuleDocument[], injectedScopedRules: ReadonlySet<string>): number {
  return rules.filter((rule) => !rule.paths || injectedScopedRules.has(rule.path)).length;
}

const agentDir = getAgentDir();
const extensionDir = dirname(fileURLToPath(import.meta.url));
const hooksDir = join(extensionDir, "hooks");
const bundledConfigPath = join(extensionDir, "hooks.json");
const globalConfigPath = join(agentDir, "hooks-rules.json");
const MAX_RECENT_RUNS = 100;
const MAX_OUTPUT_CHARS = 8_000;
const MAX_CAPTURE_CHARS = 64_000;
const CONTEXT_MESSAGE_TYPE = "hooks-rules-context";
const CONTINUE_MESSAGE_TYPE = "hooks-rules-continue";
// Bounds how often agent_before_settle hooks can keep one run going, so a hook that always
// denies cannot loop forever. Raise it only together with a per-hook opt-in.
const MAX_SETTLE_CONTINUATIONS = 3;
// Gates act on the first denial; fail-closed gates also stop at, and act on, the first failure.
// Compaction is not fail-closed: a broken hook must not cancel overflow recovery.
const GATE_EVENTS = new Set<HookEvent>(["input", "user_bash", "session_before_compact", "agent_before_settle"]);
const FAIL_CLOSED_EVENTS = new Set<HookEvent>(["input", "user_bash", "agent_before_settle"]);
const SAMPLE_LIFECYCLE_FIELDS: Record<LifecycleHookEvent, Record<string, unknown>> = {
  session_start: { reason: "startup" },
  input: { prompt: "pi hook test", source: "interactive" },
  user_bash: { tool_name: "Bash", tool_input: { command: "printf pi-hook-test" }, exclude_from_context: false },
  before_agent_start: { prompt: "pi hook test" },
  agent_before_settle: { outcome: "completed", stop_hook_active: false },
  session_before_compact: { reason: "manual", will_retry: false },
  session_shutdown: { reason: "quit" },
};

export function validateHook(value: unknown, source: string): HookDefinition {
  if (!value || typeof value !== "object") throw new Error(`${source}: hook must be an object`);
  const hook = value as Partial<HookDefinition>;
  if (!hook.id || !/^[a-z0-9][a-z0-9._-]*$/i.test(hook.id)) {
    throw new Error(`${source}: hook id must match [a-z0-9._-]+`);
  }
  if (!HOOK_EVENTS.includes(hook.event as HookEvent)) {
    throw new Error(`${source}/${hook.id}: event must be one of ${HOOK_EVENTS.join(", ")}`);
  }
  const event = hook.event as HookEvent;
  let tools: string[] | undefined;
  if (isToolEvent(event)) {
    if (!Array.isArray(hook.tools) || hook.tools.length === 0 || hook.tools.some((tool) => typeof tool !== "string")) {
      throw new Error(`${source}/${hook.id}: tools must be a non-empty string array`);
    }
    tools = hook.tools.map((tool) => tool.toLowerCase());
  } else if (hook.tools !== undefined && !(Array.isArray(hook.tools) && hook.tools.length === 0)) {
    // An empty list is tolerated so files written by hand or by older tooling still load.
    throw new Error(`${source}/${hook.id}: tools only applies to tool_call and tool_result events`);
  }
  if (!hook.command || typeof hook.command !== "string" || hook.command.includes("\n")) {
    throw new Error(`${source}/${hook.id}: command must be one executable without newlines`);
  }
  if (hook.args !== undefined && (!Array.isArray(hook.args) || hook.args.some((arg) => typeof arg !== "string"))) {
    throw new Error(`${source}/${hook.id}: args must be a string array`);
  }
  if (hook.timeoutMs !== undefined && (!Number.isInteger(hook.timeoutMs) || hook.timeoutMs < 100 || hook.timeoutMs > 120_000)) {
    throw new Error(`${source}/${hook.id}: timeoutMs must be an integer from 100 to 120000`);
  }
  if (hook.enabled !== undefined && typeof hook.enabled !== "boolean") {
    throw new Error(`${source}/${hook.id}: enabled must be boolean`);
  }
  return {
    id: hook.id,
    event,
    ...(tools ? { tools } : {}),
    command: hook.command,
    args: hook.args ?? [],
    timeoutMs: hook.timeoutMs ?? 5_000,
    enabled: hook.enabled ?? true,
  };
}

export function readHookFile(path: string, optional = false): HookFile {
  if (!existsSync(path)) {
    if (optional) return { version: 1, hooks: [], overrides: {} };
    throw new Error(`Missing hook configuration: ${path}`);
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<HookFile>;
  if (parsed.version !== 1 || !Array.isArray(parsed.hooks)) {
    throw new Error(`${path}: expected { "version": 1, "hooks": [...] }`);
  }
  const ids = new Set<string>();
  const hooks = parsed.hooks.map((hook, index) => {
    const validated = validateHook(hook, `${path}#${index + 1}`);
    if (ids.has(validated.id)) throw new Error(`${path}: duplicate hook id "${validated.id}"`);
    ids.add(validated.id);
    return validated;
  });
  const overrides: Record<string, { enabled: boolean }> = {};
  if (parsed.overrides !== undefined) {
    if (!parsed.overrides || typeof parsed.overrides !== "object" || Array.isArray(parsed.overrides)) {
      throw new Error(`${path}: overrides must be an object`);
    }
    for (const [id, override] of Object.entries(parsed.overrides)) {
      if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id) || typeof override?.enabled !== "boolean") {
        throw new Error(`${path}: override "${id}" must contain boolean enabled`);
      }
      overrides[id] = { enabled: override.enabled };
    }
  }
  return { version: 1, hooks, overrides };
}

export function mergeHookSources(
  sources: Array<{ scope: HookScope; path: string; file: HookFile }>,
): LoadedHook[] {
  const merged = new Map<string, LoadedHook>();
  for (const source of sources) {
    for (const hook of source.file.hooks) {
      merged.set(hook.id, {
        ...hook,
        scope: source.scope,
        configPath: source.path,
        configDir: dirname(source.path),
        isBundled: source.scope === "default",
      });
    }
    for (const [id, override] of Object.entries(source.file.overrides)) {
      const existing = merged.get(id);
      if (!existing) throw new Error(`${source.path}: override references unknown hook "${id}"`);
      merged.set(id, {
        ...existing,
        enabled: override.enabled,
        scope: source.scope,
        configPath: source.path,
        configDir: dirname(source.path),
      });
    }
  }
  return [...merged.values()];
}

function writeHookFile(path: string, file: HookFile): void {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tempPath, `${JSON.stringify(file, null, 2)}\n`, "utf8");
    renameSync(tempPath, path);
  } finally {
    if (existsSync(tempPath)) unlinkSync(tempPath);
  }
}

export function findMarkdownFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...findMarkdownFiles(path));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) files.push(path);
  }
  return files.sort();
}

// Reuse Pi's own trust gate so newly trust-gated resources (such as 1.0's mcp.json) stay in sync.
export function hasProjectTrustMarker(cwd: string): boolean {
  return hasTrustRequiringProjectResources(cwd);
}

function parseRuleDocument(source: string): Omit<RuleDocument, "path"> {
  const { body, frontmatter } = parseFrontmatter(source);
  const pathsValue = frontmatter.paths;
  const paths =
    typeof pathsValue === "string"
      ? [pathsValue]
      : Array.isArray(pathsValue) && pathsValue.every((path) => typeof path === "string")
        ? pathsValue
        : undefined;
  if (pathsValue !== undefined && !paths) throw new Error("Rule front matter paths must be a string or string array");
  return { content: body.trim(), ...(paths ? { paths } : {}) };
}

function normalizeRulePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

function expandBraces(pattern: string): string[] {
  const brace = pattern.match(/\{([^{}]+)\}/);
  if (!brace) return [pattern];
  return brace[1].split(",").flatMap((option) => expandBraces(pattern.replace(brace[0], option)));
}

function globMatches(path: string, pattern: string): boolean {
  let expression = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        while (pattern[index + 1] === "*") index += 1;
        if (pattern[index + 1] === "/") {
          expression += "(?:.*/)?";
          index += 1;
        } else {
          expression += ".*";
        }
      } else {
        expression += "[^/]*";
      }
    } else if (character === "?") {
      expression += "[^/]";
    } else {
      expression += character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`${expression}$`).test(path);
}

export function matchesRulePath(path: string, patterns: string[]): boolean {
  const normalizedPath = normalizeRulePath(path);
  return patterns.flatMap((pattern) => expandBraces(normalizeRulePath(pattern))).some((pattern) => globMatches(normalizedPath, pattern));
}

export function collectRules(
  cwd: string,
  projectTrusted: boolean,
  locations: { agentDir: string } = { agentDir },
): RuleDocument[] {
  const roots = [{ path: join(locations.agentDir, "rules"), label: "~/.pi/agent/rules" }];
  if (projectTrusted) roots.push({ path: join(cwd, CONFIG_DIR_NAME, "rules"), label: `${CONFIG_DIR_NAME}/rules` });
  const seen = new Set<string>();
  return roots.flatMap((root) =>
    findMarkdownFiles(root.path).flatMap((path) => {
      const rule = parseRuleDocument(readFileSync(path, "utf8"));
      const identity = JSON.stringify([rule.content, rule.paths ? [...rule.paths].sort() : null]);
      if (!rule.content || seen.has(identity)) return [];
      seen.add(identity);
      return [{ path: `${root.label}/${relative(root.path, path).replaceAll("\\", "/")}`, ...rule }];
    }),
  );
}

function hookEnvelope(
  toolName: string,
  input: Record<string, unknown>,
  response?: { content: unknown; isError: boolean },
) {
  const edits = Array.isArray(input.edits)
    ? (input.edits as Array<{ oldText?: unknown; newText?: unknown }>)
    : [];
  return {
    tool_name: ({ bash: "Bash", powershell: "PowerShell", write: "Write", edit: "Edit" } as Record<string, string>)[
      toolName
    ] ?? toolName,
    tool_input: {
      ...input,
      file_path: input.path,
      old_string: edits.map((edit) => (typeof edit.oldText === "string" ? edit.oldText : "")).join("\n"),
      new_string: edits.map((edit) => (typeof edit.newText === "string" ? edit.newText : "")).join("\n"),
    },
    ...(response ? { tool_response: response.content, tool_error: response.isError } : {}),
  };
}

export function parseHookResult(stdout: string): HookResult | undefined {
  const text = stdout.trim();
  if (!text) return undefined;
  const candidates = [text, ...text.split(/\r?\n/).reverse()];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as HookResult;
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // Hooks may write diagnostics before their final JSON line.
    }
  }
  return undefined;
}

type HookDecision = { denied: false } | { denied: true; reason: string | undefined };

function nonEmptyText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readDecision(result: HookResult | undefined): HookDecision {
  const specific = result?.hookSpecificOutput;
  if (specific?.permissionDecision === "deny") return { denied: true, reason: nonEmptyText(specific.permissionDecisionReason) };
  if (result?.decision === "block" || result?.decision === "deny") return { denied: true, reason: nonEmptyText(result.reason) };
  return { denied: false };
}

export function denialReason(result: HookResult | undefined): string | undefined {
  const decision = readDecision(result);
  // Decide on the decision itself; an empty reason must not turn a denial into an allow.
  return decision.denied ? (decision.reason ?? "Blocked by hook") : undefined;
}

function additionalContext(result: HookResult | undefined): string | undefined {
  return nonEmptyText(result?.hookSpecificOutput?.additionalContext);
}

function hookFailure(hook: LoadedHook, result: { code: number | null; stdout: string; stderr: string }): string {
  return `Hook ${hook.id} failed${result.code === null ? "" : ` with exit ${result.code}`}: ${truncate(result.stderr || result.stdout)}`;
}

function lifecyclePayload(event: LifecycleHookEvent, ctx: ExtensionContext, fields: Record<string, unknown>) {
  return {
    hook_event_name: event,
    cwd: ctx.cwd,
    session_id: ctx.sessionManager?.getSessionId(),
    transcript_path: ctx.sessionManager?.getSessionFile(),
    ...fields,
  };
}

function truncate(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= MAX_OUTPUT_CHARS ? trimmed : `${trimmed.slice(0, MAX_OUTPUT_CHARS)}…`;
}

function runProcess(
  command: string,
  args: string[],
  payload: unknown,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveResult) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let outputExceeded = false;
    let settled = false;
    const child = spawn(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const finish = (code: number | null, error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolveResult({
        code,
        stdout,
        stderr: [
          stderr.trim(),
          error,
          timedOut ? `Timed out after ${timeoutMs}ms` : "",
          aborted ? "Aborted" : "",
          outputExceeded ? `Output exceeded ${MAX_CAPTURE_CHARS} characters` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    const onAbort = () => {
      aborted = true;
      child.kill();
    };
    const append = (current: string, chunk: string) => {
      const remaining = MAX_CAPTURE_CHARS - current.length;
      if (chunk.length <= remaining) return current + chunk;
      outputExceeded = true;
      child.kill();
      return current + chunk.slice(0, Math.max(0, remaining));
    };
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout = append(stdout, chunk)));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr = append(stderr, chunk)));
    child.stdin.on("error", () => {});
    child.on("error", (error) => finish(null, error.message));
    child.on("close", (code) => finish(code));
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    child.stdin.end(JSON.stringify(payload));
  });
}

export function matchesHook(hook: LoadedHook, event: HookEvent, toolName?: string): boolean {
  if (hook.enabled === false || hook.event !== event) return false;
  if (!isToolEvent(event)) return true;
  const tools = hook.tools ?? [];
  return toolName !== undefined && (tools.includes("*") || tools.includes(toolName.toLowerCase()));
}

function formatHook(hook: LoadedHook): string {
  return [
    `${hook.enabled === false ? "○" : "●"} ${hook.id}`,
    `scope: ${hook.scope}`,
    `event: ${hook.event}`,
    ...(hook.tools ? [`tools: ${hook.tools.join(", ")}`] : []),
    `command: ${hook.command} ${(hook.args ?? []).join(" ")}`.trim(),
    `timeout: ${hook.timeoutMs ?? 5_000}ms`,
    `config: ${hook.configPath}`,
  ].join("\n");
}

export default function hooksAndRulesExtension(pi: ExtensionAPI) {
  let hooks: LoadedHook[] = [];
  let recentRuns: HookRun[] = [];
  let rules: RuleDocument[] = [];
  const injectedScopedRules = new Set<string>();
  let configError: string | undefined;
  let rulesError: string | undefined;
  // additionalContext from session_start hooks, injected once with the next agent run.
  let pendingSessionContext: string[] = [];
  // agent_before_settle continuations requested by this plugin since the last agent_settled.
  let settleContinuations = 0;

  function projectConfigPath(ctx: ExtensionContext): string {
    return join(ctx.cwd, CONFIG_DIR_NAME, "hooks-rules.json");
  }

  function updateStatus(ctx: ExtensionContext): void {
    const enabled = hooks.filter((hook) => hook.enabled !== false).length;
    const rulesLoaded = countLoadedRules(rules, injectedScopedRules);
    const hookStatus = configError ? "hooks:error" : `hooks:${enabled}/${hooks.length}`;
    const ruleStatus = rulesError ? "rules:error" : `rules:${rulesLoaded}/${rules.length}`;
    ctx.ui.setStatus("hooks-rules", `${hookStatus} ${ruleStatus}`);
  }

  function loadState(ctx: ExtensionContext, notify = false): void {
    configError = undefined;
    rulesError = undefined;
    const projectAllowed = hasProjectTrustMarker(ctx.cwd) && ctx.isProjectTrusted();
    try {
      const sources: Array<{ scope: HookScope; path: string; optional: boolean }> = [
        { scope: "default", path: bundledConfigPath, optional: false },
        { scope: "global", path: globalConfigPath, optional: true },
      ];
      if (projectAllowed) sources.push({ scope: "project", path: projectConfigPath(ctx), optional: true });
      hooks = mergeHookSources(
        sources.map((source) => ({
          scope: source.scope,
          path: source.path,
          file: readHookFile(source.path, source.optional),
        })),
      );
    } catch (error) {
      hooks = [];
      configError = error instanceof Error ? error.message : String(error);
      if (notify) ctx.ui.notify(configError, "error");
    }

    try {
      rules = collectRules(ctx.cwd, projectAllowed);
    } catch (error) {
      rules = [];
      rulesError = error instanceof Error ? error.message : String(error);
      if (notify) ctx.ui.notify(`Rules load failed: ${rulesError}`, "error");
    }

    updateStatus(ctx);
  }

  function reloadState(ctx: ExtensionContext, successMessage: string): boolean {
    injectedScopedRules.clear();
    loadState(ctx, true);
    if (configError || rulesError) return false;
    ctx.ui.notify(successMessage, "info");
    return true;
  }

  function formatRules(selectedRules: RuleDocument[]): string {
    return selectedRules.map((rule) => `### ${rule.path}\n\n${rule.content}`).join("\n\n");
  }

  function scopedRulesForTool(toolName: string, input: Record<string, unknown>, cwd: string): RuleDocument[] {
    if (!(["read", "write", "edit"] as string[]).includes(toolName) || typeof input.path !== "string") return [];
    const absolute = resolve(cwd, input.path);
    const relativeTarget = relative(cwd, absolute);
    if (!relativeTarget || isAbsolute(relativeTarget)) return [];
    const target = normalizeRulePath(relativeTarget);
    if (target === ".." || target.startsWith("../")) return [];
    // Scoped rules name project paths, but a session started below the project root only
    // sees a working-directory-relative path. Test the target relative to each ancestor
    // as well, so a rule scoped to the working directory's own prefix still matches (for
    // example "**/openspec/**" while Pi runs inside the openspec directory).
    const matchesTarget = (paths: string[]): boolean => {
      if (matchesRulePath(target, paths)) return true;
      for (let parent = dirname(cwd); ; parent = dirname(parent)) {
        const relativeFromParent = relative(parent, absolute);
        const fromParent = normalizeRulePath(relativeFromParent);
        if (
          !isAbsolute(relativeFromParent) &&
          fromParent !== ".." &&
          !fromParent.startsWith("../")
        ) {
          if (matchesRulePath(fromParent, paths)) return true;
        }
        if (parent === dirname(parent)) break;
      }
      return false;
    };
    return rules.filter(
      (rule) => rule.paths && !injectedScopedRules.has(rule.path) && matchesTarget(rule.paths),
    );
  }

  function expandValue(value: string, hook: LoadedHook, cwd: string): string {
    return value
      .replaceAll("${node}", process.execPath)
      .replaceAll("${agentDir}", agentDir)
      .replaceAll("${hooksDir}", hooksDir)
      .replaceAll("${configDir}", hook.configDir)
      .replaceAll("${cwd}", cwd);
  }

  async function executeHook(
    hook: LoadedHook,
    tool: string | undefined,
    payload: unknown,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<{ code: number | null; stdout: string; stderr: string; run: HookRun }> {
    let command = expandValue(hook.command, hook, cwd);
    if (!isAbsolute(command) && /[\\/]/.test(command)) command = resolve(hook.configDir, command);
    let args = (hook.args ?? []).map((arg) => expandValue(arg, hook, cwd));
    if (/(^|[\\/])bash(?:\.exe)?$/i.test(command)) args = args.map((arg) => arg.replaceAll("\\", "/"));

    const started = Date.now();
    const run: HookRun = {
      at: new Date().toISOString(),
      id: hook.id,
      event: hook.event,
      tool,
      status: "passed",
      code: null,
      durationMs: 0,
    };
    const result = await runProcess(command, args, payload, cwd, hook.timeoutMs ?? 5_000, signal);
    run.code = result.code;
    run.durationMs = Date.now() - started;
    run.status = result.code === 0 ? "passed" : result.code === null ? "error" : "failed";
    recentRuns = [...recentRuns, run].slice(-MAX_RECENT_RUNS);
    return { ...result, run };
  }

  function mutateHook(hook: LoadedHook, mutate: (definition: HookDefinition) => HookDefinition | undefined): void {
    const file = readHookFile(hook.configPath, true);
    const index = file.hooks.findIndex((candidate) => candidate.id === hook.id);
    if (index < 0) throw new Error(`Hook "${hook.id}" no longer exists in ${hook.configPath}`);
    const next = mutate(file.hooks[index]);
    if (next) file.hooks[index] = validateHook(next, hook.configPath);
    else file.hooks.splice(index, 1);
    writeHookFile(hook.configPath, file);
  }

  function setHookEnabled(hook: LoadedHook, enabled: boolean, ctx: ExtensionContext): void {
    if (!hook.isBundled) {
      mutateHook(hook, (definition) => ({ ...definition, enabled }));
      return;
    }
    const targetPath = hook.scope === "project" ? projectConfigPath(ctx) : globalConfigPath;
    const file = readHookFile(targetPath, true);
    file.overrides[hook.id] = { enabled };
    writeHookFile(targetPath, file);
  }

  function findHook(id: string | undefined): LoadedHook | undefined {
    return hooks.find((hook) => hook.id === id);
  }

  async function pickHook(ctx: ExtensionContext, title: string): Promise<LoadedHook | undefined> {
    if (hooks.length === 0) {
      ctx.ui.notify("No hooks configured", "warning");
      return undefined;
    }
    const selected = await ctx.ui.select(
      title,
      hooks.map((hook) => `${hook.enabled === false ? "○" : "●"} ${hook.id} [${hook.scope}/${hook.event}]`),
    );
    if (!selected) return undefined;
    const id = selected.replace(/^[○●]\s+/, "").split(" ")[0];
    return findHook(id);
  }

  async function addHook(ctx: ExtensionContext): Promise<void> {
    if (ctx.mode !== "tui") {
      ctx.ui.notify("/hooks add requires TUI mode", "error");
      return;
    }
    const scopes = hasProjectTrustMarker(ctx.cwd) && ctx.isProjectTrusted() ? ["global", "project"] : ["global"];
    const scope = (await ctx.ui.select("Hook scope", scopes)) as HookScope | undefined;
    if (!scope) return;
    const id = (await ctx.ui.input("Hook id", "my-hook"))?.trim();
    if (!id) return;
    const event = (await ctx.ui.select("Hook event", [...HOOK_EVENTS])) as HookEvent | undefined;
    if (!event) return;
    let tools: string[] | undefined;
    if (isToolEvent(event)) {
      const toolsInput = (await ctx.ui.input("Tools (comma-separated or *)", "bash,write"))?.trim();
      if (!toolsInput) return;
      tools = toolsInput.split(",").map((tool) => tool.trim()).filter(Boolean);
    }
    const command = (await ctx.ui.input("Executable", "${node}"))?.trim();
    if (!command) return;
    const argsText = await ctx.ui.editor(
      "Arguments (one per line; placeholders: ${node}, ${hooksDir}, ${agentDir}, ${configDir}, ${cwd})",
      "${configDir}/hooks/my-hook.mjs",
    );
    if (argsText === undefined) return;
    const timeoutText = (await ctx.ui.input("Timeout in milliseconds", "5000"))?.trim() ?? "5000";
    const definition = validateHook(
      {
        id,
        event,
        ...(tools ? { tools } : {}),
        command,
        args: argsText.split(/\r?\n/).filter((arg) => arg.length > 0),
        timeoutMs: Number(timeoutText),
        enabled: true,
      },
      "new hook",
    );
    const path = scope === "global" ? globalConfigPath : projectConfigPath(ctx);
    const file = readHookFile(path, true);
    if (file.hooks.some((hook) => hook.id === definition.id)) throw new Error(`Hook "${definition.id}" already exists`);
    const confirmed = await ctx.ui.confirm("Add hook?", JSON.stringify(definition, null, 2));
    if (!confirmed) return;
    file.hooks.push(definition);
    writeHookFile(path, file);
    reloadState(ctx, `Added hook "${definition.id}".`);
  }

  async function showHook(ctx: ExtensionContext, hook?: LoadedHook): Promise<void> {
    const selected = hook ?? (await pickHook(ctx, "View hook"));
    if (selected) ctx.ui.notify(formatHook(selected), "info");
  }

  async function toggleHook(ctx: ExtensionContext, hook?: LoadedHook, enabled?: boolean): Promise<void> {
    const selected = hook ?? (await pickHook(ctx, "Enable/disable hook"));
    if (!selected) return;
    const nextEnabled = enabled ?? selected.enabled === false;
    setHookEnabled(selected, nextEnabled, ctx);
    reloadState(ctx, `${nextEnabled ? "Enabled" : "Disabled"} hook "${selected.id}".`);
  }

  async function removeHook(ctx: ExtensionContext, hook?: LoadedHook): Promise<void> {
    const selected = hook ?? (await pickHook(ctx, "Remove hook"));
    if (!selected) return;
    const confirmed = await ctx.ui.confirm("Remove hook?", `${selected.id} from ${selected.configPath}`);
    if (!confirmed) return;
    if (selected.isBundled) setHookEnabled(selected, false, ctx);
    else mutateHook(selected, () => undefined);
    reloadState(ctx, `${selected.isBundled ? "Disabled" : "Removed"} hook "${selected.id}".`);
  }

  function showList(ctx: ExtensionContext): void {
    const lines = hooks.map(
      (hook) =>
        `${hook.enabled === false ? "○" : "●"} ${hook.id} [${hook.scope}] ${hook.event}${hook.tools ? ` → ${hook.tools.join(",")}` : ""}`,
    );
    ctx.ui.notify(
      [
        `Hooks ${hooks.filter((hook) => hook.enabled !== false).length}/${hooks.length}`,
        ...lines,
        `Rules loaded: ${countLoadedRules(rules, injectedScopedRules)}/${rules.length}`,
        configError ? `Config error: ${configError}` : "",
        rulesError ? `Rules error: ${rulesError}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
      configError || rulesError ? "warning" : "info",
    );
  }

  function showRuns(ctx: ExtensionContext, id?: string): void {
    const selected = recentRuns.filter((run) => !id || run.id === id).slice(-20);
    ctx.ui.notify(
      selected.length
        ? selected
            .map(
              (run) =>
                `${run.at} ${run.status.toUpperCase()} ${run.id} ${run.event}${run.tool ? `/${run.tool}` : ""} code=${run.code ?? "-"} ${run.durationMs}ms`,
            )
            .join("\n")
        : "No hook runs recorded in this session",
      "info",
    );
  }

  async function testHook(ctx: ExtensionContext, hook?: LoadedHook): Promise<void> {
    const selected = hook ?? (await pickHook(ctx, "Test hook"));
    if (!selected) return;
    let tool: string | undefined;
    let payload: unknown;
    if (isToolEvent(selected.event)) {
      tool = selected.tools?.find((candidate) => candidate !== "*") ?? "bash";
      const input: Record<string, unknown> =
        tool === "write" || tool === "edit"
          ? { path: join(extensionDir, ".pi-hook-test.txt"), content: "pi hook test" }
          : { command: "printf pi-hook-test" };
      payload = hookEnvelope(tool, input, selected.event === "tool_result" ? { content: [], isError: false } : undefined);
    } else {
      payload = lifecyclePayload(selected.event, ctx, SAMPLE_LIFECYCLE_FIELDS[selected.event]);
    }
    const result = await executeHook(selected, tool, payload, ctx.cwd);
    const parsed = parseHookResult(result.stdout);
    const denial = denialReason(parsed);
    const context = additionalContext(parsed);
    if (denial) result.run.status = "blocked";
    ctx.ui.notify(
      [
        `${selected.id}: ${result.run.status} (code ${result.code ?? "-"}, ${result.run.durationMs}ms)`,
        denial ? `decision: ${denial}` : "",
        context ? `additionalContext: ${truncate(context)}` : "",
        result.stdout ? `stdout: ${truncate(result.stdout)}` : "",
        result.stderr ? `stderr: ${truncate(result.stderr)}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
      result.run.status === "passed" ? "info" : "warning",
    );
  }

  async function interactiveManager(ctx: ExtensionContext): Promise<void> {
    if (ctx.mode !== "tui") {
      showList(ctx);
      return;
    }
    for (;;) {
      const action = await ctx.ui.select("Hooks", [
        "List hooks",
        "View hook",
        "Add hook",
        "Enable/disable hook",
        "Remove hook",
        "Test hook",
        "Recent runs",
        "Reload configuration",
        "Done",
      ]);
      if (!action || action === "Done") return;
      try {
        if (action === "List hooks") showList(ctx);
        else if (action === "View hook") await showHook(ctx);
        else if (action === "Add hook") await addHook(ctx);
        else if (action === "Enable/disable hook") await toggleHook(ctx);
        else if (action === "Remove hook") await removeHook(ctx);
        else if (action === "Test hook") await testHook(ctx);
        else if (action === "Recent runs") showRuns(ctx);
        else if (action === "Reload configuration") reloadState(ctx, "Reloaded hooks and rules.");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    }
  }

  pi.registerCommand("hooks", {
    description: "Manage and inspect tool hooks",
    getArgumentCompletions: (prefix) => {
      const actions = ["list", "show", "add", "enable", "disable", "toggle", "remove", "test", "logs", "reload"];
      const [action, idPrefix = ""] = prefix.trimStart().split(/\s+/, 2);
      if (prefix.includes(" ") && ["show", "enable", "disable", "toggle", "remove", "test", "logs"].includes(action)) {
        return hooks
          .filter((hook) => hook.id.startsWith(idPrefix))
          .map((hook) => ({ value: `${action} ${hook.id}`, label: hook.id, description: `${hook.scope}/${hook.event}` }));
      }
      return actions
        .filter((candidate) => candidate.startsWith(action || ""))
        .map((candidate) => ({ value: candidate, label: candidate }));
    },
    handler: async (args, ctx) => {
      const [action, id] = args.trim().split(/\s+/, 2);
      try {
        if (!action) return await interactiveManager(ctx);
        if (action === "list") return showList(ctx);
        if (action === "reload") {
          reloadState(ctx, "Reloaded hooks and rules.");
          return;
        }
        if (action === "logs") return showRuns(ctx, id);
        if (action === "add") return await addHook(ctx);
        const hook = findHook(id);
        if (!hook) {
          ctx.ui.notify(`Unknown hook "${id ?? ""}"`, "error");
          return;
        }
        if (action === "show") return await showHook(ctx, hook);
        if (action === "enable") return await toggleHook(ctx, hook, true);
        if (action === "disable") return await toggleHook(ctx, hook, false);
        if (action === "toggle") return await toggleHook(ctx, hook);
        if (action === "remove") return await removeHook(ctx, hook);
        if (action === "test") return await testHook(ctx, hook);
        ctx.ui.notify("Usage: /hooks [list|show|add|enable|disable|toggle|remove|test|logs|reload]", "error");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  type LifecycleOutcome = {
    /** First denial from a gate event; later hooks do not run. */
    denial?: { hook: LoadedHook; reason: string | undefined };
    /** First failure of a fail-closed event; later hooks do not run. */
    failure?: string;
    /** Failures that do not stop the event. */
    failures: string[];
    contexts: string[];
  };

  async function runLifecycleHooks(
    event: LifecycleHookEvent,
    ctx: ExtensionContext,
    fields: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<LifecycleOutcome> {
    const outcome: LifecycleOutcome = { failures: [], contexts: [] };
    const matched = hooks.filter((hook) => matchesHook(hook, event));
    if (matched.length === 0) return outcome;
    const payload = lifecyclePayload(event, ctx, fields);
    for (const hook of matched) {
      const result = await executeHook(hook, undefined, payload, ctx.cwd, signal);
      const parsed = parseHookResult(result.stdout);
      const decision = readDecision(parsed);
      // Like tool_call, an explicit denial takes precedence over the exit code.
      if (decision.denied && GATE_EVENTS.has(event)) {
        result.run.status = "blocked";
        outcome.denial = { hook, reason: decision.reason };
        return outcome;
      }
      if (result.code !== 0) {
        result.run.status = "failed";
        const message = hookFailure(hook, result);
        if (FAIL_CLOSED_EVENTS.has(event)) {
          outcome.failure = message;
          return outcome;
        }
        outcome.failures.push(message);
        continue;
      }
      const context = additionalContext(parsed);
      if (context) outcome.contexts.push(context);
    }
    return outcome;
  }

  function blockReason(outcome: LifecycleOutcome): string | undefined {
    if (outcome.denial) return outcome.denial.reason ?? `Blocked by hook ${outcome.denial.hook.id}`;
    return outcome.failure;
  }

  function reportFailures(ctx: ExtensionContext, failures: string[]): void {
    for (const failure of failures) ctx.ui.notify(failure, "warning");
  }

  pi.on("session_start", async (event, ctx) => {
    injectedScopedRules.clear();
    pendingSessionContext = [];
    settleContinuations = 0;
    loadState(ctx, true);
    if (event.reason === "reload" && !configError && !rulesError) ctx.ui.notify("Reloaded hooks and rules.", "info");
    // Runs after loadState because this plugin only knows its hooks once configuration is loaded.
    const outcome = await runLifecycleHooks("session_start", ctx, {
      reason: event.reason,
      previous_session_file: event.previousSessionFile,
    });
    reportFailures(ctx, outcome.failures);
    pendingSessionContext = outcome.contexts;
  });

  pi.on("input", async (event, ctx) => {
    const outcome = await runLifecycleHooks("input", ctx, {
      prompt: event.text,
      source: event.source,
      streaming_behavior: event.streamingBehavior,
      image_count: event.images?.length ?? 0,
    });
    const blocked = blockReason(outcome);
    if (!blocked) return;
    ctx.ui.notify(`Prompt blocked: ${blocked}`, "warning");
    return { action: "handled" as const };
  });

  pi.on("user_bash", async (event, ctx) => {
    // Same shape as a Bash tool_call payload, so command guards can be reused for ! commands.
    const outcome = await runLifecycleHooks("user_bash", ctx, {
      tool_name: "Bash",
      tool_input: { command: event.command },
      exclude_from_context: event.excludeFromContext,
    });
    const blocked = blockReason(outcome);
    if (!blocked) return;
    return { result: { output: `Blocked by hook: ${blocked}`, exitCode: 1, cancelled: false, truncated: false } };
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const outcome = await runLifecycleHooks("before_agent_start", ctx, { prompt: event.prompt }, ctx.signal);
    reportFailures(ctx, outcome.failures);
    const contexts = [...pendingSessionContext, ...outcome.contexts];
    pendingSessionContext = [];
    const message = contexts.length
      ? { customType: CONTEXT_MESSAGE_TYPE, content: contexts.join("\n\n"), display: false }
      : undefined;
    const systemPrompt = applyRules(event);
    if (!message && systemPrompt === undefined) return;
    return { ...(message ? { message } : {}), ...(systemPrompt !== undefined ? { systemPrompt } : {}) };
  });

  /** Adds unscoped rules to the prompt; returns a replacement prompt only when sections cannot be used. */
  function applyRules(event: {
    readonly systemPrompt: string;
    systemPromptOptions?: unknown;
  }): string | undefined {
    const unscopedRules = rules.filter((rule) => !rule.paths);
    // Pi >= 0.86 exposes mutable prompt sections. Returning systemPrompt there becomes
    // forceSystemPrompt, which replaces the whole structured prompt for the run.
    const options = event.systemPromptOptions as
      | { sections?: Record<string, string>; forceSystemPrompt?: string }
      | undefined;
    const sections = options?.sections;
    // An earlier handler that returned systemPrompt makes Pi ignore sections for this run,
    // so append to the forced text instead. A later forcing handler still overrides this;
    // Pi offers no way to compose with it.
    if (sections && options?.forceSystemPrompt === undefined) {
      if (unscopedRules.length === 0) delete sections.auto_loaded_rules;
      else sections.auto_loaded_rules = `## Auto-loaded Rules\n\n${formatRules(unscopedRules)}`;
      return undefined;
    }
    if (sections) delete sections.auto_loaded_rules;
    if (unscopedRules.length === 0) return undefined;
    return `${event.systemPrompt}\n\n## Auto-loaded Rules\n\n${formatRules(unscopedRules)}`;
  }

  pi.on("tool_call", async (event, ctx) => {
    if (configError) return { block: true, reason: `Hook configuration error: ${configError}` };
    const toolName = event.toolName.toLowerCase();
    const payload = hookEnvelope(toolName, event.input as Record<string, unknown>);
    for (const hook of hooks.filter((candidate) => matchesHook(candidate, "tool_call", toolName))) {
      const result = await executeHook(hook, toolName, payload, ctx.cwd, ctx.signal);
      const denial = denialReason(parseHookResult(result.stdout));
      if (denial) {
        result.run.status = "blocked";
        return { block: true, reason: denial };
      }
      if (result.code !== 0) {
        result.run.status = "failed";
        return {
          block: true,
          reason: `Hook ${hook.id} failed${result.code === null ? "" : ` with exit ${result.code}`}: ${truncate(result.stderr || result.stdout)}`,
        };
      }
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    if (configError) {
      return {
        content: [...event.content, { type: "text" as const, text: `Hook configuration error: ${configError}` }],
        isError: true,
        // Replacing content without structuredContent drops it in Pi >= 0.99.
        structuredContent: event.structuredContent,
      };
    }
    const toolName = event.toolName.toLowerCase();
    const payload = hookEnvelope(toolName, event.input as Record<string, unknown>, {
      content: event.content,
      isError: event.isError,
    });
    const scopedRules = scopedRulesForTool(toolName, event.input, ctx.cwd);
    scopedRules.forEach((rule) => injectedScopedRules.add(rule.path));
    if (scopedRules.length > 0) updateStatus(ctx);
    const messages: string[] = [];
    for (const hook of hooks.filter((candidate) => matchesHook(candidate, "tool_result", toolName))) {
      const result = await executeHook(hook, toolName, payload, ctx.cwd, ctx.signal);
      if (result.code !== 0) {
        result.run.status = "failed";
        messages.push(
          `Hook ${hook.id} failed${result.code === null ? "" : ` with exit ${result.code}`}: ${truncate(result.stderr || result.stdout)}`,
        );
      }
    }
    if (messages.length === 0 && scopedRules.length === 0) return;
    return {
      content: [
        ...event.content,
        ...(scopedRules.length
          ? [{ type: "text" as const, text: `## Auto-loaded Rules\n\n${formatRules(scopedRules)}` }]
          : []),
        ...messages.map((text) => ({ type: "text" as const, text })),
      ],
      ...(messages.length ? { isError: true } : {}),
      structuredContent: event.structuredContent,
    };
  });

  pi.on("agent_before_settle", async (event, ctx) => {
    // Aborted or failed runs end as they are; continuing them would override the user's stop.
    if (event.outcome !== "completed" || !hooks.some((hook) => matchesHook(hook, "agent_before_settle"))) return;
    if (settleContinuations >= MAX_SETTLE_CONTINUATIONS) {
      ctx.ui.notify(
        `agent_before_settle hooks reached the continuation limit (${MAX_SETTLE_CONTINUATIONS}); letting the run finish.`,
        "warning",
      );
      return;
    }
    const outcome = await runLifecycleHooks(
      "agent_before_settle",
      ctx,
      { outcome: event.outcome, stop_hook_active: settleContinuations > 0 },
      ctx.signal,
    );
    if (outcome.failure) {
      ctx.ui.notify(`${outcome.failure}; not continuing the run.`, "warning");
      return;
    }
    if (!outcome.denial) return;
    const reason = outcome.denial.reason;
    if (!reason) {
      // The reason becomes the model's next instruction; continuing without one would only loop.
      ctx.ui.notify(`Hook ${outcome.denial.hook.id} asked to continue without a reason; ignoring it.`, "warning");
      return;
    }
    settleContinuations += 1;
    return {
      entries: [
        ...event.entries,
        { type: "custom_message" as const, customType: CONTINUE_MESSAGE_TYPE, content: reason, display: true },
      ],
      continue: true,
    };
  });

  pi.on("agent_settled", async () => {
    settleContinuations = 0;
  });

  pi.on("session_before_compact", async (event, ctx) => {
    const outcome = await runLifecycleHooks(
      "session_before_compact",
      ctx,
      { reason: event.reason, will_retry: event.willRetry, custom_instructions: event.customInstructions },
      event.signal,
    );
    reportFailures(ctx, outcome.failures);
    if (!outcome.denial) return;
    const reason = outcome.denial.reason ?? "no reason given";
    ctx.ui.notify(
      `Compaction cancelled by hook ${outcome.denial.hook.id}: ${reason}${
        event.reason === "overflow" ? " Context overflow recovery will not retry." : ""
      }`,
      "warning",
    );
    return { cancel: true };
  });

  pi.on("session_shutdown", async (event, ctx) => {
    const outcome = await runLifecycleHooks("session_shutdown", ctx, {
      reason: event.reason,
      target_session_file: event.targetSessionFile,
    });
    reportFailures(ctx, outcome.failures);
  });
}
