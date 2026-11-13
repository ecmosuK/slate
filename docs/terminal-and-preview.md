# Terminal and preview

How Slate lets an agent (or you) see and run a project, and how that seeing is made portable.

## The terminal

`apps/web` runs a terminal bridge (`packages/bridge/src/terminal.ts`, PTY support in
`packages/bridge/src/pty.ts`). A project page opens a shell whose working directory is that
project's folder, inside the projects root. It is the same shell a task runner would use, minus the
task.

- Commands run through the shell; the output streams back over SSE and is buffered so late
  subscribers replay it.
- With a PTY the session behaves like a real console: colours, cursor movement, Ctrl+C.
- On Windows, opening the terminal starts a persistent PowerShell shell. Commands run in that shell
  and the prompt stays available afterward.
- Slate installs from `package.json`, `requirements.txt` or `pyproject.toml` on first open and when
  those manifests change. Each Python project gets its own `.venv`, activated in that shell.
- Type a command in the terminal or its command box and press **Run**; for the Snake Python edition,
  use `python snake.py`.
- On first open, Slate installs dependencies from `package.json`, `requirements.txt` or
  `pyproject.toml` when present. It remembers successful setup for that manifest version and reruns
  installation if the dependency files change.
- To run a script, type its command into the box at the bottom of the terminal and click **Run**;
  e.g. `python snake.py` for the Snake game's Python edition or `npm run dev` for a Node project.

## The preview

The preview panel is an iframe pointed at the port the terminal announced. It does not start anything:
the user runs a server in the terminal pane, and once that session's output names a port the banner
shows a **Preview** button that frames exactly that port.

- Slate never resolves or starts a run target from the project page, and the pane has no Run or Serve
  control. Nothing runs until the user starts it in the terminal.
- The preview follows the active terminal session. Minimising or closing it only hides the frame; the
  terminal process keeps running, and reopening shows the same server and port instead of starting a
  second one.
- When the session ends, its port is gone and the preview button disappears with it.

The `/api/preview` route can still start a resolved run target or the built-in static server for API
clients, but the project page does not call it. The preview is terminal-first.

## Making a project previewable

- Give it a command that starts a server and run that command in the terminal: a package script, a
  Flask or FastAPI entry point, `python -m http.server` for plain files, or any other dev server.
- The preview follows the port the server prints. It does not care how the server was started, only
  that its output names a port the frame can reach.

## Portability

The iframe points at the project's own server, so there is no Slate-specific layer in front of its
files. A project that previews cleanly is deployable as-is, and the pop-out opens the same real URL.

The `/api/preview` route still has the built-in static server for API clients and projects that only
ship files, but the pane does not start it; run `python -m http.server` in the terminal instead.

## The agent-facing guide

Every scaffolded project gets a `TERMINAL.md` with this guidance, and the in-app agent chat is told
about the terminal and preview in its system prompt. Keep the wording in
`packages/shared/src/scaffold.ts` (`TERMINAL_GUIDE_TEMPLATE`) as the single source so the CLI and the
app cannot drift.
