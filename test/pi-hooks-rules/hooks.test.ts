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

test("destructive guard denies broad deletion and permits disposable targets", () => {
  const denied = runHook("destructive-command-guard.mjs", {
    tool_name: "Bash",
    tool_input: { command: "rm -fr important-data" },
  });
  const allowed = runHook("destructive-command-guard.mjs", {
    tool_name: "Bash",
    tool_input: { command: "rm -rf node_modules" },
  });
  const mixedCleanup = runHook("destructive-command-guard.mjs", {
    tool_name: "Bash",
    tool_input: { command: "echo done && rm -rf node_modules" },
  });
  const powershellDelete = runHook("destructive-command-guard.mjs", {
    tool_name: "PowerShell",
    tool_input: { command: "Remove-Item important -Recurse" },
  });
  assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, "deny");
  assert.equal(JSON.parse(allowed.stdout).hookSpecificOutput.permissionDecision, "allow");
  assert.equal(JSON.parse(mixedCleanup.stdout).hookSpecificOutput.permissionDecision, "deny");
  assert.equal(JSON.parse(powershellDelete.stdout).hookSpecificOutput.permissionDecision, "deny");
  const powershellSwitchDelete = runHook("destructive-command-guard.mjs", {
    tool_name: "PowerShell",
    tool_input: { command: "Remove-Item important -Recurse:$true -Force" },
  });
  assert.equal(JSON.parse(powershellSwitchDelete.stdout).hookSpecificOutput.permissionDecision, "deny");
});

test("destructive guard handles mixed-case protected Git commands", () => {
  for (const command of [
    "git PUSH --FORCE",
    "git PUSH --FORCE-WITH-LEASE",
    "git RESET --HARD",
    "git.exe RESET --HARD",
    "git CLEAN -F",
    "git CHECKOUT \".\"",
    "git BRANCH -D old",
    "git STASH CLEAR",
  ]) {
    const result = runHook("destructive-command-guard.mjs", {
      tool_name: "PowerShell",
      tool_input: { command },
    });
    assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, "deny", command);
  }
});

test("destructive guard distinguishes Git -C from config and preserves destructive checks", () => {
  const routine = [
    "git -C C:/Users/Yanghao/.pi/agent status --short",
    'git -C "C:/Users/Yanghao/.pi/agent" status --short',
    "git -C C:/repo -C sub status --short",
    "git log -C",
    "git status -- -cache.txt",
    "git commit -m test",
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
    ["git -C C:/repo clean -fd", "git_clean_force"],
  ] as const) {
    const result = runHook("destructive-command-guard.mjs", {
      tool_name: "Bash",
      tool_input: { command },
    });
    const output = JSON.parse(result.stdout);
    assert.equal(output.hookSpecificOutput.permissionDecision, "deny", command);
    assert.match(output.hookSpecificOutput.permissionDecisionReason, new RegExp(`blocked ${rule}`), command);
  }
});

