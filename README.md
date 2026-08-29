# Pi Tools

A workspace for Pi extensions maintained as independently publishable packages.

## Packages

| Package | Purpose |
|---|---|
| [`pi-hooks-rules`](packages/pi-hooks-rules/) | Manage tool hooks through `/hooks` and inject user-configured global and trusted-project rules. |
| [`pi-workspace-history`](packages/pi-workspace-history/) | Track workspace snapshots around agent turns and restore them with `/undo`, `/redo`, `/checkpoint`, and `/rewind`. |

## Development

Requirements: Node.js 22.19 or newer and npm.

```bash
npm install
npm run check
```

Each plugin belongs in `packages/<package-name>/`; cross-package tests belong in `test/`.
