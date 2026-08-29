# pi-hooks-rules

A Pi 0.84.3+ package for Node.js 22.19+ that provides:

- `/hooks` interactive management and command-line actions.
- Global and trusted-project hook configuration.
- Node-based pre-tool blocking and post-tool validation hooks.
- Per-session hook status, tests, and recent-run inspection.
- Automatic injection of user and trusted-project Markdown rules.

## Install

```bash
pi install npm:pi-hooks-rules
```

Restart Pi or run `/reload`, then open `/hooks`.

## Commands

```text
/hooks
/hooks list
/hooks show <id>
/hooks add
/hooks enable|disable|toggle <id>
/hooks remove <id>
/hooks test <id>
/hooks logs [id]
/hooks reload
```

## Hook configuration

The package ships Node-only defaults in `hooks.json` and resolves `${node}`, `${hooksDir}`, `${agentDir}`, `${configDir}`, and `${cwd}` in command arguments.

Optional user overrides live in `~/.pi/agent/hooks-rules.json`; trusted-project overrides live in `.pi/hooks-rules.json`. Project entries override user entries, which override packaged defaults by hook ID. Enabled-state overrides for packaged hooks remain minimal so later package upgrades can change commands and matchers safely:

```json
{
  "version": 1,
  "hooks": [],
  "overrides": { "xxx": { "enabled": false } }
}
```

## Rules

The package does not ship personal rules. Add Markdown files to either location:

- Global: `~/.pi/agent/rules/`
- Project: `.pi/rules/`

Rules without front matter load for every turn. Path-scoped rules use a `paths` front-matter list and are added after Pi reads, writes, or edits a matching path relative to the working directory. They are not added for unrelated paths:

```md
---
paths:
  - "xxx/**"
  - "**/xxx/**"
---
```

Project hooks and rules load only when the project also contains a Pi trust-triggering resource such as `.pi/settings.json`, `.pi/extensions/`, `.pi/skills/`, `.pi/prompts/`, `.pi/themes/`, `.pi/SYSTEM.md`, `.pi/APPEND_SYSTEM.md`, or project/ancestor `.agents/skills/`, and the project is trusted. This prevents a repository containing only hidden hook/rule files from bypassing Pi's trust prompt.

## Security

Pi extensions and configured hook commands execute with the user's permissions. Review package source and project configuration before granting trust or enabling third-party commands.