test("destructive guard allows safe expansions and bounded Bash control flow", () => {
  const allowed = [
    ["Bash", 'echo "$HOME"'],
    ["Bash", 'echo "${HOME}"'],
    ["Bash", 'echo ${HOME}'],
    ["Bash", 'echo "\\$HOME"'],
    ["Bash", 'echo \'literal\'"$HOME"'],
    ["Bash", 'echo \'$(rm -rf important-data)\' "$HOME"'],
    ["Bash", 'echo \'literal$(rm -rf important-data)\'"$HOME"'],
    ["Bash", 'printf \'%s\\n\' "$HOME"'],
    ["Bash", "bash -c 'echo safe'"],
    ["Bash", "if true; then echo safe; fi"],
    ["Bash", "if false; then echo no; elif true; then echo yes; else echo no; fi"],
  ];
  for (const [tool_name, command] of allowed) {
    const result = runHook("destructive-command-guard.mjs", { tool_name, tool_input: { command } });
    assert.equal(result.status, 0, command);
    assert.equal(result.stdout, "", command);
  }

  const denied = [
    ["Bash", "$COMMAND --help"],
    ["Bash", "X=$(rm -rf important-data) echo safe"],
    ["Bash", "BASH_ENV=/tmp/unknown"],
    ["Bash", "BASH_ENV=/tmp/unknown bash -c 'echo safe'"],
    ["Bash", "export BASH_ENV+=/tmp/unknown; bash -c 'echo safe'"],
    ["Bash", "printf -v BASH_ENV /tmp/unknown; bash -c 'echo safe'"],
    ["Bash", 'echo "${HOME:-/tmp}"'],

    ["Bash", "bash -c 'rm -rf important-data'"],
    ["Bash", "bash -c \"echo '$(rm -rf important-data)'\""],
    ["Bash", 'bash -c "echo $HOME"'],
    ["Bash", "bash -lc 'echo safe'"],
    ["Bash", "bash --noprofile -c 'echo safe'"],
    ["Bash", "bash --command 'echo safe'"],
    ["Bash", "bash -c 'echo safe' \"$(rm -rf important-data)\""],
    ["Bash", "printf 'rm -rf important-data\\n' | bash -v"],
    ["Bash", "printf 'git reset --hard\\n' | bash -h"],
    ["Bash", "bash -v < /tmp/script"],
    ["Bash", "if rm -rf important-data; then echo safe; fi"],
    ["Bash", "if true; then rm -rf important-data; fi"],
    ["Bash", "if true; then echo safe; else rm -rf important-data; fi"],
    ["Bash", "if true; then echo safe; elif rm -rf important-data; then echo safe; fi"],
    ["Bash", 'echo "$(rm -rf important-data)"'],
    ["Bash", 'echo safe > "$(rm -rf important-data)"'],
    ["Bash", "echo > \"'$(rm -rf important-data)'\""],
    ["Bash", "export BASH_ENV=/tmp/unknown; bash -c 'echo safe'"],
    ["Bash", "find . $OPTIONS"],
    ["Bash", "python3 $OPTIONS"],
    ["Bash", "node \"$SCRIPT\""],
    ["Bash", "custom-tool \"$VALUE\""],
    ["Bash", "trap \"$COMMAND\" EXIT"],
    ["Bash", "trap 'rm -rf important-data' EXIT"],
    ["Bash", "alias cleanup='rm -rf important-data'; cleanup"],
    ["Bash", "start /b rm -rf important-data"],
    ["Bash", "call /c rm -rf important-data"],
    ["Bash", "set -a; FLAGS=-v; printf \"$FLAGS\" BASH_ENV /tmp/unknown; bash -c 'echo safe'"],
    ["Bash", "set -a; for BASH_ENV in /tmp/unknown; do bash -c 'echo safe'; done"],
    ["Bash", "while read BASH_ENV; do bash -c 'echo safe'; done"],
    ["Bash", "set -a; select BASH_ENV in /tmp/unknown; do bash -c 'echo safe'; done"],
    ["Bash", "declare -n startup=BASH_ENV; export startup=/tmp/unknown; bash -c 'echo safe'"],
    ["Bash", "declare -gn startup=BASH_ENV; export startup=/tmp/unknown; bash -c 'echo safe'"],
    ["Bash", "declare -ng startup=BASH_ENV; export startup=/tmp/unknown; bash -c 'echo safe'"],
    ["Bash", "[[ \"$VALUE\" -eq 0 ]]"],
    ["Bash", 'if [ "$HOME" = safe ]; then echo safe; else printf \'%s\' "$HOME"; fi'],
    ["Bash", "f() { rm -rf important-data; }; f"],
    ["Bash", "{ rm -rf important-data; }"],
    ["Bash", "( rm -rf important-data )"],
    ["Bash", "echo <(rm -rf important-data)"],
  ];
  for (const [tool_name, command] of denied) {
    assert.equal(parseDecision(
      runHook("destructive-command-guard.mjs", { tool_name, tool_input: { command } }),
      command,
    ), "deny", command);
  }
});

test("destructive guard fails closed at the Bash control analysis depth", () => {
  let command = "echo safe";
  for (let index = 0; index < 20; index += 1) command = `if ${command}; then :; fi`;
  assert.equal(parseDecision(
    runHook("destructive-command-guard.mjs", { tool_name: "Bash", tool_input: { command } }),
    command,
  ), "deny", command);
});

