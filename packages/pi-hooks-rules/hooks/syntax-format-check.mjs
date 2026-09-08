import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { spawnSync } from "node:child_process";

function fail(message) {
  process.stderr.write(`[syntax-check] ${String(message).trim()}\n`);
  process.exit(2);
}
function run(command, args, discardOutput = false) {
  return spawnSync(command, args, {
    encoding: "utf8", windowsHide: true, timeout: 8000,
    ...(discardOutput ? { stdio: ["ignore", "ignore", "pipe"] } : {}),
  });
}
function validate(command, args, discardOutput = false) {
  const result = run(command, args, discardOutput);
  if (result.error || result.status !== 0) fail(result.error?.message || result.stderr || result.stdout || "validator failed");
}

let raw = "";
for await (const chunk of process.stdin) raw += chunk;
let input;
try { input = JSON.parse(raw); } catch { fail("invalid JSON input"); }
if (input.tool_error) process.exit(0);
const file = input.tool_input?.file_path ?? input.tool_input?.path;
if (typeof file !== "string" || !file || !existsSync(file)) process.exit(0);
const extension = extname(file).toLowerCase();
if ([".js", ".mjs", ".cjs"].includes(extension)) {
  validate(process.execPath, ["--check", file]);
} else if (extension === ".json") {
  try { JSON.parse(readFileSync(file, "utf8")); } catch (error) { fail(error.message); }
} else if (extension === ".sh" && run("bash", ["--version"]).status === 0) {
  validate("bash", ["-n", file]);
} else if (extension === ".py") {
  const candidates = process.platform === "win32" ? [["py", ["-3"]], ["python", []]] : [["python3", []], ["python", []]];
  const candidate = candidates.find(([command, prefix]) => run(command, [...prefix, "--version"]).status === 0);
  if (candidate) {
    const [command, prefix] = candidate;
    validate(command, [...prefix, "-c", "import ast,sys,tokenize; ast.parse(tokenize.open(sys.argv[1]).read(),sys.argv[1])", file]);
  }
}
if ([".js", ".mjs", ".cjs", ".json", ".jsonc", ".md", ".yaml", ".yml", ".css", ".html"].includes(extension)) {
  const prettier = join(process.cwd(), "node_modules", "prettier", "bin", "prettier.cjs");
  // Validate with local Prettier; discard formatted stdout instead of rewriting the edit.
  if (existsSync(prettier)) validate(process.execPath, [prettier, "--", file], true);
}
