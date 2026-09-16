// Terminal probes and the busy/idle heuristic.
//
// Two behaviours that both depend on what the child *draws* rather than on the
// bytes it emits:
//
//   1. Codex asks for the terminal's background colour (OSC 11) at startup and
//      keys its palette off the answer. Nothing else in the stack replies --
//      xterm.js only handles the *set* form -- so PtySession must, or the CLI
//      styles itself for a guessed theme.
//
//   2. An idle Codex repaints ~12 times/second to animate its highlighted row,
//      changing colour attributes but not the text on screen. The old heuristic
//      counted any arriving byte as activity, so the idle timer was re-armed
//      forever and a finished session stayed "busy".
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
// when any registered handler has run and _onRendered() has completed.
async function feed(session, chunk) {
  session._onData(chunk);
  await session.getSnapshot();
}

// ---- terminal probes ----

test('the OSC 11 background query is answered without a client attached', async () => {
  writes.length = 0;
  const s = new PtySession({ launch: LAUNCH });
  await feed(s, '\x1b]11;?\x1b\\');
  assert.deepEqual(writes, ['\x1b]11;rgb:ffff/ffff/ffff\x1b\\'], 'reports the light theme background');
  s.release();
});

test('the OSC 10 foreground query is answered too', async () => {
  writes.length = 0;
  const s = new PtySession({ launch: LAUNCH });
  await feed(s, '\x1b]10;?\x1b\\');
  assert.deepEqual(writes, ['\x1b]10;rgb:2429/2f24/2f24\x1b\\']);
  s.release();
});

test('a BEL-terminated query is answered, not just ST-terminated', async () => {
  writes.length = 0;
  const s = new PtySession({ launch: LAUNCH });
  await feed(s, '\x1b]11;?\x07');
  assert.deepEqual(writes, ['\x1b]11;rgb:ffff/ffff/ffff\x1b\\']);
  s.release();
});

test('setting a colour is not answered, only querying it', async () => {
  writes.length = 0;
  const s = new PtySession({ launch: LAUNCH });
  // A CLI painting its own background must not provoke a reply; answering
  // would put an escape sequence into its input stream.
  await feed(s, '\x1b]11;rgb:0000/0000/0000\x1b\\');
  assert.deepEqual(writes, []);
  s.release();
});

// ---- busy/idle ----

test('an idle repaint that only changes colours does not count as activity', async () => {
  const s = new PtySession({ launch: LAUNCH });

  // The box is already on screen, so the repaints below re-print characters
  // that are already there -- only their colour attributes differ.
  const box = '\x1b[?2026h\x1b[2m╭───╮\x1b[39m\x1b[49m\x1b[0m\x1b[?2026l';
  await feed(s, box);
  assert.equal(s.status, 'busy', 'drawing text is activity');
  s.status = 'idle'; // pretend the idle timer already fired

  // Exactly the shape of an idle Codex animation: reset attributes, move the
  // cursor, re-print the same characters in a different colour, restore mode.
  const frames = [
    '\x1b[?2026h\x1b[39m\x1b[49m\x1b[0m\x1b[1;1H\x1b[0 q\x1b[1;1H\x1b[2m╭───╮\x1b[39m\x1b[49m\x1b[0m\x1b[9;3H\x1b[?25h\x1b[?2026l',
    '\x1b[?2026h\x1b[1;1H\x1b[38;2;246;226;183;49m╭───╮\x1b[39m\x1b[49m\x1b[0m\x1b[9;3H\x1b[?25h\x1b[?2026l',
  ];
  for (const f of frames) await feed(s, f);
  assert.equal(s.status, 'idle', 'a colour-only repaint must not re-arm the idle timer');
  s.release();
});

test('a repaint that changes the text still counts as activity', async () => {
  const s = new PtySession({ launch: LAUNCH });
  await feed(s, 'ready\r\n');
  s.status = 'idle';
  await feed(s, '\x1b[1;1Hworking...\x1b[K');
  assert.equal(s.status, 'busy', 'new text means the agent is doing something');
  s.release();
});

test('an exited session does not write to a dead pty', async () => {
  writes.length = 0;
  const s = new PtySession({ launch: LAUNCH });
  s._onExit(0, null);
  await feed(s, '\x1b]11;?\x1b\\');
  assert.deepEqual(writes, []);
  s.release();
});
