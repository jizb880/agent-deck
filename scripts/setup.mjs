#!/usr/bin/env node
// One-shot setup: install backend + frontend deps and build the UI.
// Works on macOS, Linux and Windows (cmd / PowerShell) — see scripts/lib.mjs
// for why this is Node rather than bash.
import { NPM, runOrDie } from './lib.mjs';

console.log('==> Agent Deck setup');
console.log(`    node ${process.version}   platform ${process.platform}/${process.arch}`);

console.log('\n==> Installing backend dependencies (server/)');
// --foreground-scripts so node-pty's install/postinstall actually run and we
// see their output; npm's allow-scripts gate can otherwise skip them silently.
await runOrDie(NPM, ['--prefix', 'server', 'install', '--foreground-scripts']);

console.log('\n==> Installing frontend dependencies (web/)');
await runOrDie(NPM, ['--prefix', 'web', 'install']);

console.log('\n==> Building frontend (web/dist)');
await runOrDie(NPM, ['--prefix', 'web', 'run', 'build']);

console.log('\n==> Done. Start the dashboard with:');
console.log('    npm start          # production (backend serves the built UI)');
console.log('    npm run dev        # dev (Vite HMR + backend hot reload)');
