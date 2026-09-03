#!/usr/bin/env node
// Production start: the backend serves the built UI and the WebSocket bridge
// on a single port (default 4173).
//
// Replaces start.sh, whose port preflight relied on lsof + `ps -o command=` and
// a forward-slash glob against the command line — none of which work on
// Windows, and lsof is absent on many Linux installs (where a missing lsof read
// as "port free" and the backend then died on EADDRINUSE).
import fs from 'node:fs';
import path from 'node:path';
import { NPM, ROOT, isPortBusy, killTree, run, runOrDie, waitForPortFree } from './lib.mjs';

const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || '127.0.0.1';
const IS_WINDOWS = process.platform === 'win32';

if (await isPortBusy(PORT, HOST)) {
  // We deliberately do NOT try to identify and kill the holder. The old script
  // pattern-matched `ps` output to decide whether the listener was "our own
  // stale instance" and killed it — a guess that misfires on a renamed checkout
  // and cannot work on Windows. Refusing with instructions is honest and can't
  // kill an unrelated process.
  console.error(`!! Port ${PORT} is already in use on ${HOST}.`);
  console.error('   Stop whatever is listening, or pick another port:');
  if (process.platform === 'win32') {
    console.error(`     netstat -ano | findstr :${PORT}      # find the PID`);
    console.error('     taskkill /PID <pid> /F');
    console.error(`     set PORT=4200 && npm start           # or: $env:PORT=4200; npm start`);
  } else {
    // -sTCP:LISTEN: without it lsof also lists every local *client* of the
    // port — a connected browser included — and xargs kill would take it down.
    console.error(`     lsof -ti tcp:${PORT} -sTCP:LISTEN | xargs kill     # if lsof is installed`);
    console.error(`     PORT=4200 npm start`);
  }
  process.exit(1);
}

if (!fs.existsSync(path.join(ROOT, 'web', 'dist', 'index.html'))) {
  console.log('==> web/dist not found — building the frontend first');
  await runOrDie(NPM, ['--prefix', 'web', 'run', 'build']);
}

// Keep a handle on the backend so a signal to this script tears the whole
// tree down. Without it a programmatic SIGTERM (kill <pid>, a supervisor, an
// editor's stop button) or a closing terminal (SIGHUP) killed only this
// wrapper: `node src/index.js` lived on, still holding the port, and the next
// `npm start` refused to start. Spawned detached on POSIX so it is a group
// leader and killTree's negative-PID signal reaches npm, sh and node alike.
let backend = null;
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  killTree(backend);
};
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, stop);
process.on('exit', () => killTree(backend));

console.log(`==> Dashboard: http://${HOST}:${PORT}`);
const code = await run(NPM, ['--prefix', 'server', 'run', 'start'], {
  env: { ...process.env, PORT: String(PORT), HOST },
  detached: !IS_WINDOWS,
  onSpawn: (child) => {
    backend = child;
    if (stopping) killTree(child); // signalled before the spawn landed
  },
});

// run() resolves when npm exits, and npm dies on the first SIGTERM whether or
// not the backend behind it has finished flushing — so the port is the only
// honest signal that the tree is really gone. Escalate only for a stop we
// initiated: then the group is known to be ours. Otherwise (the backend died
// on its own, or someone killed npm in the middle of the tree) say so.
if (!IS_WINDOWS && !(await waitForPortFree(PORT, 5000, HOST))) {
  if (stopping && backend) {
    try {
      process.kill(-backend.pid, 'SIGKILL');
    } catch {
      /* gone after all */
    }
  } else {
    console.error(`!! The backend is still listening on ${HOST}:${PORT} after its wrapper exited.`);
    console.error(`   Find it with: lsof -nP -iTCP:${PORT} -sTCP:LISTEN`);
  }
}
process.exit(stopping ? 0 : code);
