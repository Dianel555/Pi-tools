let raw = "";
for await (const chunk of process.stdin) raw += chunk;

let input;
try {
  input = JSON.parse(raw || "{}");
} catch {
  process.stderr.write("destructive-command-guard: invalid JSON input\n");
  process.exit(2);
}

const tool = String(input?.tool_name ?? "").toLowerCase();
const command = String(input?.tool_input?.command ?? "");
if (!command) process.exit(0);

const deleteAdvice = "Recursive delete is blocked. Run cleanup of throwaway artifacts as a standalone command; otherwise remove specific files or ask the user to run it manually.";
const gitAdvice = "This git operation is reserved for the user. Ask the user to run it manually.";
const deleteCommands = new Set(["rm", "rmdir", "remove-item", "ri", "del", "erase", "rd"]);
const safeDirectories = new Set([
  "node_modules", "dist", "build", "out", "target", "coverage", "htmlcov", "__pycache__",
  ".pytest_cache", ".mypy_cache", ".ruff_cache", ".tox", ".cache", ".next", ".nuxt",
  ".output", ".turbo", ".vite", ".parcel-cache", ".nyc_output", "test-results", "test-output",
  "playwright-report", "tmp", "temp", ".tmp", ".temp",
]);

function decision(permissionDecision, reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision,
      permissionDecisionReason: `destructive-command-guard: ${reason}`,
    },
    ...(permissionDecision === "deny" ? { systemMessage: `[destructive-command-guard] ${reason}` } : {}),
  }));
}

function deny(name, advice) {
  decision("deny", `blocked ${name}. ${advice}`);
  process.exit(0);
}

function segments(value) {
  return value.split(/&&|\|\||[;&|]/).map((segment) => segment.trim()).filter(Boolean);
}

function tokens(segment) {
  return (segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((token) => token.replace(/^[({]+|[)}]+$/g, ""));
}

function unquote(value) {
  return value.replace(/^["']|["']$/g, "");
}

function normalizedToken(value) {
  const lower = unquote(value).toLowerCase();
  return ["git", "git.exe"].includes(lower.split(/[\\/]/).pop()) ? "git" : lower;
}

function gitRule(value) {
  for (const segment of segments(value)) {
    const original = tokens(segment);
    const lower = original.map(normalizedToken);
    const git = lower.indexOf("git");
    if (git < 0) continue;
    const rest = lower.slice(git + 1);
    const rawRest = original.slice(git + 1);
    const has = (name) => rest.includes(name);
    if (has("commit")) return "git_commit";
    if (has("push") && rest.some((token) => token.startsWith("--force") || /^-[a-z]*f[a-z]*$/i.test(token))) return "git_push_force";
    if (has("reset") && has("--hard")) return "git_reset_hard";
    if (has("clean") && rest.some((token) => token === "--force" || /^-[a-z]*f[a-z]*$/i.test(token))) return "git_clean_force";
    if ((has("checkout") || has("restore")) && rest.includes(".")) return "git_checkout_dot";
    if (has("branch") && rawRest.some((token) => token.toLowerCase() === "-d")) return "git_branch_delete";
    const stash = rest.indexOf("stash");
    if (stash >= 0 && ["drop", "clear"].includes(rest[stash + 1] ?? "")) return "git_stash_wipe";
  }
}

function safeTarget(value) {
  let target = unquote(value).toLowerCase();
  if (!target || target.includes("..")) return false;
  if (/^(?:\/tmp|\/var\/tmp|\/dev\/shm)\/.+/.test(target)) return true;
  if (/(?:^|[\\/])appdata[\\/]local[\\/]temp[\\/].+/.test(target)) return true;
  if (/^[a-z]:[\\/]windows[\\/]temp[\\/].+/.test(target)) return true;
  if (/^(?:\$env:te?mp|%te?mp%)[\\/].+/.test(target)) return true;
  if (target.includes("$") || target.includes("%")) return false;
  target = target.replace(/[\\/*]+$/g, "");
  if (!target) return false;
  const base = target.split(/[\\/]/).pop() ?? "";
  return safeDirectories.has(base) || /\.(?:tmp|temp|bak|log|pyc|pyo|swp)$/.test(base) || [".ds_store", "thumbs.db", ".eslintcache"].includes(base);
}

function analyzeDeletes(value) {
  if (value.includes("$(") || value.includes("`")) return { hasDelete: true, safe: false, pure: false };
  let hasDelete = false;
  let safe = true;
  let pure = true;
  for (const segment of segments(value)) {
    const values = tokens(segment);
    const lower = values.map(normalizedToken);
    const first = lower[0];
    const deleteIndex = lower.findIndex((token) => deleteCommands.has(token));
    if (!deleteCommands.has(first)) {
      pure = false;
      if (deleteIndex >= 0) {
        hasDelete = true;
        safe = false;
      }
      continue;
    }
    hasDelete = true;
    let skipNext = false;
    let targets = 0;
    for (let index = 1; index < values.length; index++) {
      const value = values[index];
      const lowerValue = lower[index];
      if (skipNext) {
        skipNext = false;
        continue;
      }
      if (lowerValue.startsWith("-")) {
        if (["-erroraction", "-warningaction", "-ea", "-wa", "-include", "-exclude", "-filter"].includes(lowerValue)) skipNext = true;
        continue;
      }
      for (const target of value.split(",").filter(Boolean)) {
        targets++;
        if (!safeTarget(target)) safe = false;
      }
    }
    if (targets === 0) safe = false;
  }
  return { hasDelete, safe, pure: pure && hasDelete };
}

function bashRecursiveForce(value) {
  for (const segment of segments(value)) {
    const values = tokens(segment);
    const lower = values.map(normalizedToken);
    const rm = lower.indexOf("rm");
    if (rm < 0) continue;
    let recursive = false;
    let force = false;
    for (const flag of lower.slice(rm + 1).filter((token) => token.startsWith("-"))) {
      if (flag === "--recursive") recursive = true;
      else if (flag === "--force") force = true;
      else if (!flag.startsWith("--")) {
        recursive ||= flag.slice(1).includes("r");
        force ||= flag.slice(1).includes("f");
      }
    }
    if (recursive && force) return true;
  }
  return false;
}

function powershellRecursive(value) {
  const recurse = /^-r(?:e(?:c(?:u(?:r(?:s(?:e)?)?)?)?)?)?$/i;
  const enabledRecurse = (token) => {
    const [name, switchValue] = normalizedToken(token).split(":", 2);
    return recurse.test(name) && (switchValue === undefined || ["$true", "true", "1"].includes(switchValue));
  };
  for (const segment of segments(value)) {
    const values = tokens(segment);
    const lower = values.map(normalizedToken);
    const commandIndex = lower.findIndex((token) => deleteCommands.has(token));
    if (commandIndex >= 0 && values.slice(commandIndex + 1).some(enabledRecurse)) return true;
  }
  return false;
}

const protectedGit = gitRule(command);
if (protectedGit) deny(protectedGit, gitAdvice);

const deletes = analyzeDeletes(command);
const destructiveDelete = tool === "bash" ? bashRecursiveForce(command) : tool === "powershell" ? powershellRecursive(command) : false;
if (destructiveDelete) {
  if (deletes.safe && deletes.pure) decision("allow", "all targets are throwaway temp/build/test artifacts");
  else deny(tool === "powershell" ? "ps_recursive_delete" : "rm_recursive_force", deleteAdvice);
}
