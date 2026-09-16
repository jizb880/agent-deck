// Codex and Claude Code probe for synchronized output (DECRQM `CSI ?2026$p`)
// within milliseconds of being spawned, and draw their composer unsynchronized
// -- visibly, without its shaded background -- if nothing reports the mode as
// recognized. The reply used to come from the browser, which on a freshly
// created session has not attached yet, so the probe was intermittently lost.
// PtySession answers it instead, with no client involved.
//
// node-pty is faked so no child is spawned; output is fed straight in and
// everything the session writes back is recorded.
import assert from 'node:assert/strict';
import os from 'node:os';
import test, { mock } from 'node:test';

const writes = [];
const child = {
  onData() {},
  onExit() {},
  write(data) {
    writes.push(data);
  },
  pause() {},
  resume() {},
  resize() {},
  kill() {},
};
mock.module('node-pty', { defaultExport: { spawn: () => child }, namedExports: { spawn: () => child } });

const { PtySession } = await import('../src/PtySession.js');

const LAUNCH = {
  kind: 'codex',
  file: '/bin/sh',
  args: [],
  cwd: os.tmpdir(),
  env: {},
  commandLine: 'codex',
  label: 'Codex',
};

// Feeds the chunk in and waits for the emulator to finish parsing it, which is
// when any registered CSI handler has run.
async function feed(session, chunk) {
  session._onData(chunk);
  await session.getSnapshot();
}

test('the mode 2026 probe is answered with no client attached', async () => {
  writes.length = 0;
  const s = new PtySession({ launch: LAUNCH });
  await feed(s, '\x1b[?2026$p');
  assert.deepEqual(writes, ['\x1b[?2026;2$y'], 'reports 2026 as recognized, currently reset');
  s.release();
});

test('the probe is answered when it arrives in the same chunk as other output', async () => {
  writes.length = 0;
  const s = new PtySession({ launch: LAUNCH });
  await feed(s, 'starting codex\r\n\x1b[?2026$p\x1b[2J');
  assert.deepEqual(writes, ['\x1b[?2026;2$y']);
  s.release();
});

test('other modes stay unanswered', async () => {
  writes.length = 0;
  const s = new PtySession({ launch: LAUNCH });
  await feed(s, '\x1b[?1049$p\x1b[?25$p\x1b[?1000$p');
  assert.deepEqual(writes, [], 'only mode 2026 is advertised');
  s.release();
});

test('an exited session does not write to a dead pty', async () => {
  writes.length = 0;
  const s = new PtySession({ launch: LAUNCH });
  s._onExit(0, null);
  await feed(s, '\x1b[?2026$p');
  assert.deepEqual(writes, []);
  s.release();
});
