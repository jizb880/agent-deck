// Ensures node-pty's prebuilt `spawn-helper` is executable.
//
// On macOS the prebuilt tarball can extract spawn-helper as `-rw-r--r--` (not
// executable), and npm's allow-scripts gate can skip node-pty's own postinstall
// entirely; pty.spawn() then throws `Error: posix_spawnp failed`. This makes the
// fix explicit and idempotent so `npm install` "just works".
//
// Scope by platform:
//   macOS   — spawn-helper is used, and is the known-broken case.
//   Linux   — node-pty calls forkpty(3) directly and builds no spawn-helper, so
//             there is normally nothing here; a from-source build layout is
//             still checked in case that changes. (node-pty 1.1.0 ships no
//             Linux prebuild, so Linux compiles from source and needs
//             python3 + make + a C++ toolchain.)
//   Windows — ConPTY/winpty use conpty.dll / winpty-agent.exe and Windows has
//             no executable bit, so there is nothing to do.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NODE_PTY = path.join(__dirname, '..', 'node_modules', 'node-pty');

if (process.platform === 'win32') {
  process.exit(0);
}

function candidates() {
  const out = [
    // From-source build layouts.
    path.join(NODE_PTY, 'build', 'Release', 'spawn-helper'),
    path.join(NODE_PTY, 'build', 'Debug', 'spawn-helper'),
  ];
  // Prebuild layout: prebuilds/<platform>-<arch>/spawn-helper. Enumerated
  // rather than guessed, so a new platform/arch tuple is picked up for free.
  const prebuilds = path.join(NODE_PTY, 'prebuilds');
  try {
    for (const dir of fs.readdirSync(prebuilds)) {
      out.push(path.join(prebuilds, dir, 'spawn-helper'));
    }
  } catch {
    /* no prebuilds dir — from-source install */
  }
  return out;
}

const found = candidates().filter((p) => fs.existsSync(p));
let fixed = 0;
for (const p of found) {
  try {
    // Only chmod when the bit is actually missing, so a healthy install stays
    // quiet instead of logging on every start.
    if ((fs.statSync(p).mode & 0o111) === 0o111) continue;
    fs.chmodSync(p, 0o755);
    fixed++;
    console.log(`[fix-node-pty] chmod +x ${p}`);
  } catch (err) {
    console.warn(`[fix-node-pty] could not chmod ${p}: ${err.message}`);
  }
}

// Only warn where a missing helper is a real problem. On Linux node-pty never
// builds one, so its absence is expected and a warning would just be noise.
if (found.length === 0 && process.platform === 'darwin') {
  console.warn(
    '[fix-node-pty] no spawn-helper found; if pty.spawn throws posix_spawnp, run: ' +
      'chmod +x server/node_modules/node-pty/prebuilds/darwin-*/spawn-helper'
  );
}
