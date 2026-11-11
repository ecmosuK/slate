# Slate

<!-- slate:plan:begin project=slate version=1 -->
---
project: slate
status: in-progress
milestone: M0 — foundation
agent: opencode/deepseek-v4.1-flash-free
updated: 2026-11-11T02:50:00Z
---

## Goal
Build Slate: a personal notes and project-tracker workspace whose dashboard reads the READMEs you
already keep and tells you how far along everything is.

## Now
- [ ] `packages/bridge`: folder watcher, atomic writer, git facts
- [ ] Editor: BlockNote skeleton with the page tree
- [ ] Launch tasks with the opencode CLI from the web UI

## Next
- [ ] Auth, workspaces and the API routes (rest of M0)
- [ ] Spend caps per model, recorded against each job

## Done
- [x] Monorepo skeleton: npm workspaces, TypeScript strict, Vitest
- [x] `packages/shared`: zone grammar, plan schema, status renderer, README reader
- [x] `packages/db`: Drizzle schema including `agent_jobs`
- [x] `packages/cli`: `new`, `init`, `status`, `plan`, `config`, `models`, `test`, `doctor`
- [x] `apps/web`: dashboard that reads the projects root and summarises every project
- [x] **Create projects in the app**: one scaffold implementation, used by the browser and the CLI
- [x] **OpenRouter**: key stored outside the repository, shown masked, model catalogue, test message
- [x] Project detail view with a project sidebar, editable goals, and checked-off tasks
- [x] In-app agent chat over OpenRouter, with workspace and project context
- [x] Calendar month view shell (scheduling and Google sync still to come)
- [x] Copilot session hook prototyped, then dropped in favour of the repository check

## Log
- 2026-11-10 — repo initialised, M0 started
- 2026-11-10 — shared package done: zone grammar, plan parser, status renderer
- 2026-11-10 — CLI runs with no build step (Node type stripping); CI gate uses it
- 2026-11-10 — web shell verified against the real projects root, 200 OK
- 2026-11-10 — refocused on the dashboard: plain READMEs are read as well as plan blocks
- 2026-11-10 — removed the Copilot hook; kept the repository check that protects README prose
- 2026-11-10 — new projects are created from the app; OpenRouter key wired into Settings
- 2026-11-11 — project detail view: goals, checked-off tasks, full README
- 2026-11-11 — agent chat over OpenRouter with workspace and project context
- 2026-11-11 — project sidebar and calendar month view shell
<!-- slate:plan:end -->

<!-- slate:status:begin project=slate -->
<!-- slate:status:end -->

<!-- slate:requests:begin -->
<!-- slate:requests:end -->

## What this is

Slate replaces Notion for one person. The centre of it is not the editor. It is one screen that
answers **"how far along is everything"**, by reading the README of every project you have.

Two ways a project can record where it is:

| Block | Owner | Contents |
|---|---|---|
| `slate:plan` | the agent | goal, now, next, done, log |
| `slate:status` | Slate | stage, milestone, tasks, repo facts |
| prose | you | everything else, preserved byte-for-byte |

Neither is required. A plain README with a `**Status:**` line, a `## Next` section and a list of
checkboxes is read perfectly well — the card just says `heuristic` instead of `plan`, so an
inferred status is never passed off as a declared one.

Full specification: `Documents\Free App Builds\03 Notion Clone\SPEC.md`.

## Layout

```
slate/
├── apps/web/          Next.js 15 — the dashboard, the settings, the project creation
├── packages/shared/   zone grammar, plan schema, status renderer, README reader, scaffold, config
├── packages/db/       Drizzle schema
└── packages/cli/      the `slate` command
```

## Commands

```powershell
npm install
npm test          # 81 tests
npm run typecheck
npm run web       # http://127.0.0.1:3000

# the same picture in the terminal
node packages/cli/src/cli.ts status --root "C:\Users\kaede\Documents\projects"

# create a project, from the terminal or from the app
node packages/cli/src/cli.ts new "Recipe Vault" --description "A searchable box of family recipes"

# models
node packages/cli/src/cli.ts config set key sk-or-v1-…
node packages/cli/src/cli.ts config set model anthropic/claude-sonnet-4.5
node packages/cli/src/cli.ts models
node packages/cli/src/cli.ts test
```

The key is stored in `%LOCALAPPDATA%\Slate\config.json`, outside every repository, and the local
server binds to `127.0.0.1`.
