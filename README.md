# Agent Deck

**English** | [简体中文](./README.zh-CN.md)

A local web dashboard for running and orchestrating **multiple AI coding agent CLIs (`claude` / `opencode`) and plain shell terminals side by side**: real PTY terminals, session persistence (processes keep running across browser refreshes and can be re-attached), one-click persona presets, and a sidebar + tabs / split-pane layout.

---

## Features

- **Multiple CLI instances** — `xterm.js` (frontend) + `node-pty` (backend) + WebSocket for real-time bidirectional I/O, with full ANSI color and interactive TUI support.
- **Process persistence / re-attach** — every PTY session is hosted by the long-running backend and keeps 1 MiB of scrollback; after a browser refresh or disconnect the frontend re-attaches and replays the full terminal history.
- **Personas** — configure and save presets (e.g. Refactor Expert / Security Auditor / Doc Writer) with system prompt, model, working directory, env vars and extra args; launch them with one click from the Quick Launch area.
- **Plain terminals** — the "+ 终端" button opens your login shell as a tab, right next to the agent sessions.
- **Session board** — the sidebar shows live status for every session (starting / running / busy / idle / exited) and its kind; the main area supports tabs or resizable split panes with live terminal resize.
- **Per-session workspace** — each session can target a different local project directory.

---

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
   claude CLI / opencode CLI / login shell  (real interactive TUIs)
```

**Key design points**

1. **Persistence model** — PTYs are children of the long-running backend, each with its own scrollback buffer. Refreshing or closing the browser leaves the child running; on reconnect the frontend re-attaches, the backend replays the buffer, and xterm redraws the full history. A **backend restart** ends the children (in-memory registry); see "Advanced" below if you need survival across backend restarts.
2. **Launch strategy** — `bash -lc 'exec <cli> …'`. The login shell loads the user's PATH (so globally installed `claude` / `opencode` resolve), and `exec` makes the PTY *become* the CLI, so signals / resize / Ctrl-C pass straight through. All persona values are POSIX single-quoted to rule out command injection. Plain terminals spawn your `$SHELL -l` directly.
3. **Live resize** — the frontend combines `ResizeObserver` + `xterm-addon-fit` to compute cols/rows and syncs them to `node-pty` over WS `resize` frames, so tab switches and split-pane drags apply instantly.

---

## Install

### Prerequisites

- **Node.js ≥ 18**.
- A C/C++ toolchain for `node-pty`'s native module (macOS: `xcode-select --install`; Linux: `build-essential` / `python3`).
- `claude` and/or `opencode` CLIs installed, logged in, and on your PATH (only needed for the kinds you plan to launch).

### One-shot setup

```bash
npm run setup
```

`setup` installs `server/` and `web/` dependencies → **fixes the executable bit on node-pty's `spawn-helper`** (see "Important" below) → builds the frontend into `web/dist`.

### Run

```bash
# Production mode: the backend serves the UI and WebSocket on a single port
./scripts/start.sh
# open http://127.0.0.1:4173

# Dev mode: Vite HMR + backend hot reload (Vite proxies /api and /ws)
npm run dev
# open http://127.0.0.1:5173
```

Environment variables: `PORT` (default 4173), `HOST` (default 127.0.0.1), `SCROLLBACK_BYTES`, `IDLE_AFTER_MS`, `CONTROL_APP_DATA` (directory for personas.json).

---

## ⚠️ Important: node-pty pitfall (auto-fixed)

With some macOS + recent-npm combinations, `node-pty` installs a prebuilt binary but leaves `spawn-helper` **non-executable** (`-rw-r--r--`), making `pty.spawn()` throw `Error: posix_spawnp failed`; recent npm versions may also skip node-pty's postinstall script by default.

This repo ships a fix: `server/scripts/fix-node-pty.js` (runs as the server's postinstall and is re-run idempotently by `setup.sh` / `start.sh`). The essence:

```bash
chmod +x server/node_modules/node-pty/prebuilds/<platform>/spawn-helper
# e.g. darwin-x64 or darwin-arm64
```

If you still hit `posix_spawnp failed` elsewhere, run that line manually.

---

## Usage

1. **Quick Launch** (sidebar): open a bare `claude` / `opencode` session, click a **persona chip** to launch with that preset, or hit **+ 终端** for a plain shell tab.
2. The launch dialog lets you override working dir / model / title before spawning.
3. Switch the main area between **Tabs** and **Split** at the top; drag the split handles to resize terminals live.
4. The sidebar **Sessions** list shows live status. The sidebar **停止** button and the tab's **×** both do the same thing: terminate the CLI and close its tab. Exited sessions linger briefly (readable final output), can be removed manually, and are auto-reaped.
5. **Refreshing the browser** never interrupts sessions — reopen a tab to restore full history.

### Persona → CLI flag mapping

| Field | Claude Code | OpenCode |
|---|---|---|
| Working dir (cwd) | process cwd | process cwd (project dir) |
| Model | `--model` | `--model provider/model` |
| Agent | `--agent` | `--agent` |
| System prompt | `--append-system-prompt` | via `--append-system-prompt` (ignored if unsupported) |
| Extra dirs (addDirs) | `--add-dir` (each) | — |
| Env vars | injected into process env | injected into process env |
| Extra args | appended verbatim | appended verbatim |

> Personas are stored in `data/personas.json`; three example personas are seeded on first start.

---

## Advanced: surviving backend restarts

Sessions live in the backend's memory, so restarting the backend ends the child CLIs. For stronger persistence, wrap the launch command in a re-attachable multiplexer:

```js
// in launcher.js change commandLine to:
// exec tmux new-session -A -s deck_<id> "<original command>"
```

Then after a backend restart you can still `tmux attach` to the session (requires `tmux` or `dtach`). Optional enhancement, not part of the default path.

---

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

## Security notes

- Binds to `127.0.0.1` only by default, with **no authentication** — this is a local developer tool. If you bind to `0.0.0.0` or expose it over the network, put a reverse proxy with auth in front; anyone who can reach the port can run CLI commands as you on your machine.
- All persona values are POSIX single-quoted before being embedded in `bash -lc`, preventing command injection.
- Persona `env` filters out keys that would let a non-interactive `bash -lc` execute code early (`BASH_ENV` / `ENV` / `BASH_FUNC_*` / `LD_PRELOAD` / `DYLD_*` / `PROMPT_COMMAND`), so env vars can't bypass the "can only launch a CLI" boundary. `extraArgs` remain operator-trusted input — don't paste untrusted content there.
- Exited sessions are kept for a grace period (default 5 minutes, tune with `REAP_EXITED_AFTER_MS`) so a client can still read final output / exit code, then auto-reaped to free their scrollback and keep memory bounded under session churn.
- Slow clients trigger backpressure: when a WebSocket send buffer exceeds a threshold the backend pauses reading from that PTY (the kernel pipe throttles naturally) instead of buffering output unboundedly in Node.
