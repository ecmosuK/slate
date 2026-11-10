# Slate

<!-- slate:plan:begin project=slate version=1 -->
---
project: slate
status: in-progress
milestone: M0 — foundation
agent: opencode/minimax-m3.1-flash-free
updated: 2026-11-10T19:30:00Z
---

## Goal
Build Slate: a personal notes and project-tracker workspace that writes project status into
READMEs, reads agent plans back, and runs from Windows with a $0 cloud host.

## Now
- [ ] `packages/bridge`: folder watcher, atomic writer, git facts
- [ ] Requests loop end to end: write a request, tick it from the plan log
- [ ] Pre-commit hook that runs `slate plan check`
- [ ] Editor: BlockNote skeleton with the page tree

## Next
- [ ] `apps/web`: Projects screen with a diff preview before the first write
- [ ] Auth, workspaces and the Next.js API routes (rest of M0)

## Done
- [x] Monorepo skeleton: npm workspaces, TypeScript strict, Vitest
- [x] `packages/shared`: zone scanner, plan schema, status renderer, 42 tests
- [x] `packages/db`: Drizzle schema including `agent_jobs`
- [x] `packages/cli`: `slate init|plan ensure|read|log|check|doctor`, runs on plain Node
- [x] `apps/web`: Next.js 15 shell that renders every linked project's plan
- [x] Copilot session-start hook and the CI plan gate

## Log
- 2026-11-10 — repo initialised, M0 started
- 2026-11-10 — shared package done: zone grammar, plan parser, status renderer, 42 tests green
- 2026-11-10 — CLI runs with no build step (Node type stripping); CI gate uses it
- 2026-11-10 — web shell verified against the real projects root, 200 OK
<!-- slate:plan:end -->

<!-- slate:status:begin project=slate -->
<!-- slate:status:end -->

<!-- slate:requests:begin -->
<!-- slate:requests:end -->

## What this is

Slate replaces Notion for one person. The interesting part is not the editor — it is the
**project ↔ README bridge** and the **agent plan protocol**.

Three blocks live in a project's README, each with one owner, so nothing ever has to merge:

| Block | Owner | Contents |
|---|---|---|
| `slate:plan` | the agent | goal, now, next, done, log — what the agent is about to do |
| `slate:status` | Slate | stage, milestone, tasks, repo facts — generated |
| `slate:requests` | you | `- [ ] #req1 …` — things you want the agent to pick up |

Everything outside those blocks is yours, preserved byte-for-byte.

Full specification: `Documents\Free App Builds\03 Notion Clone\SPEC.md`.

## Layout

```
slate/
├── apps/web/          Next.js 15 app — the Projects screen reads the projects root
├── packages/shared/   zone grammar, plan schema, status renderer (the single implementation)
├── packages/db/       Drizzle schema
├── packages/cli/      the `slate` command
└── .github/hooks/     Copilot session-start hook that injects the plan
```

## Commands

```powershell
npm install
npm test          # 50 tests
npm run typecheck
npm run web       # http://localhost:3000
node packages/cli/src/cli.ts plan ensure --cwd .
```
