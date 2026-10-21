// A timed-out capability probe must not disable a launch flag for the life of
// the process.
//
// This is the regression that broke codex scrolling in the dashboard: the
// probe ran `bash -lc 'codex --help'`, the user's login shell alone takes ~3s
// on macOS, the 3s timeout fired, the probe reported "unsupported", and that
// answer was cached. Every codex tab after it was spawned without
// --no-alt-screen, so it drew on the alternate screen (no scrollback at all)
// and turned on mouse tracking (the wheel never reached the viewport).
//
// What has to hold:
//   1. A probe that times out reports false to its caller but is NOT cached,
//      so the next launch probes again and can find the flag.
//   2. A definitive "no" (the binary answered, without the flag) still IS
//      cached — no reason to re-spawn a CLI that told us its arguments.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// Set before the module reads them. Short enough that a sleeping fake CLI
// reliably exceeds them, long enough that a plain `#!/bin/sh` echo never does
// (node's own spawn overhead alone can reach ~260ms on macOS).
process.env.CLI_PROBE_TIMEOUT_MS = '1500';
process.env.CLI_PROBE_LOGIN_TIMEOUT_MS = '1500';

const { supportsFlag, resetCliCapabilitiesCache } = await import('../src/cliCapabilities.js');
const { CLI_KINDS } = await import('../src/config.js');

function writeBin(dir, body) {
  const file = path.join(dir, 'codex');
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

test('a timed-out probe is not cached and the next call re-probes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctlapp-timeout-'));
  const realBin = CLI_KINDS.codex.bin;
  try {
    resetCliCapabilitiesCache();
    // Slow answer: the probe times out and sees no output at all.
    CLI_KINDS.codex.bin = writeBin(dir, 'sleep 5; echo "  --no-alt-screen  inline mode"');
    const first = await supportsFlag('codex', '--no-alt-screen');
    assert.equal(first, false, 'a timed-out probe resolves false for this caller');

    // Same binary path, now fast. If the timeout had been cached this would
    // still be false and every codex pane would stay broken until restart.
    writeBin(dir, 'echo "  --no-alt-screen  inline mode"');
    const second = await supportsFlag('codex', '--no-alt-screen');
    assert.equal(second, true, 'a timeout must not poison the cache');
  } finally {
    CLI_KINDS.codex.bin = realBin;
    resetCliCapabilitiesCache();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a definitive negative answer is cached', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctlapp-negative-'));
  const realBin = CLI_KINDS.codex.bin;
  const marker = path.join(dir, 'calls');
  try {
    resetCliCapabilitiesCache();
    // Counts invocations, then answers without the flag.
    CLI_KINDS.codex.bin = writeBin(dir, `echo x >> '${marker}'; echo "usage: codex [OPTIONS]"`);

    assert.equal(await supportsFlag('codex', '--no-alt-screen'), false);
    assert.equal(await supportsFlag('codex', '--no-alt-screen'), false);
    const calls = fs.readFileSync(marker, 'utf8').trim().split('\n').length;
    assert.equal(calls, 1, 'a real "no" is answered once and reused');
  } finally {
    CLI_KINDS.codex.bin = realBin;
    resetCliCapabilitiesCache();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
