# Agent Deck

**English** | [简体中文](./README.zh-CN.md)

A local web dashboard for running multiple AI coding agent CLIs (`claude` / `opencode`) and plain shell terminals side by side. Real PTY terminals, sessions survive browser refreshes, one-click persona presets, tabs / split-pane layout.

## Install

**Requirements**

- macOS / Linux (Windows: use WSL)
- Node.js ≥ 18
- C/C++ toolchain for `node-pty` (macOS: `xcode-select --install`; Linux: `build-essential` + `python3`)
- `claude` and/or `opencode` CLI installed, logged in, and on your PATH

**Setup**

```bash
npm run setup
```

Installs `server/` and `web/` dependencies, fixes node-pty's `spawn-helper` executable bit, and builds the frontend.

**Run**

```bash
# Production: single port serves UI + WebSocket
./scripts/start.sh          # http://127.0.0.1:4173

# Dev: Vite HMR + backend hot reload
npm run dev                 # http://127.0.0.1:5173
```

Environment variables: `PORT` (default 4173), `HOST` (default 127.0.0.1), `SCROLLBACK_BYTES`, `IDLE_AFTER_MS`, `CONTROL_APP_DATA` (directory for personas.json), `REAP_EXITED_AFTER_MS`.

## Uninstall

Nothing is installed globally — everything lives inside this directory.

```bash
# Stop the server (Ctrl-C, or kill the process holding the port)
lsof -ti tcp:4173 -sTCP:LISTEN | xargs kill

# Delete the repo (persona data is in data/personas.json, or $CONTROL_APP_DATA if set)
rm -rf /path/to/control_app
```

## Features

- **Multiple CLI instances** — `xterm.js` + `node-pty` + WebSocket; full ANSI color and interactive TUI support.
- **Session persistence** — PTYs are hosted by the backend with 1 MiB scrollback; refresh/disconnect, then re-attach and replay full history. (A backend restart ends sessions — see "Advanced".)
- **Personas** — save presets (system prompt, model, working dir, env vars, extra args) and launch them with one click.
- **Plain terminals** — open your login shell as a tab next to agent sessions.
- **Session board** — live status per session (starting / running / busy / idle / exited); tabs or resizable split panes with live terminal resize.
- **Per-session workspace** — each session can target a different project directory.

## Usage

1. **Quick Launch** (sidebar): open a bare `claude` / `opencode` session, click a persona chip, or hit **+ 终端** for a plain shell tab.
2. The launch dialog lets you override working dir / model / title.
3. Switch the main area between **Tabs** and **Split**; drag split handles to resize live.
4. Sidebar **停止** and the tab's **×** both terminate the CLI and close the tab. Exited sessions linger briefly, then are auto-reaped.
5. Refreshing the browser never interrupts sessions.

### Persona → CLI flag mapping

| Field | Claude Code | OpenCode |
|---|---|---|
| Working dir (cwd) | process cwd | process cwd (project dir) |
| Model | `--model` | `--model provider/model` |
| Agent | `--agent` | `--agent` |
| System prompt | `--append-system-prompt` | `--append-system-prompt` (ignored if unsupported) |
| Extra dirs (addDirs) | `--add-dir` (each) | — |
| Env vars | injected into process env | injected into process env |
| Extra args | appended verbatim | appended verbatim |

Personas are stored in `data/personas.json`; three examples are seeded on first start.

## Troubleshooting: node-pty `posix_spawnp failed`

On some macOS + recent-npm combinations, node-pty's `spawn-helper` is installed non-executable, and `pty.spawn()` throws `Error: posix_spawnp failed`. `setup.sh` / `start.sh` fix this automatically (`server/scripts/fix-node-pty.js`). Manual fix:

```bash
chmod +x server/node_modules/node-pty/prebuilds/<platform>/spawn-helper
```

## Architecture

```
Browser (React + xterm.js)
  ├── REST  /api/*   ── CRUD for personas / sessions
  └── WS    /ws      ── attach / input / resize ↔ output / status / exit / sessions
        │
Node backend (Fastify + ws + node-pty)
  ├── httpRoutes ── personaStore (JSON persistence) ── launcher (persona → argv/env/cwd)
  └── wsBridge ──── SessionManager ── PtySession { node-pty child + 1MiB scrollback ring }
        │
   claude CLI / opencode CLI / login shell
```

- **Persistence** — PTYs are children of the long-running backend, each with a scrollback buffer replayed on re-attach. A backend restart ends them (in-memory registry).
- **Launch** — `bash -lc 'exec <cli> …'`: the login shell loads your PATH, `exec` makes the PTY *become* the CLI so signals / resize pass straight through. All persona values are POSIX single-quoted. Plain terminals spawn `$SHELL -l`.
- **Live resize** — `ResizeObserver` + `xterm-addon-fit` compute cols/rows and sync them to `node-pty` over WS `resize` frames.

## Advanced: surviving backend restarts

Wrap the launch command in a re-attachable multiplexer (requires `tmux` or `dtach`):

```js
// in launcher.js change commandLine to:
// exec tmux new-session -A -s deck_<id> "<original command>"
```

## Security notes

- Binds to `127.0.0.1` only, **no authentication** — this is a local developer tool. Anyone who can reach the port can run commands as you; if exposing over the network, put an authenticating reverse proxy in front.
- Persona values are POSIX single-quoted before embedding in `bash -lc`; persona `env` filters keys that could execute code early (`BASH_ENV` / `ENV` / `BASH_FUNC_*` / `LD_PRELOAD` / `DYLD_*` / `PROMPT_COMMAND`). `extraArgs` remain operator-trusted input.
- Exited sessions are reaped after a grace period (`REAP_EXITED_AFTER_MS`, default 5 min); slow WebSocket clients trigger backpressure (the backend pauses reading from that PTY) instead of unbounded buffering.

## Repository layout

```
agent-deck/
├── package.json            # top-level scripts (setup / dev / build / start)
├── scripts/                # setup.sh / start.sh / dev.sh
├── data/personas.json      # persona presets (seeded on first start, git-ignored)
├── server/                 # backend (Fastify + ws + node-pty)
│   ├── src/{index,config,launcher,personaStore,PtySession,SessionManager,wsBridge,httpRoutes}.js
│   └── scripts/fix-node-pty.js
└── web/                    # frontend (React + Vite + xterm.js)
    └── src/{App,Sidebar,TerminalGrid,TerminalView,LaunchDialog,PersonaEditor,wsClient,api}.jsx|js
```
