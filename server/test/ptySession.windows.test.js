// Windows PTY-lifecycle checks.
//
// node-pty on Windows THROWS 'Signals not supported on windows.' for any signal
// argument, and queues that throw when the terminal isn't ready yet so it lands
// asynchronously. The old code passed 'SIGTERM' and swallowed the throw as
// "already gone", which meant stop/close reported success while the CLI and its
// ConPTY host kept running — one unkillable orphan per close. None of that is
// reachable from a Mac, so the platform and node-pty are both faked here.
//
// Run with: node --test server/test/ptySession.windows.test.js
import assert from 'node:assert/strict';
import os from 'node:os';
import test, { mock } from 'node:test';

const realPlatform = process.platform;
const setPlatform = (value) =>
  Object.defineProperty(process, 'platform', { value, configurable: true });

// Stand-in for node-pty. Mocked ONCE (node:test refuses to re-mock the same
// specifier) with a mutable `mode`, so each test can choose whether kill()
// reproduces the Windows refusal, the POSIX behavior, or a hard failure.
const fake = {
  mode: 'win32',
  calls: [],
  child: null,
};
fake.child = {
  onData() {},
  onExit() {},
  write() {},
  pause() {},
  resume() {},
  resize() {},
  kill(signal) {
    fake.calls.push(signal === undefined ? '<no-arg>' : signal);
    if (fake.mode === 'fail') throw new Error('EPERM');
    // The real WindowsTerminal.kill throws for ANY signal argument.
    if (fake.mode === 'win32' && signal) {
      throw new Error('Signals not supported on windows.');
    }
  },
};
fake.spawn = () => fake.child;

mock.module('node-pty', { defaultExport: fake, namedExports: { spawn: fake.spawn } });

/**
 * Import PtySession with process.platform and node-pty both faked.
 *
 * node-pty is mocked because it loads a native .node binary for the *host*
 * platform — under a faked process.platform it looks for prebuilds/win32-x64
 * on a Mac and fails to load at all, so the real module can't be used here.
 */
async function freshSession({ platform, mode = platform }) {
  fake.mode = mode;
  fake.calls.length = 0;
  setPlatform(platform);
  try {
    // Bust the cache so PtySession re-reads the faked platform on import.
    const bust = `${platform}-${Math.random().toString(36).slice(2)}`;
    const mod = await import(`../src/PtySession.js?bust=${bust}`);
    return { mod, fake };
  } finally {
    setPlatform(realPlatform);
  }
}

const LAUNCH = {
  kind: 'terminal',
  file: 'cmd.exe',
  args: [],
  cwd: os.tmpdir(),
  env: {},
  commandLine: 'cmd.exe',
  label: 'Terminal',
};

test('windows: kill() passes NO signal, so node-pty does not throw', async () => {
  const { mod, fake } = await freshSession({ platform: 'win32' });
  setPlatform('win32');
  try {
    const s = new mod.PtySession({ launch: LAUNCH });
    const ok = s.kill('SIGTERM');
    assert.equal(ok, true, 'kill must report success on Windows');
    assert.deepEqual(fake.calls, ['<no-arg>'], 'must call kill() with no signal');
  } finally {
    setPlatform(realPlatform);
  }
});

test('windows: no SIGKILL escalation is scheduled (there is nothing to escalate)', async () => {
  const { mod, fake } = await freshSession({ platform: 'win32' });
  setPlatform('win32');
  try {
    const s = new mod.PtySession({ launch: LAUNCH });
    s.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 60));
    assert.deepEqual(
      fake.calls,
      ['<no-arg>'],
      'a queued SIGKILL would throw asynchronously outside any try/catch'
    );
  } finally {
    setPlatform(realPlatform);
  }
});

test('posix: still sends the real signal and escalates to SIGKILL', async () => {
  const { mod } = await freshSession({ platform: 'linux' });
  setPlatform('linux');
  try {
    const s = new mod.PtySession({ launch: { ...LAUNCH, file: '/bin/sh' } });
    assert.equal(s.kill('SIGTERM'), true);
    assert.deepEqual(fake.calls, ['SIGTERM'], 'POSIX must receive the real signal');
    // Escalation is scheduled KILL_ESCALATE_MS later (config default 1500ms);
    // config.js is already cached by this point in the run, so wait it out
    // rather than trying to re-inject a shorter value.
    await new Promise((r) => setTimeout(r, 1700));
    assert.deepEqual(
      fake.calls,
      ['SIGTERM', 'SIGKILL'],
      'an interactive shell ignores SIGTERM, so escalation must still happen'
    );
  } finally {
    setPlatform(realPlatform);
  }
});

test('a kill that genuinely fails reports false instead of claiming success', async () => {
  const { mod } = await freshSession({ platform: 'linux', mode: 'fail' });
  setPlatform('linux');
  try {
    const s = new mod.PtySession({ launch: { ...LAUNCH, file: '/bin/sh' } });
    assert.equal(s.kill('SIGTERM'), false, 'caller must be able to tell the kill failed');
  } finally {
    setPlatform(realPlatform);
  }
});
