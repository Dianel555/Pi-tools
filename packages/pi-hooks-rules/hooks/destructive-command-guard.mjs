const MAX_COMMAND_LENGTH = 65_536;
// Bound nested literal-wrapper inspection; exceeding the bound passes through as unknown syntax.
const MAX_ANALYSIS_DEPTH = 16;

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
const gitOptionsWithValue = new Set(["--git-dir", "--work-tree", "--namespace", "--exec-path"]);
const powershellPathOptions = new Set(["-path", "-literalpath"]);
const powershellValueOptions = new Set(["-erroraction", "-warningaction", "-ea", "-wa", "-include", "-exclude", "-filter"]);
const powershellRecurseNames = new Set(["-r", "-re", "-rec", "-recu", "-recur", "-recurs", "-recurse"]);
const powershellPreviewNames = new Set(["-whatif", "-wi"]);
const bashControlCommands = new Set(["if", "while", "until", "for", "then", "do", "else", "elif", "!", "coproc"]);
const bashShells = new Set(["bash", "sh", "dash", "zsh"]);

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
  return { hasDelete: false, safe: true, blocked: undefined };
}

function deleteResult(safe) {
  return { hasDelete: true, safe, blocked: undefined };
}

function blockedResult(rule) {
  return { hasDelete: false, safe: true, blocked: rule };
}

function mergeResults(left, right) {
  return {
    hasDelete: left.hasDelete || right.hasDelete,
    safe: left.safe && right.safe,
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
  let parameterBraceDepth = 0;
  let quote = "";
  let uncertain = false;

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
        if (next === undefined) {
          value += character;
          uncertain = true;
          continue;
        }
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
      if (next === undefined) {
        value += character;
        started = true;
        uncertain = true;
        continue;
      }
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
    if (dialect === "bash") {
      if (character === "$" && source[index + 1] === "{") parameterBraceDepth += 1;
      const closesParameterBrace = character === "}" && parameterBraceDepth > 0;
      if (closesParameterBrace) parameterBraceDepth -= 1;
      if (character === "(" || character === ")"
        || ((character === "{" || character === "}") && !closesParameterBrace && parameterBraceDepth === 0)) {
        pushGroup();
        continue;
      }
    }
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
  // Do not turn an incomplete final group into a confidently parsed command.
  if (quote) uncertain = true;
  if (uncertain) {
    words = [];
  } else {
    pushGroup();
  }
  return { groups, uncertain };
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

function inspectWrapperScript(script, dialect, depth) {
  if (!script.length) return noDelete();
  if (script.length === 1) return inspectSource(script[0].value, dialect, depth + 1);
  return inspectWords(script, dialect, depth + 1);
}

function inspectBashWrapper(words, depth) {
  const args = words.slice(1);
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index].value;
    if (value === "--") return noDelete();
    if (value === "-c" || /^-[^-]*c[^-]*$/.test(value)) {
      return inspectWrapperScript(args.slice(index + 1, index + 2), "bash", depth);
    }
    if (!value.startsWith("-")) return noDelete();
  }
  return noDelete();
}

const powershellCliValueOptions = new Set([
  "-configurationname", "-executionpolicy", "-inputformat", "-outputformat", "-version",
  "-windowstyle", "-workingdirectory",
]);

function inspectPowerShellWrapper(words, depth) {
  const args = words.slice(1);
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index].value.toLowerCase();
    if (["-file", "-encodedcommand", "-encodedarguments", "--"].includes(value)) return noDelete();
    if (["-c", "-command"].includes(value)) return inspectWrapperScript(args.slice(index + 1), "powershell", depth);
    if (!value.startsWith("-")) return noDelete();
    if (powershellCliValueOptions.has(value)) index += 1;
  }
  return noDelete();
}

function inspectCmdWrapper(words, depth) {
  const args = words.slice(1);
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index].value.toLowerCase();
    if (["/c", "/k"].includes(value)) return inspectWrapperScript(args.slice(index + 1), "cmd", depth);
    if (!value.startsWith("/")) return noDelete();
  }
  return noDelete();
}

function inspectShellWrapper(words, name, depth) {
  if (bashShells.has(name)) return inspectBashWrapper(words, depth);
  if (name === "cmd") return inspectCmdWrapper(words, depth);
  return inspectPowerShellWrapper(words, depth);
}

function inspectBashControl(words, depth) {
  const nested = words.slice(1);
  return nested.length ? inspectWords(nested, "bash", depth + 1) : noDelete();
}

