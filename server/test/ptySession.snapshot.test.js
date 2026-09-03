// The session snapshot is the emulator's rendered buffer, not the raw byte
// stream: a TUI that repaints in place must not eat the scrollback budget,
// and the snapshot must be exact as of the moment it resolves.
//
// node-pty is faked so no child is spawned; output is fed straight in.
import assert from 'node:assert/strict';
import os from 'node:os';
import test, { mock } from 'node:test';

const child = {
  onData() {},
  onExit() {},
  write() {},
  pause() {},
  resume() {},
  resize() {},
  kill() {},
};
mock.module('node-pty', { defaultExport: { spawn: () => child }, namedExports: { spawn: () => child } });

const { PtySession } = await import('../src/PtySession.js');

const LAUNCH = {
  kind: 'terminal',
  file: '/bin/sh',
  args: [],
  cwd: os.tmpdir(),
  env: {},
  commandLine: 'sh',
  label: 'Terminal',
};

const ESC = '\x1b';
const plain = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

test('snapshot is the rendered buffer, not the redraw churn that produced it', async () => {
  const s = new PtySession({ launch: LAUNCH });
  s._onData('first prompt\r\n');
  // A TUI-style in-place repaint: 200 rounds of "cursor up, erase, redraw".
  for (let i = 0; i < 200; i++) s._onData(`status ${i}\r\n${ESC}[1A${ESC}[2K`);
  s._onData('final status\r\n');
  const snap = await s.getSnapshot();

  assert.ok(plain(snap).includes('first prompt'), 'earlier lines survive');
  assert.ok(plain(snap).includes('final status'));
  assert.ok(!plain(snap).includes('status 199'), 'overwritten frames are gone');
  // 200 repaints of ~20 bytes each would be ~4 KB raw; the rendered form is a
  // couple of lines.
  assert.ok(snap.length < 600, `snapshot should be compact, got ${snap.length} bytes`);
  s.release();
});

test('snapshot includes every chunk received before the call resolves', async () => {
  const s = new PtySession({ launch: LAUNCH });
  for (let i = 0; i < 50; i++) s._onData(`line ${i}\r\n`);
  const p = s.getSnapshot();
  // Arrives while the snapshot is pending; it was received before it resolved.
  s._onData('late line\r\n');
  const snap = await p;
  assert.ok(plain(snap).includes('line 49'));
  assert.ok(plain(snap).includes('late line'));
  s.release();
});

test('scrollback is kept as lines, up to the configured cap, and survives reflow', async () => {
  const s = new PtySession({ launch: LAUNCH });
  for (let i = 0; i < 3000; i++) s._onData(`row ${i} ${'x'.repeat(50)}\r\n`);
  let snap = await s.getSnapshot();
  assert.ok(plain(snap).includes('row 0 '), 'well beyond 1 MiB-of-raw territory, row 0 is still there');
  assert.ok(plain(snap).includes('row 2999 '));

  // Narrower than the rows: they wrap, and the snapshot follows the new width.
  s.resize(40, 20);
  snap = await s.getSnapshot();
  assert.ok(plain(snap).includes('row 2999 '));
  s.release();
});

test('a hidden cursor stays hidden across the snapshot', async () => {
  const s = new PtySession({ launch: LAUNCH });
  s._onData(`${ESC}[?25lworking\r\n`);
  assert.ok((await s.getSnapshot()).endsWith(`${ESC}[?25l`));
  s._onData(`${ESC}[?25h`);
  assert.ok(!(await s.getSnapshot()).endsWith(`${ESC}[?25l`));
  s.release();
});

test('terminal queries in the output do not end up in the snapshot', async () => {
  // The old raw replay had to strip these, or xterm.js on the client would
  // answer them into the CLI as keystrokes.
  const s = new PtySession({ launch: LAUNCH });
  s._onData(`${ESC}[c${ESC}[6n${ESC}[?2026$phello\r\n`);
  const snap = await s.getSnapshot();
  assert.ok(plain(snap).includes('hello'));
  assert.ok(!snap.includes(`${ESC}[c`));
  assert.ok(!snap.includes('6n'));
  assert.ok(!snap.includes('2026$p'));
  s.release();
});
