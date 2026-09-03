// Persisted session history: the store behind the sidebar's "Recent" list
// across backend restarts. Exercised against a temp file so nothing touches
// the real data/ directory.
//
// Run with: node --test server/test/
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { SessionHistory } from '../src/sessionHistory.js';

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctlapp-hist-'));
  return path.join(dir, 'session-history.json');
}

const entry = (id, lastActivity, extra = {}) => ({
  id,
  kind: 'claude',
  title: `t-${id}`,
  personaId: null,
  personaName: null,
  cwd: '/tmp',
  model: null,
  autoMode: false,
  claudeSessionId: null,
  createdAt: lastActivity,
  lastActivity,
  ...extra,
});

test('starts empty when the file does not exist, and does not create it on read', async () => {
  const file = tmpFile();
  const h = new SessionHistory(file);
  assert.deepEqual(await h.list(), []);
  assert.ok(!fs.existsSync(file), 'list() must not create the file');
});

test('record() persists immediately and list() is newest-first', async () => {
  const file = tmpFile();
  const h = new SessionHistory(file);
  await h.record(entry('a', 100));
  await h.record(entry('b', 300));
  await h.record(entry('c', 200));

  assert.deepEqual((await h.list()).map((e) => e.id), ['b', 'c', 'a']);

  // A fresh instance reading the same file sees the same order.
  const again = new SessionHistory(file);
  assert.deepEqual((await again.list()).map((e) => e.id), ['b', 'c', 'a']);
});

test('record() with replacesId swaps the old row for the new one', async () => {
  const h = new SessionHistory(tmpFile());
  await h.record(entry('old', 100));
  await h.record(entry('other', 50));
  await h.record(entry('new', 200), { replacesId: 'old' });

  const ids = (await h.list()).map((e) => e.id);
  assert.deepEqual(ids, ['new', 'other']);
  assert.equal(await h.get('old'), null);
});

test('trims to the limit, dropping the least recent entries', async () => {
  const h = new SessionHistory(tmpFile(), 3);
  for (const [id, t] of [['a', 1], ['b', 2], ['c', 3], ['d', 4], ['e', 5]]) {
    await h.record(entry(id, t));
  }
  assert.deepEqual((await h.list()).map((e) => e.id), ['e', 'd', 'c']);
});

test('touch() bumps recency; flushSync() writes it without waiting on the debounce', async () => {
  const file = tmpFile();
  const h = new SessionHistory(file);
  await h.record(entry('a', 100));
  await h.record(entry('b', 200));

  await h.touch('a', 999);
  // Debounced: the file still has the old value right now.
  const before = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(before.find((e) => e.id === 'a').lastActivity, 100);

  h.flushSync();
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(after.map((e) => e.id), ['a', 'b']);
  assert.equal(after[0].lastActivity, 999);
});

test('touch() on an unknown id is a no-op', async () => {
  const h = new SessionHistory(tmpFile());
  await h.record(entry('a', 100));
  await h.touch('nope', 5);
  assert.deepEqual((await h.list()).map((e) => e.id), ['a']);
});

test('update() patches in place and keeps the id', async () => {
  const h = new SessionHistory(tmpFile());
  await h.record(entry('a', 100));
  const out = await h.update('a', { title: 'renamed', id: 'evil' });
  assert.equal(out.id, 'a');
  assert.equal(out.title, 'renamed');
  assert.equal(await h.update('missing', { title: 'x' }), null);
});

test('remove() reports whether anything was deleted', async () => {
  const file = tmpFile();
  const h = new SessionHistory(file);
  await h.record(entry('a', 100));
  assert.equal(await h.remove('a'), true);
  assert.equal(await h.remove('a'), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), []);
});

test('an unreadable file is set aside, not overwritten: the next record() starts a fresh file', async () => {
  const file = tmpFile();
  fs.writeFileSync(file, '{not json');
  const h = new SessionHistory(file);
  const warnings = [];
  h.on('warn', (msg) => warnings.push(msg));
  assert.deepEqual(await h.list(), []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /unreadable/);

  const aside = fs.readdirSync(path.dirname(file)).filter((n) => n.includes('.corrupt-'));
  assert.equal(aside.length, 1, 'the bad file is kept under a .corrupt-<ts> name');
  assert.equal(fs.readFileSync(path.join(path.dirname(file), aside[0]), 'utf8'), '{not json');

  await h.record(entry('a', 1));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).map((e) => e.id), ['a']);
});

test('a truncated file (mid-write crash) is set aside too, and a non-array is treated the same', async () => {
  for (const bad of ['[{"id":"a","lastActivity":1},{"id":"b"', '{"id":"a"}']) {
    const file = tmpFile();
    fs.writeFileSync(file, bad);
    const h = new SessionHistory(file);
    assert.deepEqual(await h.list(), []);
    assert.ok(!fs.existsSync(file), 'the unreadable file no longer sits at the live path');
    assert.equal(fs.readdirSync(path.dirname(file)).filter((n) => n.includes('.corrupt-')).length, 1);
  }
});