test("destructive guard fails closed at the Bash wrapper analysis depth", () => {
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
  let shallow = ":";
  for (let index = 0; index < 2; index += 1) shallow = `bash -c ${quoteBash(shallow)}`;
  const shallowResult = runHook("destructive-command-guard.mjs", { tool_name: "Bash", tool_input: { command: shallow } });
  assert.equal(shallowResult.status, 0, shallow);
  assert.equal(shallowResult.stdout, "", shallow);

  let command = ":";
  for (let index = 0; index < 19; index += 1) command = `bash -c ${quoteBash(command)}`;
  assert.ok(command.length < 65_536, `fixture length: ${command.length}`);
  const result = runHook("destructive-command-guard.mjs", { tool_name: "Bash", tool_input: { command } });
  assert.equal(result.status, 0, command);
  assert.equal(parseDecision(result, command), "deny", command);
  assert.match(JSON.parse(result.stdout).hookSpecificOutput.permissionDecisionReason, /blocked opaque_command/, command);
});

test("bundled destructive guard includes Cmd tools", () => {
  const hooks = JSON.parse(readFileSync(join(repoRoot, "packages", "pi-hooks-rules", "hooks.json"), "utf8"));
  const destructive = hooks.hooks.find((hook: { id: string }) => hook.id === "destructive-command-guard");
  assert.equal(destructive?.tools.includes("cmd"), true);
});