function gitDryRun(options, subcommand) {
  for (let index = 0; index < options.length; index += 1) {
    const value = options[index];
    if (subcommand === "clean" && ["-e", "--exclude"].includes(value)) {
      index += 1;
      continue;
    }
    if (subcommand === "clean" && value.startsWith("--exclude=")) continue;
    if (value === "--dry-run" || value === "-n" || /^-[a-z]*n[a-z]*$/.test(value)) return true;
  }
  return false;
}

function gitRule(words) {
  const args = words.slice(1);
  let index = 0;
  while (index < args.length) {
    const raw = args[index].value;
    const value = raw.toLowerCase();
    if (value === "--") {
      index += 1;
      break;
    }
    if (!raw.startsWith("-")) break;

    // Git's -c and -C are case-sensitive: -c is config, while -C selects a directory.
    if (raw === "-c" || raw === "-C") {
      if (!args[index + 1]) return undefined;
      index += 2;
      continue;
    }
    if ((raw.startsWith("-c") && !raw.startsWith("-C"))
      || (raw.startsWith("-C") && raw.length > 2)) {
      index += 1;
      continue;
    }
    if (["--config", "--config-env"].includes(value)) {
      if (!args[index + 1]) return undefined;
      index += 2;
      continue;
    }
    if (["--config=", "--config-env="].some((prefix) => value.startsWith(prefix))) {
      index += 1;
      continue;
    }
    if (gitOptionsWithValue.has(value)) {
      if (!args[index + 1]) return undefined;
      index += 2;
      continue;
    }
    index += 1;
  }

  const subcommand = args[index]?.value.toLowerCase();
  if (!subcommand) return undefined;
  const rest = args.slice(index + 1).map((word) => word.value.toLowerCase());
  const optionEnd = rest.indexOf("--");
  const options = optionEnd < 0 ? rest : rest.slice(0, optionEnd);
  const dryRun = gitDryRun(options, subcommand);
  const forcedPush = options.some((value) => value.startsWith("--force") || /^-[a-z]*f[a-z]*$/.test(value))
    || rest.some((value) => value.startsWith("+"));
  if (subcommand === "push" && !dryRun && forcedPush) return "git_push_force";
  if (subcommand === "reset" && options.includes("--hard")) return "git_reset_hard";
  if (subcommand === "clean" && !dryRun
    && options.some((value) => value === "--force" || /^-[a-z]*f[a-z]*$/.test(value))) return "git_clean_force";
  if ((subcommand === "checkout" || subcommand === "restore")
    && rest.some((value) => /^\.(?:[\\/])?$/.test(value))) return "git_checkout_dot";
  if (subcommand === "branch" && options.some((value) => ["-d", "--delete"].includes(value))) return "git_branch_delete";
  if (subcommand === "stash") {
    const action = rest.find((value) => !value.startsWith("-"));
    if (["drop", "clear"].includes(action)) return "git_stash_wipe";
  }
  return undefined;
}

function bashDelete(words) {
  let recursive = false;
  let options = true;
  const targets = [];
  for (const word of words.slice(1)) {
    const value = word.value;
    const lower = value.toLowerCase();
    if (options && lower === "--") {
      options = false;
      continue;
    }
    if (options && value.startsWith("-")) {
      if (!word.dynamic
        && (lower.startsWith("--rec") || (!lower.startsWith("--") && lower.slice(1).includes("r")))) recursive = true;
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
  const args = inlineOptions.length
    ? inlineOptions.map((value) => ({ value, dynamic: false, quoted: false, singleQuoted: false }))
    : [];
  args.push(...words.slice(1));
  let recursive = false;
  const targets = [];
  for (const word of args) {
    const value = word.value;
    if (value.startsWith("/")) {
      if (value.split("/").some((option) => option.toLowerCase() === "s")) recursive = true;
      continue;
    }
    targets.push(word);
  }
  if (!recursive) return noDelete();
  if (!targets.length) return deleteResult(false);
  return deleteResult(targets.every(safeTarget));
}

function powershellRecurseFlag(value) {
  const [flag, state] = value.toLowerCase().split(":", 2);
  if (["$false", "false", "0"].includes(state)) return false;
  return powershellRecurseNames.has(flag) || (/^-[a-z]{2,3}$/.test(flag) && flag.includes("r"));
}

function powershellPreviewFlag(value) {
  const [flag, state] = value.toLowerCase().split(":", 2);
  return powershellPreviewNames.has(flag) && !["$false", "false", "0"].includes(state);
}

function powershellDelete(words) {
  let recursive = false;
  let malformed = false;
  const targets = [];
  const args = words.slice(1);
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index];
    const value = word.value;
    const lower = value.toLowerCase();
    if (lower.startsWith("-")) {
      if (powershellPreviewFlag(lower)) return noDelete();
      if (powershellRecurseFlag(lower)) recursive = true;
      const flag = lower.split(":", 1)[0];
      if (powershellPathOptions.has(flag)) {
        const next = args[index + 1];
        if (!next || next.value.startsWith("-")) {
          malformed = true;
          continue;
        }
        targets.push(...splitPowerShellTargets(next));
        index += 1;
      } else if (powershellValueOptions.has(flag)) {
        const next = args[index + 1];
        if (!next || next.value.startsWith("-")) {
          malformed = true;
          continue;
        }
        index += 1;
      }
      continue;
    }
    targets.push(...splitPowerShellTargets(word));
  }
  if (!recursive) return noDelete();
  if (malformed || !targets.length) return deleteResult(false);
  return deleteResult(targets.every(safeTarget));
}

