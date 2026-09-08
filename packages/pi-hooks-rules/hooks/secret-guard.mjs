let raw = "";
for await (const chunk of process.stdin) raw += chunk;

let input;
try {
  input = JSON.parse(raw || "{}");
} catch {
  process.stderr.write("secret-guard: invalid JSON input\n");
  process.exit(2);
}

const toolInput = input?.tool_input ?? {};
const haystack = [
  toolInput.command,
  toolInput.content,
  toolInput.new_string,
  toolInput.prompt,
]
  .filter((value) => typeof value === "string")
  .join("\n");

const patterns = [
  ["Google_API_key", /AIzaSy[A-Za-z0-9_-]{33}/],
  ["Anthropic_API_key", /sk-ant-[A-Za-z0-9_-]{20,}/],
  ["Generic_sk_key", /sk-[A-Za-z0-9_-]{32,}/],
  ["GitHub_token", /gh[opsu]_[A-Za-z0-9]{30,}/],
  ["GitHub_finegrained_PAT", /github_pat_[A-Za-z0-9_]{36,}/],
  ["DB_connection_URL", /(?:postgresql|postgres|mysql|mongodb(?:\+srv)?):\/\/[^\s"']+:[^\s"']+@/],
  ["Slack_token", /xox[abprs]-[A-Za-z0-9-]{10,}/],
  ["GitLab_PAT", /glpat-[A-Za-z0-9_-]{20,}/],
  ["PEM_private_key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["AWS_access_key", /AKIA[0-9A-Z]{16}/],
];

for (const [name, pattern] of patterns) {
  const match = haystack.match(pattern)?.[0];
  if (!match) continue;
  const sample = `${match.slice(0, 4)}...${match.slice(-4)}`;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `secret-guard: blocked ${name} (${sample}) in tool payload. Refactor to an environment variable, stdin, or another indirect reference. Never paste plaintext secrets into command arguments or file contents.`,
      },
      systemMessage: `[secret-guard] blocked ${name} (${sample})`,
    }),
  );
  break;
}
