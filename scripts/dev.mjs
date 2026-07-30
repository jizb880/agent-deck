#!/usr/bin/env node
// Dev mode: backend with hot reload + Vite dev server with HMR. Vite proxies
// /api and /ws to the backend, so the UI is at http://127.0.0.1:5173.
//
// Replaces dev.sh. Besides not running on Windows, that script had a bug on
// every platform: it backgrounded the backend with `&` and then tried
// `kill -- -$PID` to reap the tree, but a background job in a non-interactive
// script is not a process-group leader, so the negative-PID kill failed and only
// the npm wrapper died — orphaning `node --watch` and its PTY children still
// holding port 4173, which broke the next `npm run dev`. Here the backend is
// spawned detached (making it a real group leader) so killTree can signal the
// whole group, and Ctrl-C is handled explicitly.
import { NPM, isPortBusy, killTree, run } from './lib.mjs';
import { spawn } from 'node:child_process';

const PORT = Number(process.env.PORT || 4173);
const IS_WINDOWS = process.platform === 'win32';

if (await isPortBusy(PORT)) {
  console.error(`!! Port ${PORT} is already in use — stop the other backend first.`);
  process.exit(1);
}

// Tell Vite where the backend is, so a PORT override still proxies correctly
// (web/vite.config.js reads $BACKEND).
const env = { ...process.env, PORT: String(PORT), BACKEND: `http://127.0.0.1:${PORT}` };

const backend = spawn(NPM, ['--prefix', 'server', 'run', 'dev'], {
  stdio: 'inherit',
  shell: IS_WINDOWS,
  // Own process group on POSIX so the whole tree can be signalled at once.
  detached: !IS_WINDOWS,
  env,
});

// Vite's handle, once it has spawned. Tracked so a programmatic SIGTERM tears
// it down too — otherwise only the backend dies and Vite keeps port 5173.
let web = null;

let shuttingDown = false;
const shutdown = (code) => {
  if (shuttingDown) return;
  shuttingDown = true;
  killTree(backend);
  killTree(web);
  process.exit(code);
};

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('exit', () => {
  killTree(backend);
  killTree(web);
});
backend.on('exit', (code) => {
  if (!shuttingDown) {
    console.error(`!! Backend exited (code ${code}) — stopping dev server.`);
    shutdown(code ?? 1);
  }
});

console.log(`==> Backend on http://127.0.0.1:${PORT} (PID ${backend.pid})`);
console.log('==> Open the UI at http://127.0.0.1:5173');

// Vite runs in the foreground; when it exits, tear the backend down too. Its
// own group on POSIX, for the same reason as the backend: Vite spawns esbuild
// helpers that a single-PID kill would leave behind.
const code = await run(NPM, ['--prefix', 'web', 'run', 'dev'], {
  env,
  detached: !IS_WINDOWS,
  onSpawn: (child) => {
    web = child;
  },
});
shutdown(code);
