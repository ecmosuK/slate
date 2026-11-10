# Agent instructions

Before any other action, read the `slate:plan` block in `README.md`.

- If it is missing, create it from `C:\Users\kaede\Documents\projects\templates\README.md` and set
  `project:` to this folder's name.
- Restate the current milestone and the first unchecked task under `## Now` in one line, then work.
- Edit only inside the `slate:plan` markers. Never touch `slate:status`, `slate:requests`, or any
  prose outside the blocks.
- Move finished items from `## Now` to `## Done`.
- Append one line to `## Log` per meaningful change.
- Update `agent` and `updated` on every write.

## Conventions for this repo

- npm workspaces, not pnpm. `pnpm` is not installed on this machine; the layout is compatible, so
  switching later is a one-line change to the root `package.json`.
- TypeScript everywhere, strict mode, no build step for the shared package — it ships as source.
- Relative imports carry the `.ts` extension (`./zones.ts`). Node resolves them directly, so the
  CLI runs on plain Node with no bundler, and `allowImportingTsExtensions` is on.
- The zone grammar, plan schema and README reader live in `packages/shared/src/`. They are the
  single implementation of the spec; do not fork them.
- The reader has two paths: an exact one for the plan block, and an inferred one for ordinary
  READMEs. Keep them separate. A summary must always say which path produced it.
- Tests are Vitest, colocated in `packages/*/test`. The CLI tests spawn the real binary.
- No Docker yet, so nothing that needs Postgres can run. Domain logic stays in `packages/shared`
  precisely so it can be tested without a database.
