const MAX_COMMAND_LENGTH = 65_536;

const deleteAdvice = "Recursive delete is blocked. Run cleanup of throwaway artifacts as a standalone command; otherwise remove specific files or ask the user to run it manually.";
const gitAdvice = "This git operation is reserved for the user. Ask the user to run it manually.";
const safeDirectories = new Set([
  "node_modules", "dist", "build", "out", "target", "coverage", "htmlcov", "__pycache__",
  ".pytest_cache", ".mypy_cache", ".ruff_cache", ".tox", ".cache", ".next", ".nuxt",
  ".output", ".turbo", ".vite", ".parcel-cache", ".nyc_output", "test-results", "test-output",
  "playwright-report", "tmp", "temp", ".tmp", ".temp",
]);
const powershellDeletes = new Set(["remove-item", "ri", "rm", "rmdir", "rd", "del", "erase"]);
const cmdDeletes = new Set(["del", "erase", "rmdir", "rd"]);
const gitOptionsWithValue = new Set(["-c", "-C", "--config", "--config-env", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);
const powershellPathOptions = new Set(["-path", "-literalpath"]);
const powershellValueOptions = new Set(["-erroraction", "-warningaction", "-ea", "-wa", "-include", "-exclude", "-filter"]);
const powershellRecurseNames = new Set(["-r", "-re", "-rec", "-recu", "-recur", "-recurs", "-recurse"]);
const controlCommands = new Set(["if", "while", "until", "for", "then", "do", "else", "elif", "!", "coproc", "call", "start"]);

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

function deny(rule, advice) {
  decision("deny", `blocked ${rule}. ${advice}`);
  process.exit(0);
}

function noDelete() {
  return { hasDelete: false, safe: true, deleteOnly: false, opaque: false, blocked: undefined };
}

function deleteResult(safe, deleteOnly = true) {
  return { hasDelete: true, safe, deleteOnly, opaque: false, blocked: undefined };
}

function opaqueResult() {
  return { hasDelete: false, safe: false, deleteOnly: false, opaque: true, blocked: undefined };
}

function blockedResult(rule) {
  return { hasDelete: false, safe: false, deleteOnly: false, opaque: false, blocked: rule };
}

function mergeResults(left, right) {
  const hasDelete = left.hasDelete || right.hasDelete;
  return {
    hasDelete,
    safe: left.safe && right.safe,
    deleteOnly: hasDelete
      && (left.hasDelete ? left.deleteOnly : true)
      && (right.hasDelete ? right.deleteOnly : true),
    opaque: left.opaque || right.opaque,
    blocked: left.blocked || right.blocked,
  };
}

function executable(value) {
  return value.toLowerCase().split(/[\\/]/).pop().replace(/\.(?:exe|cmd|bat)$/, "");
}

function commandName(word, dialect) {
  let value = word.value.toLowerCase();
  if (dialect === "cmd") {
    value = value.replace(/^@+/, "");
    const deleteCommand = /^(del|erase|rmdir|rd)(?=\/|$)/.exec(value);
    if (deleteCommand) return deleteCommand[1];
  }
  return executable(value);
}

function skipRedirection(source, start) {
  let index = start;
  while (/[<>]/.test(source[index] ?? "")) index += 1;
  if (source[index] === "&") index += 1;
  while (/\s/.test(source[index] ?? "")) index += 1;
  if (source[index] === "\"" || source[index] === "'") {
    const quote = source[index++];
    while (index < source.length && source[index] !== quote) index += 1;
    return Math.min(index + 1, source.length);
  }
  while (index < source.length && !/\s/.test(source[index]) && !";|&".includes(source[index])) index += 1;
  return index;
}

function lex(source, dialect) {
  const groups = [];
  let words = [];
  let value = "";
  let parts = [];
  let started = false;
  let quoted = false;
  let singleQuoted = false;
  let dynamic = false;
  let quote = "";
  let opaqueSyntax = false;

  function pushWord() {
    if (!started) return;
    words.push({
      value: parts.length ? [...parts, value].join(",") : value,
      parts: parts.length ? [...parts, value] : undefined,
      quoted,
      singleQuoted,
      dynamic,
    });
    value = "";
    parts = [];
    started = false;
    quoted = false;
    singleQuoted = false;
    dynamic = false;
  }

  function pushGroup() {
    pushWord();
    if (words.length) groups.push(words);
    words = [];
  }

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if ((dialect === "bash" && character === "\\" && quote !== "'")
        || (dialect === "powershell" && character === "`" && quote !== "'")) {
        const next = source[index + 1];
        if (next === undefined) throw new Error("unfinished escape");
        index += 1;
        value += next;
      } else if (dialect === "powershell" && quote === "'" && character === "'" && source[index + 1] === "'") {
        value += "'";
        index += 1;
      } else if (character === quote) {
        quote = "";
      } else {
        value += character;
        if (dialect !== "cmd" && quote !== "'" && (character === "$" || character === "`")) dynamic = true;
        if (dialect === "cmd" && (character === "%" || character === "!")) dynamic = true;
      }
      continue;
    }

    if ((dialect === "bash" && character === "\\")
      || (dialect === "powershell" && character === "`")
      || (dialect === "cmd" && character === "^")) {
      const next = source[index + 1];
      if (next === undefined) throw new Error("unfinished escape");
      index += 1;
      value += next;
      started = true;
      continue;
    }
    if (character === '"' || (character === "'" && dialect !== "cmd")) {
      quote = character;
      quoted = true;
      singleQuoted ||= character === "'";
      started = true;
      continue;
    }
    if (character === "#" && !started && dialect !== "cmd") {
      while (index < source.length && source[index] !== "\n") index += 1;
      pushGroup();
      continue;
    }
    if (character === ">" || character === "<") {
      if (/^\d+$/.test(value)) {
        value = "";
        started = false;
      } else {
        pushWord();
      }
      index = skipRedirection(source, index) - 1;
      continue;
    }
    if (dialect === "powershell" && character === "&") opaqueSyntax = true;
    if (dialect === "bash" && character === "{" && source.slice(index).includes(",")) opaqueSyntax = true;
    if (dialect === "powershell" && (character === "(" || character === ")")) dynamic = true;
    if (dialect === "powershell" && character === "@") dynamic = true;
    if (dialect !== "cmd" && (character === "$" || character === "`")) dynamic = true;
    if (dialect === "cmd" && (character === "%" || character === "!")) dynamic = true;
    if (";|&\n".includes(character)) {
      pushGroup();
      continue;
    }
    if (dialect === "powershell" && character === ",") {
      parts.push(value);
      value = "";
      started = true;
      continue;
    }
    if (/\s/.test(character)) {
      pushWord();
      continue;
    }
    value += character;
    started = true;
  }
  if (quote) throw new Error("unclosed quote");
  pushGroup();
  return { groups, opaqueSyntax };
}