function bashSubstitutionEnd(source, start, kind) {
  if (kind === "backtick") {
    for (let index = start + 1; index < source.length; index += 1) {
      if (source[index] === "\\") {
        index += 1;
      } else if (source[index] === "`") {
        return index;
      }
    }
    return -1;
  }

  let parentheses = 1;
  let quote = "";
  for (let index = start + 2; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === "\\" && quote === '"') {
        index += 1;
      } else if (character === quote) {
        quote = "";
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
    } else if (character === "\\") {
      index += 1;
    } else if (character === "(" && source[index - 1] === "$") {
      parentheses += 1;
    } else if (character === ")") {
      parentheses -= 1;
      if (!parentheses) return index;
    }
  }
  return -1;
}

function bashHereDocSpec(source, start) {
  let index = start + 2;
  const stripTabs = source[index] === "-";
  if (stripTabs) index += 1;
  while (/[ \t]/.test(source[index] ?? "")) index += 1;
  if (index >= source.length || source[index] === "\n") return undefined;

  let delimiter;
  if (source[index] === "'" || source[index] === '"') {
    const quote = source[index++];
    const begin = index;
    while (index < source.length && source[index] !== quote) index += 1;
    if (index >= source.length) return undefined;
    delimiter = source.slice(begin, index);
  } else {
    const begin = index;
    while (index < source.length && !/[ \t\r\n;|&<>]/.test(source[index])) index += 1;
    delimiter = source.slice(begin, index);
  }
  if (!delimiter) return undefined;
  const headerEnd = source.indexOf("\n", index);
  return { delimiter, stripTabs, headerEnd, bodyStart: headerEnd < 0 ? source.length : headerEnd + 1 };
}

function hasAnotherBashHereDoc(source, start, headerEnd) {
  if (headerEnd < 0) return false;
  let quote = "";
  for (let index = start + 2; index < headerEnd; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === "\\" && quote === '"') index += 1;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === "'" || character === '"') quote = character;
    else if (character === "\\") index += 1;
    else if (source.startsWith("<<", index) && source[index + 2] !== "<") return true;
  }
  return false;
}

function maskBashHereDocs(source) {
  const chars = source.split("");
  let quote = "";
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === "\\" && quote === '"') index += 1;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
    } else if (character === "\\") {
      index += 1;
    } else if (source.startsWith("<<", index) && source[index + 2] !== "<") {
      const spec = bashHereDocSpec(source, index);
      if (!spec) continue;
      if (hasAnotherBashHereDoc(source, index, spec.headerEnd)) {
        // Multiple pending heredocs need shell-order semantics; skip the rest rather than reading data as commands.
        for (let cursor = spec.bodyStart; cursor < source.length; cursor += 1) {
          if (chars[cursor] !== "\n") chars[cursor] = " ";
        }
        break;
      }
      let lineStart = spec.bodyStart;
      let terminatorStart = -1;
      let terminatorEnd = source.length;
      while (lineStart < source.length) {
        const lineEnd = source.indexOf("\n", lineStart);
        const end = lineEnd < 0 ? source.length : lineEnd;
        let candidate = source.slice(lineStart, end).replace(/\r$/, "");
        if (spec.stripTabs) candidate = candidate.replace(/^\t+/, "");
        if (candidate === spec.delimiter) {
          terminatorStart = lineStart;
          terminatorEnd = lineEnd < 0 ? source.length : lineEnd + 1;
          break;
        }
        if (lineEnd < 0) break;
        lineStart = lineEnd + 1;
      }
      const maskEnd = terminatorStart < 0 ? source.length : terminatorEnd;
      for (let cursor = spec.bodyStart; cursor < maskEnd; cursor += 1) {
        if (chars[cursor] !== "\n") chars[cursor] = " ";
      }
      if (terminatorStart < 0) break;
      index = terminatorEnd - 1;
    }
  }
  return chars.join("");
}