test("destructive guard covers recursive deletion across nested shell dialects", () => {
  const denied = [
    ["Bash", "rm -r important-data"],
    ["Bash", "rm --recursive important-data"],
    ["Bash", "/usr/bin/rm -rf important-data"],
    ["Bash", 'bash -c "rm -rf important-data"'],
    ["Bash", 'sh -c "rm -rf important-data"'],
    ["Bash", 'cmd /c del /s /q important-data'],
    ["Bash", 'cmd /c rmdir /s /q important-data'],
    ["Bash", 'powershell -Command "Remove-Item important-data -Recurse"'],
    ["PowerShell", "rm -rf important-data"],
    ["PowerShell", 'powershell -Command "Remove-Item important-data -Recurse"'],
    ["Bash", 'bash -c "git reset --hard"'],
    ["Bash", "git branch --delete old"],
    ["Bash", 'bash -c "$COMMAND"'],
    ["Bash", 'bash -c "rm -rf important-data'],
    ["Bash", 'echo "$(rm -rf important-data)"'],
    ["Bash", "X=1 rm -rf important-data"],
    ["Bash", "X=1 git reset --hard"],
    ["Bash", "op=reset; git $op --hard"],
    ["Bash", "opts='c user.name=Alice reset --hard'; git -$opts"],
    ["Bash", 'bash -c \'opts="c user.name=Alice reset --hard"; git -$opts\''],
    ["Bash", "bash -c 'op=reset; git $op --hard'"],
    ["Bash", "printf 'rm -rf important-data\\n' | bash"],
    ["Bash", "{rm,-rf,important-data}"],
    ["Bash", "git -c alias.wipe=reset wipe --hard"],
    ["Bash", "git push origin +HEAD:main"],
    ["PowerShell", "git @flags --hard"],
    ["Bash", "exec -c rm -rf important-data"],
    ["Bash", "exec -a harmless rm -rf important-data"],
    ["Bash", "exec -ca harmless git reset --hard"],
    ["Bash", "env -S 'git reset --hard'"],
    ["Bash", "env -S'git reset --hard'"],
    ["Bash", "env --split-string='rm -rf important-data'"],
    ["Bash", "git >/dev/null reset --hard"],
    ["Bash", "rm>/dev/null -rf important-data"],
    ["Bash", "rm --rec important-data"],
    ["PowerShell", "Remove-Item important-data @flags"],
    ["Cmd", "git >nul reset --hard"],
    ["Bash", ">log rm -rf important-data"],
    ["Bash", "2>&1 rm -rf important-data"],
    ["Bash", "< /dev/null rm -rf important-data"],
    ["Bash", "<<< ignored rm -rf important-data"],
    ["Bash", 'bash -c "<<< ignored rm -rf important-data"'],
    ["Bash", "FLAGS=-rf rm $FLAGS important-data"],
    ["Bash", 'env P=../home/alice/important bash -c \'rm -rf "/tmp/$P"\''],
    ["Bash", "if true; then rm -rf important-data; fi"],
    ["Bash", "if true; then git reset --hard; fi"],
    ["Bash", "if rm -rf important-data; then :; fi"],
    ["Bash", "while git reset --hard; do :; done"],
    ["Bash", "until rm -rf important-data; do :; done"],
    ["Bash", "for item in one; do rm -rf important-data; done"],
    ["Bash", 'bash -c "if true; then rm -rf important-data; fi"'],
    ["PowerShell", "Remove-Item -Path node_modules/cache,important-data -Recurse"],
    ["PowerShell", 'Remove-Item -Path "node_modules/cache",important-data -Recurse'],
    ["PowerShell", 'Remove-Item -Path "node_modules/cache","important-data" -Recurse'],
    ["PowerShell", "Remove-Item $(Get-Target) -Recurse"],
    ["PowerShell", "Remove-Item @(\"node_modules\",\"important-data\") -Recurse"],
    ["PowerShell", "Remove-Item (Get-Target) -Recurse"],
    ["PowerShell", "iex 'Remove-Item important-data -Recurse'"],
    ["PowerShell", "Invoke-Expression 'Remove-Item important-data -Recurse'"],
    ["PowerShell", "& ('git') reset --hard"],
    ["Cmd", "@rmdir /s /q important-data"],
    ["Cmd", "rmdir/s/q important-data"],
    ["Cmd", ">nul rmdir /s /q important-data"],
    ["Cmd", '>"nul" rmdir /s /q important-data'],
    ["Cmd", 'cmd /c ">"nul" rmdir /s /q important-data'],
    ["Cmd", "cmd /c \">nul git reset --hard\""],
    ["Cmd", "@if exist important-data rmdir /s /q important-data"],
    ["Cmd", "cmd /c \"@rmdir /s /q important-data\""],
    ["Cmd", "rmdir %FLAGS% important-data"],
    ["Cmd", "rmdir !FLAGS! important-data"],
    ["Cmd", "if exist important-data rmdir /s /q important-data"],
    ["Cmd", "if 1==1 rmdir /s /q important-data"],
    ["Cmd", "if 1==1 git reset --hard"],
    ["Cmd", 'if exist x echo ok else rmdir /s /q important-data'],
    ["Cmd", "for %i in (x) do rmdir /s /q important-data"],
    ["Cmd", "call rmdir /s /q important-data"],
    ["Cmd", 'start "" cmd /c rmdir /s /q important-data'],
    ["Cmd", 'cmd /c "if 1==1 rmdir /s /q important-data"'],
  ];
  for (const [tool_name, command] of denied) {
    const result = runHook("destructive-command-guard.mjs", { tool_name, tool_input: { command } });
    assert.equal(parseDecision(result, command), "deny", command);
  }

  const allowed = [
    ["Bash", "rm -rf node_modules/cache"],
    ["PowerShell", "Remove-Item node_modules -Recurse"],
    ["PowerShell", 'Remove-Item -LiteralPath "node_modules/cache,important-data" -Recurse'],
    ["Cmd", "rmdir /s /q node_modules"],
  ];
  for (const [tool_name, command] of allowed) {
    const result = runHook("destructive-command-guard.mjs", { tool_name, tool_input: { command } });
    assert.equal(parseDecision(result, command), "allow", command);
  }

  for (const [tool_name, command] of [
    ["Bash", "rm -f important-data"],
    ["Bash", "custom-tool --arg"],
    ["PowerShell", 'Write-Output "Remove-Item important-data -Recurse"'],
    ["Bash", "echo git commit"],
    ["Bash", 'echo "git reset --hard"'],
    ["Bash", 'echo "rm -rf important-data"'],
  ]) {
    const result = runHook("destructive-command-guard.mjs", { tool_name, tool_input: { command } });
    assert.equal(result.status, 0, command);
    assert.equal(result.stdout, "", command);
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