test('flushSync() before anything loaded the file leaves it untouched', () => {
  // The regression: a backend that exited before its first history access
  // (Ctrl-C before the browser reconnected, a failed listen on a busy port,
  // a --watch restart) wrote its empty map over the real history.
  const file = tmpFile();
  const seeded = JSON.stringify([entry('a', 1), entry('b', 2)]);
  fs.writeFileSync(file, seeded);
  const h = new SessionHistory(file);
  h.flushSync();
  assert.equal(fs.readFileSync(file, 'utf8'), seeded);
  assert.ok(!fs.existsSync(file + '.flush.tmp'));
});

test('flushSync() after a load with no changes is a no-op', async () => {
  const file = tmpFile();
  // Compact JSON: a write would pretty-print it, so byte-equality proves no write.
  const seeded = JSON.stringify([entry('a', 1)]);
  fs.writeFileSync(file, seeded);
  const h = new SessionHistory(file);
  assert.equal(await h.load(), 1);
  h.flushSync();
  assert.equal(fs.readFileSync(file, 'utf8'), seeded);
});

test('flushSync() during an in-flight first read does not write the empty map', async () => {
  const file = tmpFile();
  const seeded = JSON.stringify([entry('a', 1)]);
  fs.writeFileSync(file, seeded);
  const h = new SessionHistory(file);
  const loading = h.load(); // read in flight
  h.flushSync();
  assert.equal(fs.readFileSync(file, 'utf8'), seeded);
  assert.equal(await loading, 1);
});

test('concurrent first callers all see the loaded file', async () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify([entry('old-1', 1), entry('old-2', 2)]));
  const h = new SessionHistory(file);
  const [a, b] = await Promise.all([h.list(), h.list()]);
  assert.deepEqual(a.map((e) => e.id), ['old-2', 'old-1']);
  assert.deepEqual(b.map((e) => e.id), ['old-2', 'old-1']);

  // A record() racing the first read must not write a file holding only itself.
  const h2 = new SessionHistory(file);
  await Promise.all([h2.list(), h2.record(entry('new', 3))]);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).map((e) => e.id), ['new', 'old-2', 'old-1']);
});

test('a failed write is reported, does not reject, and does not poison later writes', async () => {
  const file = tmpFile();
  // A directory squatting on the tmp path makes writeFile fail with EISDIR;
  // the read side is a normal first run (ENOENT).
  fs.mkdirSync(file + '.tmp');
  const h = new SessionHistory(file);
  const warnings = [];
  h.on('warn', (msg) => warnings.push(msg));

  await h.record(entry('a', 1)); // resolves despite the failure
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /could not write/);
  assert.ok(!fs.existsSync(file));
  assert.deepEqual((await h.list()).map((e) => e.id), ['a'], 'memory keeps the entry');

  fs.rmdirSync(file + '.tmp'); // the cause goes away…
  await h.record(entry('b', 2)); // …and the next write succeeds with both entries
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).map((e) => e.id), ['b', 'a']);
  assert.equal(warnings.length, 1);
});

test(
  'a file that cannot be read (permissions) is never overwritten',
  { skip: process.platform === 'win32' || process.getuid?.() === 0 },
  async () => {
    const file = tmpFile();
    const seeded = JSON.stringify([entry('a', 1)]);
    fs.writeFileSync(file, seeded, { mode: 0o000 });
    const h = new SessionHistory(file);
    const warnings = [];
    h.on('warn', (msg) => warnings.push(msg));
    assert.deepEqual(await h.list(), []);
    assert.match(warnings[0], /cannot read/);

    await h.record(entry('b', 2));
    h.flushSync();
    fs.chmodSync(file, 0o600);
    assert.equal(fs.readFileSync(file, 'utf8'), seeded);
  }
);

test('touch() with an unchanged timestamp schedules nothing', async () => {
  const h = new SessionHistory(tmpFile());
  await h.record(entry('a', 100));
  await h.touch('a', 100);
  assert.equal(h._writeTimer, null);
});

test('emits change on structural edits but not on touch', async () => {
  const h = new SessionHistory(tmpFile());
  let changes = 0;
  h.on('change', () => changes++);
  await h.record(entry('a', 1)); // 1
  await h.touch('a', 2); // no
  await h.update('a', { title: 'x' }); // 2
  await h.remove('a'); // 3
  assert.equal(changes, 3);
});

test('change carries the sorted list as its payload', async () => {
  // The WS bridge broadcasts the payload verbatim as {type:'history',
  // entries}. An argument-less emit once shipped a frame with entries
  // undefined, and every client wiped its Recent list on the next change.
  const h = new SessionHistory(tmpFile());
  let last;
  h.on('change', (entries) => (last = entries));
  await h.record(entry('a', 100));
  await h.record(entry('b', 300));
  assert.ok(Array.isArray(last));
  assert.deepEqual(last.map((e) => e.id), ['b', 'a']);
  await h.remove('b');
  assert.deepEqual(last.map((e) => e.id), ['a']);
});