function inspectBashSubstitutions(source, depth) {
  let result = noDelete();
  let quote = "";
  let wordStart = true;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === "\\" && quote === '"') {
        index += 1;
        continue;
      }
      if (character === quote) {
        quote = "";
        continue;
      }
      if (quote === '"' && source.startsWith("$(", index)) {
        const end = bashSubstitutionEnd(source, index, "dollar");
        if (end < 0) break;
        result = mergeResults(result, inspectSource(source.slice(index + 2, end), "bash", depth + 1));
        index = end;
      } else if (quote === '"' && character === "`") {
        const end = bashSubstitutionEnd(source, index, "backtick");
        if (end < 0) break;
        result = mergeResults(result, inspectSource(source.slice(index + 1, end), "bash", depth + 1));
        index = end;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      wordStart = false;
    } else if (character === "#" && wordStart) {
      while (index < source.length && source[index] !== "\n") index += 1;
      wordStart = true;
    } else if (character === "\\") {
      index += 1;
      wordStart = false;
    } else if (";|&\n".includes(character)) {
      wordStart = true;
    } else if (/\s/.test(character)) {
      wordStart = true;
    } else if (source.startsWith("$(", index)) {
      const end = bashSubstitutionEnd(source, index, "dollar");
      if (end < 0) break;
      result = mergeResults(result, inspectSource(source.slice(index + 2, end), "bash", depth + 1));
      index = end;
      wordStart = false;
    } else if (character === "`") {
      const end = bashSubstitutionEnd(source, index, "backtick");
      if (end < 0) break;
      result = mergeResults(result, inspectSource(source.slice(index + 1, end), "bash", depth + 1));
      index = end;
      wordStart = false;
    } else if ((character === "<" || character === ">") && source[index + 1] === "(") {
      const end = bashSubstitutionEnd(source, index + 1, "dollar");
      if (end < 0) break;
      result = mergeResults(result, inspectSource(source.slice(index + 2, end), "bash", depth + 1));
      index = end;
      wordStart = false;
    } else {
      wordStart = false;
    }
  }
  return result;
}

function inspectWords(words, dialect, depth = 0) {
  if (depth > MAX_ANALYSIS_DEPTH) return noDelete();
  let commandWords = words;
  if (dialect === "bash") {
    let index = 0;
    while (index < commandWords.length && /^[a-z_][a-z0-9_]*\+?=/i.test(commandWords[index].value)) index += 1;
    commandWords = commandWords.slice(index);
  }
  if (dialect === "cmd" && commandWords[0]?.value.startsWith("@")) {
    commandWords = [{ ...commandWords[0], value: commandWords[0].value.replace(/^@+/, "") }, ...commandWords.slice(1)];
  }
  if (!commandWords.length || commandWords[0].dynamic) return noDelete();

  const name = commandName(commandWords[0], dialect);
  if (dialect === "bash" && bashControlCommands.has(name)) return inspectBashControl(commandWords, depth);
  if (bashShells.has(name) || ["cmd", "powershell", "pwsh"].includes(name)) {
    return inspectShellWrapper(commandWords, name === "pwsh" ? "powershell" : name, depth);
  }
  if (name === "git") {
    const rule = gitRule(commandWords);
    return rule ? blockedResult(rule) : noDelete();
  }
  if (dialect === "bash" && name === "rm") return bashDelete(commandWords);
  if (dialect === "cmd" && cmdDeletes.has(name)) return cmdDelete(commandWords);
  if (dialect === "powershell" && powershellDeletes.has(name)) return powershellDelete(commandWords);
  return noDelete();
}

function inspectSource(source, dialect, depth = 0) {
  if (depth > MAX_ANALYSIS_DEPTH) return noDelete();
  const analyzedSource = dialect === "bash" ? maskBashHereDocs(source) : source;
  let result = dialect === "bash" ? inspectBashSubstitutions(analyzedSource, depth) : noDelete();
  const { groups } = lex(analyzedSource, dialect);
  for (const group of groups) result = mergeResults(result, inspectWords(group, dialect, depth));
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
  if (result.hasDelete) {
    if (result.safe) decision("allow", "all targets are throwaway temp/build/test artifacts");
    else deny("recursive_delete", deleteAdvice);
  }
} catch {
  // This is an accident guard, not a shell interpreter. Unknown syntax passes through.
  process.exit(0);
}
