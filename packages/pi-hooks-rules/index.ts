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
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  parseFrontmatter,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

export type HookEvent = "tool_call" | "tool_result";
export type HookScope = "default" | "global" | "project";
type HookStatus = "passed" | "blocked" | "failed" | "error";

export type HookDefinition = {
  id: string;
  event: HookEvent;
  tools: string[];
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
  };
};

type HookRun = {
  at: string;
  id: string;
  event: HookEvent;
  tool: string;
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

export function validateHook(value: unknown, source: string): HookDefinition {
  if (!value || typeof value !== "object") throw new Error(`${source}: hook must be an object`);
  const hook = value as Partial<HookDefinition>;
  if (!hook.id || !/^[a-z0-9][a-z0-9._-]*$/i.test(hook.id)) {
    throw new Error(`${source}: hook id must match [a-z0-9._-]+`);
  }
  if (hook.event !== "tool_call" && hook.event !== "tool_result") {
    throw new Error(`${source}/${hook.id}: event must be tool_call or tool_result`);
  }
  if (!Array.isArray(hook.tools) || hook.tools.length === 0 || hook.tools.some((tool) => typeof tool !== "string")) {
    throw new Error(`${source}/${hook.id}: tools must be a non-empty string array`);
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
    event: hook.event,
    tools: hook.tools.map((tool) => tool.toLowerCase()),
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

const PROJECT_TRUST_MARKERS = [
  "settings.json",
  "extensions",
  "skills",
  "prompts",
  "themes",
  "SYSTEM.md",
  "APPEND_SYSTEM.md",
];

export function hasProjectTrustMarker(cwd: string): boolean {
  const configDir = join(cwd, CONFIG_DIR_NAME);
  if (PROJECT_TRUST_MARKERS.some((entry) => existsSync(join(configDir, entry)))) return true;

  const normalize = (path: string) => {
    const resolved = resolve(path);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  const userSkills = normalize(join(process.env.HOME || homedir(), ".agents", "skills"));
  let current = resolve(cwd);
  while (true) {
    const skills = join(current, ".agents", "skills");
    if (normalize(skills) !== userSkills && existsSync(skills)) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
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

export function denialReason(result: HookResult | undefined): string | undefined {
  if (result?.hookSpecificOutput?.permissionDecision === "deny") {
    return result.hookSpecificOutput.permissionDecisionReason ?? "Blocked by hook";
  }
  if (result?.decision === "block" || result?.decision === "deny") return result.reason ?? "Blocked by hook";
  return undefined;
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

export function matchesHook(hook: LoadedHook, event: HookEvent, toolName: string): boolean {
  return (
    hook.enabled !== false &&
    hook.event === event &&
    (hook.tools.includes("*") || hook.tools.includes(toolName.toLowerCase()))
  );
}

function formatHook(hook: LoadedHook): string {
  return [
    `${hook.enabled === false ? "○" : "●"} ${hook.id}`,
    `scope: ${hook.scope}`,
    `event: ${hook.event}`,
    `tools: ${hook.tools.join(", ")}`,
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
    const target = normalizeRulePath(relative(cwd, resolve(cwd, input.path)));
    if (!target || target.startsWith("../")) return [];
    return rules.filter(
      (rule) =>
        rule.paths &&
        !injectedScopedRules.has(rule.path) &&
        matchesRulePath(target, rule.paths),
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
    tool: string,
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
    const event = (await ctx.ui.select("Hook event", ["tool_call", "tool_result"])) as HookEvent | undefined;
    if (!event) return;
    const toolsInput = (await ctx.ui.input("Tools (comma-separated or *)", "bash,write"))?.trim();
    if (!toolsInput) return;
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
        tools: toolsInput.split(",").map((tool) => tool.trim()).filter(Boolean),
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
        `${hook.enabled === false ? "○" : "●"} ${hook.id} [${hook.scope}] ${hook.event} → ${hook.tools.join(",")}`,
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
                `${run.at} ${run.status.toUpperCase()} ${run.id} ${run.event}/${run.tool} code=${run.code ?? "-"} ${run.durationMs}ms`,
            )
            .join("\n")
        : "No hook runs recorded in this session",
      "info",
    );
  }

  async function testHook(ctx: ExtensionContext, hook?: LoadedHook): Promise<void> {
    const selected = hook ?? (await pickHook(ctx, "Test hook"));
    if (!selected) return;
    const tool = selected.tools.find((candidate) => candidate !== "*") ?? "bash";
    const input: Record<string, unknown> =
      tool === "write" || tool === "edit"
        ? { path: join(extensionDir, ".pi-hook-test.txt"), content: "pi hook test" }
        : { command: "printf pi-hook-test" };
    const payload = hookEnvelope(tool, input, selected.event === "tool_result" ? { content: [], isError: false } : undefined);
    const result = await executeHook(selected, tool, payload, ctx.cwd);
    const denial = denialReason(parseHookResult(result.stdout));
    if (denial) result.run.status = "blocked";
    ctx.ui.notify(
      [
        `${selected.id}: ${result.run.status} (code ${result.code ?? "-"}, ${result.run.durationMs}ms)`,
        denial ? `decision: ${denial}` : "",
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

  pi.on("session_start", async (event, ctx) => {
    injectedScopedRules.clear();
    loadState(ctx, true);
    if (event.reason === "reload" && !configError && !rulesError) ctx.ui.notify("Reloaded hooks and rules.", "info");
  });

  pi.on("before_agent_start", async (event) => {
    const unscopedRules = rules.filter((rule) => !rule.paths);
    if (unscopedRules.length === 0) return;
    return { systemPrompt: `${event.systemPrompt}\n\n## Auto-loaded Rules\n\n${formatRules(unscopedRules)}` };
  });

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
    };
  });
}
