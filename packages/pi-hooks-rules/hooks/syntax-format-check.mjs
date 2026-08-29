import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { spawnSync } from "node:child_process";

let raw = "";
for await (const chunk of process.stdin) raw += chunk;

let input;
try {
  input = JSON.parse(raw || "{}");
} catch {
  process.stderr.write("[syntax-check] invalid JSON input\n");
  process.exit(2);
}

const file = String(input?.tool_input?.file_path ?? "");
if (!file || !existsSync(file)) process.exit(0);

function fail(message) {
  process.stderr.write(`[syntax-check] ${String(message).trim()}\n`);
  process.exit(2);
}

function run(command, args) {
  return spawnSync(command, args, { encoding: "utf8", windowsHide: true });
}

function available(command, args = ["--version"]) {
  return run(command, args).status === 0;
}

const extension = extname(file).toLowerCase();
if ([".js", ".mjs", ".cjs"].includes(extension)) {
  const result = run(process.execPath, ["--check", file]);
  if (result.status !== 0) fail(result.stderr || result.stdout);
} else if (extension === ".json") {
  try {
    JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    fail(error instanceof Error ? error.message : error);
  }
} else if (extension === ".sh" && available("bash")) {
  const result = run("bash", ["-n", file]);
  if (result.status !== 0) fail(result.stderr || result.stdout);
} else if (extension === ".py") {
  const candidates = process.platform === "win32" ? [["py", ["-3"]], ["python", []]] : [["python3", []], ["python", []]];
  const candidate = candidates.find(([command, prefix]) => available(command, [...prefix, "--version"]));
  if (candidate) {
    const [command, prefix] = candidate;
    const program = "import ast,sys; ast.parse(open(sys.argv[1],encoding='utf-8').read(),sys.argv[1])";
    const result = run(command, [...prefix, "-c", program, file]);
    if (result.status !== 0) fail(result.stderr || result.stdout);
  }
}

if ([".js", ".mjs", ".cjs", ".json", ".jsonc", ".md", ".yaml", ".yml", ".css", ".html"].includes(extension)) {
  const prettier = join(process.cwd(), "node_modules", "prettier", "bin", "prettier.cjs");
  if (existsSync(prettier)) {
    const result = run(process.execPath, [prettier, "--write", "--", file]);
    if (result.status !== 0) fail(result.stderr || result.stdout);
  }
}
