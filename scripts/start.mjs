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
import { NPM, ROOT, isPortBusy, run, runOrDie } from './lib.mjs';

const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || '127.0.0.1';

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
    console.error(`     lsof -ti tcp:${PORT} | xargs kill     # if lsof is installed`);
    console.error(`     PORT=4200 npm start`);
  }
  process.exit(1);
}

if (!fs.existsSync(path.join(ROOT, 'web', 'dist', 'index.html'))) {
  console.log('==> web/dist not found — building the frontend first');
  await runOrDie(NPM, ['--prefix', 'web', 'run', 'build']);
}

console.log(`==> Dashboard: http://${HOST}:${PORT}`);
const code = await run(NPM, ['--prefix', 'server', 'run', 'start'], {
  env: { ...process.env, PORT: String(PORT), HOST },
});
process.exit(code);
