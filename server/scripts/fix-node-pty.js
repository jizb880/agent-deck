// Ensures node-pty's prebuilt `spawn-helper` is executable.
//
// On macOS 12 / Node 24 / npm 11 the prebuilt binary for node-pty extracts
// spawn-helper as `-rw-r--r--` (not executable). pty.spawn() then throws
// `Error: posix_spawnp failed`. npm 11's allow-scripts gate can also skip
// node-pty's own postinstall entirely. This script makes the fix explicit and
// idempotent so `npm install` "just works" on this platform.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function candidates() {
  const base = path.join(__dirname, '..', 'node_modules', 'node-pty', 'prebuilds');
  const arch = process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
  const out = [
    path.join(base, arch, 'spawn-helper'),
    // Also cover a from-source build layout, just in case.
    path.join(__dirname, '..', 'node_modules', 'node-pty', 'build', 'Release', 'spawn-helper'),
  ];
  return out;
}

if (os.platform() !== 'darwin') {
  // Nothing to do off macOS.
  process.exit(0);
}

let fixed = 0;
for (const p of candidates()) {
  try {
    if (fs.existsSync(p)) {
      fs.chmodSync(p, 0o755);
      fixed++;
      console.log(`[fix-node-pty] chmod +x ${p}`);
    }
  } catch (err) {
    console.warn(`[fix-node-pty] could not chmod ${p}: ${err.message}`);
  }
}
if (fixed === 0) {
  console.warn(
    '[fix-node-pty] no spawn-helper found; if pty.spawn throws posix_spawnp, ' +
      'run: chmod +x node_modules/node-pty/prebuilds/darwin-*/spawn-helper'
  );
}
