# Pi Tools Repository

- Keep each publishable plugin isolated under `packages/<name>/`.
- Put cross-package and integration tests under `test/<name>/`.
- Use Pi's official extension and package APIs; list Pi core packages as peer dependencies.
- Prefer Node.js built-ins and avoid runtime dependencies unless required.
- Every change must pass `npm run check`, including type checking, tests, and `npm pack --dry-run`.
- Do not publish, tag, commit, or push unless explicitly requested.
