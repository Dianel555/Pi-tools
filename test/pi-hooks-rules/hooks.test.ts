import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const hooksDir = join(repoRoot, "packages", "pi-hooks-rules", "hooks");

function runHook(name: string, payload: unknown, cwd = repoRoot) {
  return spawnSync(process.execPath, [join(hooksDir, name)], {
    cwd,
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
}

function parseDecision(result: ReturnType<typeof runHook>, command: string) {
  assert.equal(result.status, 0, `${command}\nstderr: ${result.stderr}`);
  assert.ok(result.stdout, `${command}\nstderr: ${result.stderr}`);
  return JSON.parse(result.stdout).hookSpecificOutput.permissionDecision;
}

test("secret guard denies credential-shaped content", () => {
  const secret = `sk-ant-${"A".repeat(24)}`;
  const result = runHook("secret-guard.mjs", { tool_name: "Write", tool_input: { content: secret } });
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, "deny");
});

test("secret guard allows deleting an existing credential but denies inserting one", () => {
  const secret = `sk-ant-${"A".repeat(24)}`;
  const removed = runHook("secret-guard.mjs", {
    tool_name: "Edit",
    tool_input: { old_string: secret, new_string: "process.env.API_KEY" },
  });
  assert.equal(removed.status, 0);
  assert.equal(removed.stdout, "");

  const inserted = runHook("secret-guard.mjs", {
    tool_name: "Edit",
    tool_input: { old_string: "safe text", new_string: secret },
  });
  assert.equal(inserted.status, 0);
  assert.equal(JSON.parse(inserted.stdout).hookSpecificOutput.permissionDecision, "deny");
});

test("destructive guard blocks recursive deletion outside disposable targets", () => {
  const denied = [
    ["Bash", "rm -fr important-data"],
    ["Bash", "rm -r \"$TARGET\""],
    ["PowerShell", "Remove-Item important -Recurse"],
    ["PowerShell", "Remove-Item $(Get-Target) -Recurse"],
    ["Cmd", "rmdir /s /q important-data"],
    ["Cmd", "rmdir /s /q %TARGET%"],
  ];
  for (const [tool_name, command] of denied) {
    const result = runHook("destructive-command-guard.mjs", { tool_name, tool_input: { command } });
    assert.equal(parseDecision(result, command), "deny", command);
    assert.match(JSON.parse(result.stdout).hookSpecificOutput.permissionDecisionReason, /blocked recursive_delete/, command);
  }

  const allowed = [
    ["Bash", "rm -rf node_modules"],
    ["Bash", "echo done && rm -rf node_modules"],
    ["PowerShell", "Remove-Item node_modules -Recurse"],
    ["Cmd", "rmdir /s /q node_modules"],
  ];
  for (const [tool_name, command] of allowed) {
    assert.equal(parseDecision(
      runHook("destructive-command-guard.mjs", { tool_name, tool_input: { command } }),
      command,
    ), "allow", command);
  }

  for (const [tool_name, command] of [
    ["Bash", "rm -f important-data"],
    ["PowerShell", "Remove-Item important-data"],
    ["Cmd", "del important-data"],
  ]) {
    const result = runHook("destructive-command-guard.mjs", { tool_name, tool_input: { command } });
    assert.equal(result.status, 0, command);
    assert.equal(result.stdout, "", command);
  }
});

test("destructive guard handles mixed-case protected Git commands", () => {
  const denied = [
    ["git PUSH --FORCE", "git_push_force"],
    ["git PUSH --FORCE-WITH-LEASE", "git_push_force"],
    ["git RESET --HARD", "git_reset_hard"],
    ["git.exe RESET --HARD", "git_reset_hard"],
    ["git CLEAN -F", "git_clean_force"],
    ["git CHECKOUT \".\"", "git_checkout_dot"],
    ["git BRANCH -D old", "git_branch_delete"],
    ["git STASH CLEAR", "git_stash_wipe"],
    ["git push origin +HEAD:main", "git_push_force"],
    ["git reset --hard \"$REF\"", "git_reset_hard"],
    ["git push --force \"$REMOTE\"", "git_push_force"],
  ] as const;
  for (const [command, rule] of denied) {
    for (const tool_name of ["Bash", "PowerShell", "Cmd"]) {
      const result = runHook("destructive-command-guard.mjs", { tool_name, tool_input: { command } });
      assert.equal(result.status, 0, `${tool_name}: ${command}`);
      assert.equal(parseDecision(result, command), "deny", `${tool_name}: ${command}`);
      assert.match(JSON.parse(result.stdout).hookSpecificOutput.permissionDecisionReason, new RegExp(`blocked ${rule}`), command);
    }
  }
});

test("destructive guard distinguishes Git -C/config options and ordinary commands", () => {
  const routine = [
    "git -C C:/Users/Yanghao/.pi/agent status --short",
    'git -C "C:/Users/Yanghao/.pi/agent" status --short',
    "git -C C:/repo -C sub status --short",
    "git -c user.name=Alice status",
    'git -c "$CONFIG" status',
    "git --config user.name=Alice status",
    "git log -C",
    "git status -- -cache.txt",
    "git commit -m test",
    "git -c alias.wipe=reset wipe --hard",
  ];
  for (const tool_name of ["Bash", "PowerShell", "Cmd"]) {
    for (const command of routine) {
      const result = runHook("destructive-command-guard.mjs", { tool_name, tool_input: { command } });
      assert.equal(result.status, 0, `${tool_name}: ${command}`);
      assert.equal(result.stdout, "", `${tool_name}: ${command}`);
    }
  }

  for (const [command, rule] of [
    ["git -C C:/repo reset --hard", "git_reset_hard"],
    ["git -c user.name=Alice reset --hard", "git_reset_hard"],
    ["git --config user.name=Alice clean -fd", "git_clean_force"],
    ["git clean -f -- -n", "git_clean_force"],
    ["git clean -f -e -n", "git_clean_force"],
  ] as const) {
    const result = runHook("destructive-command-guard.mjs", {
      tool_name: "Bash",
      tool_input: { command },
    });
    assert.equal(parseDecision(result, command), "deny", command);
    assert.match(JSON.parse(result.stdout).hookSpecificOutput.permissionDecisionReason, new RegExp(`blocked ${rule}`), command);
  }
});

test("destructive guard lets explicit preview and incomplete PowerShell commands pass", () => {
  for (const [tool_name, command] of [
    ["Bash", "git clean -ndf"],
    ["Bash", "git push --force --dry-run"],
    ["PowerShell", "Remove-Item important -Recurse -WhatIf"],
    ["PowerShell", "Remove-Item important -Recurse -WhatIf:$true"],
    ["PowerShell", "Remove-Item -Path"],
    ["PowerShell", "Remove-Item -ErrorAction"],
  ]) {
    const result = runHook("destructive-command-guard.mjs", { tool_name, tool_input: { command } });
    assert.equal(result.status, 0, command);
    assert.equal(result.stdout, "", command);
  }

  const command = "Remove-Item important -Recurse -WhatIf:$false";
  assert.equal(parseDecision(
    runHook("destructive-command-guard.mjs", { tool_name: "PowerShell", tool_input: { command } }),
    command,
  ), "deny", command);
});

test("bundled destructive guard includes Cmd tools", () => {
  const hooks = JSON.parse(readFileSync(join(repoRoot, "packages", "pi-hooks-rules", "hooks.json"), "utf8"));
  const destructive = hooks.hooks.find((hook: { id: string }) => hook.id === "destructive-command-guard");
  assert.equal(destructive?.tools.includes("cmd"), true);
});

test("destructive guard recognizes explicit operations through literal shell wrappers", () => {
  const denied = [
    ["Bash", 'bash -c "rm -rf important-data"'],
    ["Bash", 'bash -c "rm -rf $TARGET"'],
    ["Bash", 'sh -c "rm -rf important-data"'],
    ["Bash", 'cmd /c del /s /q important-data'],
    ["Bash", 'powershell -Command "Remove-Item important-data -Recurse"'],
    ["Bash", 'powershell -Command "Remove-Item $TARGET -Recurse"'],
    ["Bash", 'bash -c "git reset --hard"'],
    ["Bash", 'echo "$(rm -rf important-data)"'],
    ["Bash", "X=$(rm -rf important-data) echo safe"],
    ["Bash", "{ rm -rf important-data; }"],
    ["Bash", "( rm -rf important-data )"],
    ["Bash", "if true; then rm -rf important-data; fi"],
    ["Bash", "if true; then git reset --hard; fi"],
    ["PowerShell", 'powershell -Command "Remove-Item important-data -Recurse"'],
    ["PowerShell", "Remove-Item -Path node_modules/cache,important-data -Recurse"],
    ["PowerShell", "Remove-Item $(Get-Target) -Recurse"],
    ["Cmd", "@rmdir /s /q important-data"],
    ["Cmd", "rmdir/s/q important-data"],
  ];
  for (const [tool_name, command] of denied) {
    assert.equal(parseDecision(
      runHook("destructive-command-guard.mjs", { tool_name, tool_input: { command } }),
      command,
    ), "deny", command);
  }

  for (const [tool_name, command] of [
    ["Bash", "bash -c 'echo safe'"],
  ]) {
    const result = runHook("destructive-command-guard.mjs", { tool_name, tool_input: { command } });
    assert.equal(result.status, 0, command);
    assert.equal(result.stdout, "", command);
  }

  const allowed = [
    ["Bash", "cmd /c rmdir /s /q node_modules"],
    ["Bash", "cmd /c rmdir /s/q node_modules"],
    ["PowerShell", 'Remove-Item -LiteralPath "node_modules/cache,important-data" -Recurse'],
    ["Cmd", "rmdir /s /q node_modules"],
  ];
  for (const [tool_name, command] of allowed) {
    assert.equal(parseDecision(
      runHook("destructive-command-guard.mjs", { tool_name, tool_input: { command } }),
      command,
    ), "allow", command);
  }
});

test("destructive guard passes unknown syntax and dynamic commands through", () => {
  const allowed = [
    ["Bash", "$COMMAND --help"],
    ["Bash", "custom-tool \"$VALUE\""],
    ["Bash", "find . $OPTIONS"],
    ["Bash", "python3 -c \"$SCRIPT\""],
    ["Bash", "bash -c \"$COMMAND\""],
    ["Bash", "bash script.sh -c 'git reset --hard'"],
    ["Cmd", "if 1==1 echo git reset --hard"],
    ["Bash", "bash -lc 'echo safe'"],
    ["Bash", "bash --noprofile -c 'echo safe'"],
    ["Bash", "bash --command 'echo safe'"],
    ["Bash", "printf 'rm -rf important-data\\n' | bash -v"],
    ["Bash", "bash -v < /tmp/script"],
    ["Bash", "powershell -File script.ps1 -Command 'git reset --hard'"],
    ["PowerShell", "powershell -File script.ps1 -Command 'git reset --hard'"],
    ["Bash", "cmd script.bat /c \"git reset --hard\""],
    ["Bash", "env -S 'git reset --hard'"],
    ["Bash", "exec -a harmless rm -rf important-data"],
    ["Bash", "rm -$args important-data"],
    ["Bash", "git -c alias.wipe=reset wipe --hard"],
    ["Bash", 'echo "git reset --hard"'],
    ["Bash", 'echo "rm -rf important-data"'],
    ["Bash", 'echo \'$(rm -rf important-data)\''],
    ["Bash", `cat <<'EOF'
git reset --hard
$(rm -rf important-data)
EOF`],
    ["Bash", `cat <<A <<B
safe input
A
git reset --hard
B`],
    ["Bash", 'echo "${HOME:-/tmp}"'],
    ["Bash", '# "$(rm -rf important-data)"'],
    ["Bash", "custom-tool \"$VALUE\"; echo safe"],
    ["PowerShell", "& ('git') reset --hard"],
    ["PowerShell", "Remove-Item important-data @flags"],
    ["Cmd", "rmdir %FLAGS% important-data"],
    ["Bash", "custom-tool 'unterminated"],
    ["Bash", "git reset --hard \"unterminated"],
  ];
  for (const [tool_name, command] of allowed) {
    const result = runHook("destructive-command-guard.mjs", { tool_name, tool_input: { command } });
    assert.equal(result.status, 0, `${tool_name}: ${command}`);
    assert.equal(result.stdout, "", `${tool_name}: ${command}`);
  }
});

test("destructive guard does not let unknown syntax hide a recognized operation", () => {
  const denied = [
    ["Bash", "custom-tool \"$VALUE\"; git reset --hard"],
    ["Bash", "custom-tool \"$VALUE\" && rm -rf important-data"],
    ["Bash", "git -c \"$CONFIG\" reset --hard"],
    ["Bash", "git push --force \"$REMOTE\""],
    ["Bash", "rm -rf \"$TARGET\" && custom-tool \"$VALUE\""],
    ["Bash", "git reset --hard; custom-tool 'unterminated"],
    ["Bash", `cat <<'EOF'
git reset --hard
EOF
git reset --hard`],
    ["Bash", 'echo "$(git reset --hard)"'],
  ];
  for (const [tool_name, command] of denied) {
    assert.equal(parseDecision(
      runHook("destructive-command-guard.mjs", { tool_name, tool_input: { command } }),
      command,
    ), "deny", command);
  }
});

test("destructive guard passes through parser uncertainty and deep wrappers", () => {
  const slash = String.fromCharCode(92);
  const singleQuote = String.fromCharCode(39);
  const doubleQuote = String.fromCharCode(34);
  const quoteBash = (value: string) => {
    const single = singleQuote
      + value.split(singleQuote).join(singleQuote + slash + singleQuote + singleQuote)
      + singleQuote;
    const double = doubleQuote
      + value.split(slash).join(slash + slash)
        .split(doubleQuote).join(slash + doubleQuote)
        .split("$").join(slash + "$")
        .split("`").join(slash + "`")
      + doubleQuote;
    return single.length <= double.length ? single : double;
  };
  let command = ":";
  for (let index = 0; index < 19; index += 1) command = `bash -c ${quoteBash(command)}`;
  assert.ok(command.length < 65_536, `fixture length: ${command.length}`);

  for (const value of [command, "custom-tool 'unterminated", "bash -c \"$COMMAND"]) {
    const result = runHook("destructive-command-guard.mjs", { tool_name: "Bash", tool_input: { command: value } });
    assert.equal(result.status, 0, value);
    assert.equal(result.stdout, "", value);
  }
});

test("syntax hook reports invalid JavaScript with exit code 2", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-hook-syntax-"));
  try {
    const valid = join(root, "valid.js");
    const invalid = join(root, "invalid.js");
    writeFileSync(valid, "const valid = true;\n");
    writeFileSync(invalid, "const = ;\n");

    assert.equal(
      runHook("syntax-format-check.mjs", { tool_name: "Write", tool_input: { file_path: valid } }).status,
      0,
    );
    const result = runHook("syntax-format-check.mjs", {
      tool_name: "Write",
      tool_input: { file_path: invalid },
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /syntax-check/);
    assert.equal(readFileSync(invalid, "utf8"), "const = ;\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("syntax hook does not let optional Prettier rewrite a file", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-hook-prettier-"));
  try {
    const prettierBin = join(root, "node_modules", "prettier", "bin");
    mkdirSync(prettierBin, { recursive: true });
    writeFileSync(
      join(prettierBin, "prettier.cjs"),
      [
        'const { writeFileSync } = require("node:fs");',
        'if (process.argv.includes("--write")) writeFileSync(process.argv.at(-1), "rewritten\\n");',
      ].join("\n"),
    );
    const file = join(root, "sample.js");
    const source = "const value={answer:42};\n";
    writeFileSync(file, source);

    const result = runHook("syntax-format-check.mjs", { tool_name: "Write", tool_input: { file_path: file } }, root);
    assert.equal(result.status, 0);
    assert.equal(readFileSync(file, "utf8"), source);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