function safeTarget(word) {
  let target = word.value.toLowerCase().trim();
  if (!target || target.includes("..")) return false;
  const tempVariable = /^(?:\$env:te?mp|%te?mp%)[\\/](.+)$/.exec(target);
  if (tempVariable) {
    if (word.singleQuoted || /["'`$%!;&|<>(){}*?\r\n]/.test(tempVariable[1])) return false;
    return true;
  }
  if (/["'`$%!;&|<>(){}*?\r\n]/.test(target)) return false;
  if (/^(?:\/tmp|\/var\/tmp|\/dev\/shm)\/.+/.test(target)) return true;
  if (/(?:^|[\\/])appdata[\\/]local[\\/]temp[\\/].+/.test(target)) return true;
  if (/^[a-z]:[\\/]windows[\\/]temp[\\/].+/.test(target)) return true;
  target = target.replace(/[\\/]+$/g, "");
  if (!target) return false;
  const components = target.split(/[\\/]+/).filter(Boolean);
  const base = components.at(-1) ?? "";
  return components.some((component) => safeDirectories.has(component))
    || /\.(?:tmp|temp|bak|log|pyc|pyo|swp)$/.test(base)
    || [".ds_store", "thumbs.db", ".eslintcache"].includes(base);
}

function splitPowerShellTargets(word) {
  return (word.parts ?? [word.value]).map((value) => ({ ...word, value, parts: undefined }));
}

function gitRule(words) {
  const args = words.slice(1);
  if (args.some((word) => word.dynamic || (!word.quoted && word.value.startsWith("@")))) return "opaque";
  if (args.some((word) => {
    const value = word.value.toLowerCase();
    return value === "-c" || value.startsWith("-c")
      || value === "--config" || value.startsWith("--config=")
      || value === "--config-env" || value.startsWith("--config-env=");
  })) return "opaque";

  let index = 0;
  while (index < args.length) {
    const value = args[index].value.toLowerCase();
    if (value === "--") {
      index += 1;
      break;
    }
    if (!value.startsWith("-")) break;
    if (gitOptionsWithValue.has(value)) {
      if (!args[index + 1]) return "opaque";
      index += 2;
    } else {
      index += 1;
    }
  }
  const subcommand = args[index]?.value.toLowerCase();
  if (!subcommand) return undefined;
  const rest = args.slice(index + 1).map((word) => word.value.toLowerCase());
  if (subcommand === "commit") return "git_commit";
  if (subcommand === "push" && rest.some((value) => value.startsWith("--force") || value.startsWith("+") || /^-[a-z]*f[a-z]*$/.test(value))) return "git_push_force";
  if (subcommand === "reset" && rest.includes("--hard")) return "git_reset_hard";
  if (subcommand === "clean" && rest.some((value) => value === "--force" || /^-[a-z]*f[a-z]*$/.test(value))) return "git_clean_force";
  if ((subcommand === "checkout" || subcommand === "restore") && rest.some((value) => /^\.(?:[\\/])?$/.test(value))) return "git_checkout_dot";
  if (subcommand === "branch" && rest.some((value) => ["-d", "--delete"].includes(value))) return "git_branch_delete";
  if (subcommand === "stash" && ["drop", "clear"].includes(rest[0])) return "git_stash_wipe";
  return undefined;
}

function bashDelete(words) {
  let recursive = false;
  let options = true;
  const targets = [];
  for (const word of words.slice(1)) {
    const value = word.value;
    const lower = value.toLowerCase();
    if (word.dynamic) return opaqueResult();
    if (options && lower === "--") {
      options = false;
      continue;
    }
    if (options && value.startsWith("-")) {
      if (lower.startsWith("--rec") || (!lower.startsWith("--") && lower.slice(1).includes("r"))) recursive = true;
      continue;
    }
    targets.push(word);
  }
  if (!recursive) return noDelete();
  if (!targets.length) return deleteResult(false);
  return deleteResult(targets.every(safeTarget));
}

function cmdDelete(words) {
  const first = words[0].value.toLowerCase().replace(/^@+/, "");
  const inlineOptions = first.replace(/^(?:del|erase|rmdir|rd)/, "").split("/").filter(Boolean).map((value) => `/${value}`);
  const args = inlineOptions.length ? inlineOptions.map((value) => ({ value, dynamic: false, quoted: false, singleQuoted: false })) : [];
  args.push(...words.slice(1));
  let recursive = false;
  const targets = [];
  for (const word of args) {
    const value = word.value;
    if (value.startsWith("/")) {
      if (word.dynamic) return opaqueResult();
      if (/^\/s$/i.test(value)) recursive = true;
      continue;
    }
    targets.push(word);
  }
  if (targets.some((word) => word.dynamic && !safeTarget(word))) return opaqueResult();
  if (!recursive) return noDelete();
  if (!targets.length) return deleteResult(false);
  return deleteResult(targets.every(safeTarget));
}

function powershellRecurseFlag(value) {
  const [flag, state] = value.toLowerCase().split(":", 2);
  if (["$false", "false", "0"].includes(state)) return false;
  return powershellRecurseNames.has(flag) || (/^-[a-z]{2,3}$/.test(flag) && flag.includes("r"));
}

function powershellDelete(words) {
  let recursive = false;
  let opaque = false;
  const targets = [];
  const args = words.slice(1);
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index];
    const value = word.value;
    const lower = value.toLowerCase();
    if (lower.startsWith("-")) {
      opaque ||= word.dynamic;
      if (powershellRecurseFlag(lower)) recursive = true;
      const flag = lower.split(":", 1)[0];
      if (powershellPathOptions.has(flag)) {
        const next = args[index + 1];
        if (!next) return deleteResult(false);
        targets.push(...splitPowerShellTargets(next));
        index += 1;
      } else if (powershellValueOptions.has(flag)) {
        if (!args[index + 1]) return deleteResult(false);
        if (["-include", "-exclude", "-filter"].includes(flag)) opaque = true;
        index += 1;
      }
      continue;
    }
    targets.push(...splitPowerShellTargets(word));
  }
  if (targets.some((word) => word.dynamic && !safeTarget(word))) opaque = true;
  if (valueHasSplat(words)) opaque = true;
  if (opaque) return opaqueResult();
  if (!recursive) return noDelete();
  if (!targets.length) return deleteResult(false);
  return deleteResult(targets.every(safeTarget));
}

function valueHasSplat(words) {
  return words.slice(1).some((word) => word.value.startsWith("@"));
}

function inspectWords(words, dialect) {
  let commandWords = words;
  if (dialect === "bash") {
    let index = 0;
    while (index < commandWords.length && /^[a-z_][a-z0-9_]*=/i.test(commandWords[index].value)) index += 1;
    commandWords = commandWords.slice(index);
  }
  if (dialect === "cmd" && commandWords[0]?.value.startsWith("@")) {
    commandWords = [{ ...commandWords[0], value: commandWords[0].value.replace(/^@+/, "") }, ...commandWords.slice(1)];
  }
  if (!commandWords.length) return noDelete();
  if (commandWords[0].dynamic) return opaqueResult();

  const name = commandName(commandWords[0], dialect);
  if (controlCommands.has(name)) return opaqueResult();
  if (["eval", "source", ".", "xargs"].includes(name)) return opaqueResult();
  if (name === "find" && commandWords.slice(1).some((word) => ["-delete", "-exec", "-execdir"].includes(word.value.toLowerCase()))) return opaqueResult();
  if (["node", "nodejs", "python", "python3", "perl", "ruby"].includes(name)
    && commandWords.slice(1).some((word) => ["-c", "-e", "--eval"].includes(word.value.toLowerCase()))) return opaqueResult();
  if (dialect === "powershell" && ["invoke-expression", "iex"].includes(name)) return opaqueResult();
  if (["bash", "sh", "dash", "zsh", "cmd", "powershell", "pwsh"].includes(name)) return opaqueResult();
  if (["command", "builtin", "exec", "nohup", "sudo", "doas", "env", "busybox", "time"].includes(name)) return opaqueResult();
  if (name === "git") {
    const rule = gitRule(commandWords);
    return rule === "opaque" ? opaqueResult() : rule ? blockedResult(rule) : noDelete();
  }
  if (dialect === "bash" && name === "rm") return bashDelete(commandWords);
  if (dialect === "cmd" && cmdDeletes.has(name)) return cmdDelete(commandWords);
  if (dialect === "powershell" && powershellDeletes.has(name)) return powershellDelete(commandWords);
  if (commandWords.some((word) => word.dynamic)) return opaqueResult();
  return noDelete();
}

function inspectSource(source, dialect) {
  const { groups, opaqueSyntax } = lex(source, dialect);
  let result = noDelete();
  for (const group of groups) result = mergeResults(result, inspectWords(group, dialect));
  if (opaqueSyntax) result.opaque = true;
  if (result.hasDelete && groups.length !== 1) result.deleteOnly = false;
  return result;
}

let raw = "";
for await (const chunk of process.stdin) raw += chunk;

let input;
try {
  input = JSON.parse(raw || "{}");
} catch {
  process.stderr.write("destructive-command-guard: invalid JSON input\n");
  process.exit(2);
}

const command = input?.tool_input?.command;
if (typeof command !== "string" || command.length > MAX_COMMAND_LENGTH) {
  deny("invalid_command", "Command input is invalid or too large.");
}
if (!command.trim()) process.exit(0);

const tool = String(input?.tool_name ?? "").toLowerCase();
const dialect = ["powershell", "pwsh"].includes(tool)
  ? "powershell"
  : ["cmd", "cmd.exe"].includes(tool)
    ? "cmd"
    : "bash";

try {
  const result = inspectSource(command, dialect);
  if (result.blocked) deny(result.blocked, gitAdvice);
  if (result.opaque) deny("opaque_command", "Command safety could not be proven by static analysis; request manual review.");
  if (result.hasDelete) {
    if (result.safe && result.deleteOnly) decision("allow", "all targets are throwaway temp/build/test artifacts");
    else deny("recursive_delete", deleteAdvice);
  }
} catch {
  deny("opaque_command", "Command safety could not be proven by static analysis; request manual review.");
}
