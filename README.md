# Slate

<!-- slate:plan:begin project=slate version=1 -->
---
project: slate
status: in-progress
milestone: M1 — spend caps and scheduling
agent: opencode/openai/gpt-6-luna
updated: 2026-11-13T11:52:19.000Z
---

## Goal
Build Slate: a personal notes and project-tracker workspace whose dashboard reads the READMEs you
already keep and tells you how far along everything is.

## Now
- [ ] Scheduling on the calendar, then Google Calendar sync

## Next
- [ ] Fold the local accounts into the Drizzle tables once Postgres runs
- [ ] Several workspaces per projects root: give each workspace its own root and starter project

## Done
- [x] `packages/db`: Drizzle schema including `agent_jobs`
- [x] `packages/cli`: `new`, `init`, `status`, `plan`, `config`, `models`, `test`, `doctor`
- [x] `apps/web`: dashboard that reads the projects root and summarises every project
- [x] **Create projects in the app**: one scaffold implementation, used by the browser and the CLI
- [x] **OpenRouter**: key stored outside the repository, shown masked, model catalogue, test message
- [x] Project detail view with a project sidebar, editable goals, and checked-off tasks
- [x] In-app agent chat over OpenRouter, with workspace and project context
- [x] **opencode task runner**: start plan or build jobs from a project page, stream logs, cancel
- [x] Calendar month view shell (scheduling and Google sync still to come)
- [x] **Sidebar home button**: jump back to the dashboard from any page
- [x] **Agent tools**: create projects, edit plan milestones and tasks, add and update goals from chat
- [x] **Free-only models and fallback**: show all free OpenRouter, Gemini, and opencode models; auto-switch through the list on limits/failures; opencode models run via local CLI (text mode)
- [x] `packages/bridge`: folder watcher, atomic writer, git facts
- [x] **Editor**: BlockNote skeleton with a page tree (`/notes`)
- [x] **Auth, workspaces and the API routes** (rest of M0): scrypt passwords, hashed session tokens, UUIDv7 ids; a local owner and workspace created on first request; switcher in the sidebar with create and rename; `/api/session` and `/api/workspaces`; every mutating route answers 401 while the machine is locked
- [x] **Terminal runner bridge**: spawn shell processes inside a project folder, stream stdout/stderr live (SSE with buffered replay), stdin input, cancel and history — `packages/bridge/src/terminal.ts` (12 tests); app API under `/api/terminal/*` pinned to the projects root behind the same lock-screen and local-origin guards as the task runner
- [x] **Spend caps per model, recorded against each job**: per-model spend caps in config and Settings, cost tracked against every opencode job and chat turn, 402 when a model's cap is reached, cap and spend shown in Settings and the task runner
- [x] **Projects live in `slate/workspaces/personal/<project>`**: projects moved there, default root updated in the CLI and web app, `workspaces/` gitignored — new workspaces can get their own folder beside `personal/` ("03 Notion Clone" went missing after the move; cause unknown)
- [x] Terminal UI pane in Project Detail view (xterm.js integration for running project commands)
- [x] Dev server port auto-detection from process output logs and project settings
- [x] Live UI preview iframe component with controls (refresh, port selector, pop-out browser link)
- [x] Built-in static preview API retained for API clients; project page is terminal-first
- [x] Preview follows terminal output; API run-target support remains available to API clients
- [x] **One agentic agent per project**: chat runs the opencode CLI in the project's own folder (read/write/edit/bash/subagents) with Slate's plan and goal tools served by a local MCP server, a live event timeline with tool cards, Stop and Clear, and one persistent session per folder — the old two-agent chat path is gone
- [x] **Per-project session hygiene**: one session per project folder, session request size shown in the chat, automatic rotation above ~80k tokens or when a free-tier per-minute input limit is hit, `provider.quota` translated to the real cause instead of "quota used up", and a **New session** button; context size persists across restarts so a bloated transcript cannot revive
- [x] **Plan agent speaks plainly**: its chat hides tool cards and cost and keeps only the closing words after the last tool call (with a plain summary fallback); model availability is shared across route bundles so a free limit recorded by a run reaches `/api/models`
- [x] **Terminal-first preview**: Preview appears only after the terminal announces a port and frames it; no preview auto-start or Run/Serve; hiding keeps the server; Python output is unbuffered
- [x] **Terminal setup**: Windows opens a persistent PowerShell prompt; dependencies install in that shell from changed manifests, each Python project gets its own `.venv`, and the terminal shows how to run scripts

## Log
- 2026-11-11 — OpenRouter/Gemini/opencode free-model fallback and CLI replies; BlockNote notes with browser-safe shared note tree
- 2026-11-11 — ids, passwords, roles and the local workspace store in `packages/shared` (34 tests)
- 2026-11-11 — `/api/session` and `/api/workspaces`, write guards, lock screen, sidebar switcher and Settings cards; smoke-tested create, switch, lock, sign-in, sign-out, unlock
- 2026-11-11 — spend caps per model, recorded against each job: per-model caps in config and Settings, cost tracked per job and per chat turn, 402 when a model's cap is reached
- 2026-11-12 — terminal runner bridge: shell processes per project folder, SSE stdout/stderr with replay, stdin input and process-tree cancel; app routes at /api/terminal/*
- 2026-11-12 — projects moved into slate/workspaces/personal; default root updated in CLI and web; note: "03 Notion Clone" was seen in the folder right after the move (~13:33) and was gone by ~13:39, cause unknown, not in the recycle bin — see chat
- 2026-11-12 — terminal pane (xterm.js over a PTY), sticky project banner with terminal/preview buttons, floating docks in the top right, minimisable plan agent and run-a-task sections, dev-server port detection from terminal output
- 2026-11-12 — built-in static preview server for projects, TERMINAL.md agent guide, chat-agent terminal/preview awareness
- 2026-11-12 — AGENTS templates and all existing projects now point at TERMINAL.md; docs updated
- 2026-11-12 — one agentic agent per project: `opencode run --format json --auto` per project folder with the plan/goal tools on a stdio MCP server (config written to `<project>/.opencode/opencode.json`, since the CLI reads project config from disk only), one session id per folder, SSE timeline with tool cards, Stop/Clear, spend recorded; old `/api/chat` + `lib/agent.ts` removed (307 tests)
- 2026-11-13 — session hygiene: per-folder session size tracked from `step_finish` tokens and shown in chat, automatic new session above 80k tokens or on a free-tier per-minute input-token quota, quota errors translated to a rate-limit explanation, manual New session button, context persisted across restarts (324 tests)
- 2026-11-13 — plan agent chat answers in plain words: tool cards and cost hidden, only the closing text after the last tool kept (plain summary fallback); its shell tool is explicitly denied; model availability moved onto globalThis so `/api/models` sees limits recorded by the agent route (325 tests)
- 2026-11-13 — terminal-first preview follows the newest announced port without starting a server; Python output unbuffered for live port detection (336 tests)
- 2026-11-13 — persistent PowerShell prompt, dependency setup in-shell without repeated download sessions, and isolated per-project Python `.venv` (343 tests)
- 2026-11-13 — reconcileTerminals keeps live pseudo-terminal sessions running, so a fresh persistent PowerShell is no longer marked failed mid-setup and setup input can be delivered (344 tests)
- 2026-11-13 — docked preview pane now fills the floating dock body (flex: 1 on the body, height: 100% on the pane) so the iframe preview is as large as the pane without needing pop-out
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
