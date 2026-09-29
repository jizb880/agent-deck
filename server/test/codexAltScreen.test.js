// Codex's alternate screen is what removed the pane's scrollbar and swallowed
// drag-to-select, so these lock in the three things that make the fix safe:
// the flag reaches the CLI on every platform and both argv paths, it is absent
// by default (so nothing changes for anyone else), and it is only emitted when
// the installed binary actually advertises it — an unknown argument makes codex
// exit 2 at startup, which would kill the tab.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import * as launcher from '../src/launcher.js';
import {
  supportsFlag,
  codexSupportsNoAltScreen,
  resetCliCapabilitiesCache,
} from '../src/cliCapabilities.js';
import { CLI_KINDS } from '../src/config.js';

const realPlatform = process.platform;
function setPlatform(value) {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

function withPlatform({ platform, env }, fn) {
  const savedEnv = process.env;
  setPlatform(platform);
  process.env = { ...env };
  try {
    return fn();
  } finally {
    process.env = savedEnv;
    setPlatform(realPlatform);
  }
}

function fakeBinDir(names) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctlapp-alt-'));
  for (const n of names) {
    fs.writeFileSync(path.join(dir, n), '');
    fs.chmodSync(path.join(dir, n), 0o755);
  }
  return dir;
}

const WIN_ENV = (bin) => ({
  PATH: bin,
  PATHEXT: '.COM;.EXE;.BAT;.CMD',
  USERPROFILE: os.tmpdir(),
  COMSPEC: 'C:\\Windows\\System32\\cmd.exe',
});

const FLAG = CLI_KINDS.codex.noAltScreenFlag;
assert.equal(FLAG, '--no-alt-screen', 'codex must declare the flag it is probed for');

test('codex inline mode: the flag reaches the CLI on every platform', () => {
  for (const platform of ['win32', 'linux', 'darwin']) {
    const bin = fakeBinDir(['bash', 'codex', 'codex.cmd']);
    const env = platform === 'win32' ? WIN_ENV(bin) : { PATH: bin, HOME: os.tmpdir() };
    const plan = withPlatform({ platform, env }, () =>
      launcher.buildLaunch({ kind: 'codex' }, { cwd: os.tmpdir(), noAltScreen: true })
    );

    const argv = platform === 'win32' ? plan.args : plan.args[1];
    if (platform === 'win32') {
      assert.ok(plan.args.includes(FLAG), `win32 argv must carry ${FLAG}`);
    } else {
      assert.equal(argv, `exec codex '${FLAG}'`, `${platform} -lc string`);
    }
  }
});

test('codex inline mode: the resume subcommand path carries it too', () => {
  // `codex resume <id>` builds its own argv, and a flag emitted on only the
  // fresh-launch path would silently leave every reopened session broken.
  const bin = fakeBinDir(['bash', 'codex']);
  const env = { PATH: bin, HOME: os.tmpdir() };
  const id = '92d24c92-b5c5-4329-aedf-d51633d1cd6e';

  const plan = withPlatform({ platform: 'linux', env }, () =>
    launcher.buildLaunch({ kind: 'codex' }, { cwd: os.tmpdir(), resumeSessionId: id, noAltScreen: true })
  );
  assert.ok(plan.args[1].includes('resume'), 'still a resume launch');
  assert.ok(plan.args[1].includes(id), 'still resumes the same conversation');
  assert.ok(plan.args[1].includes(FLAG), `resume argv must carry ${FLAG}`);
});

test('codex inline mode: absent unless asked for', () => {
  // The default must stay byte-identical: the probe result decides, and every
  // other launch (and every other CLI) is unaffected.
  const bin = fakeBinDir(['bash', 'codex', 'claude']);
  const env = { PATH: bin, HOME: os.tmpdir() };

  const off = withPlatform({ platform: 'linux', env }, () =>
    launcher.buildLaunch({ kind: 'codex' }, { cwd: os.tmpdir() })
  );
  assert.equal(off.args[1], 'exec codex');

  // Only codex declares the flag, so asking for it on another CLI is a no-op
  // rather than an unknown-argument crash.
  const claude = withPlatform({ platform: 'linux', env }, () =>
    launcher.buildLaunch({ kind: 'claude' }, { cwd: os.tmpdir(), noAltScreen: true })
  );
  assert.ok(!claude.args[1].includes(FLAG), 'claude has no alt-screen flag');
});

test('capability probe: reads the flag out of the CLI\'s own --help', async () => {
  // The probe is what stands between "scrollbar restored" and "codex exits 2
  // at spawn". It asks the binary rather than comparing versions, so a
  // backport or a rename is still answered correctly.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctlapp-probe-'));
  const script = path.join(dir, 'codex-probe');
  const realBin = CLI_KINDS.codex.bin;
  const savedPlatform = process.platform;

  const write = (body) => {
    fs.writeFileSync(script, `#!/bin/sh\n${body}\n`);
    fs.chmodSync(script, 0o755);
  };
  const env = { PATH: dir, HOME: os.tmpdir() };

  try {
    resetCliCapabilitiesCache();
    write('echo "  --no-alt-screen  Disable alternate screen mode"');
    CLI_KINDS.codex.bin = script; // absolute path: immune to the login PATH
    const supported = await withPlatform({ platform: 'linux', env }, () =>
      codexSupportsNoAltScreen()
    );
    assert.equal(supported, true, 'a binary that advertises the flag must report true');

    resetCliCapabilitiesCache();
    write('echo "no such option here"');
    const unsupported = await withPlatform({ platform: 'linux', env }, () =>
      codexSupportsNoAltScreen()
    );
    assert.equal(unsupported, false, 'a binary that omits it must report false');

    // A prefix must not be mistaken for the flag itself.
    resetCliCapabilitiesCache();
    write('echo "  --no-alt-screen-extended"');
    const extra = await withPlatform({ platform: 'linux', env }, () =>
      codexSupportsNoAltScreen()
    );
    assert.equal(extra, false, 'a longer flag sharing the prefix is not a match');

    // An unrunnable binary is a false, not a rejection: the caller simply
    // launches the way it did before the probe existed.
    resetCliCapabilitiesCache();
    CLI_KINDS.codex.bin = path.join(dir, 'does-not-exist');
    const missing = await withPlatform({ platform: 'linux', env }, () =>
      codexSupportsNoAltScreen()
    );
    assert.equal(missing, false, 'a missing binary must resolve false, never reject');

    // An absent flag argument is a false too, so the guard can't be bypassed.
    assert.equal(await supportsFlag('codex', null), false);
    assert.equal(await supportsFlag('terminal', '--anything'), false, 'no binary, no probe');
  } finally {
    setPlatform(savedPlatform);
    CLI_KINDS.codex.bin = realBin;
    resetCliCapabilitiesCache();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
