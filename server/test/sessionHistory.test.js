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

test('a corrupt file reads as empty and is overwritten by the next record()', async () => {
  const file = tmpFile();
  fs.writeFileSync(file, '{not json');
  const h = new SessionHistory(file);
  assert.deepEqual(await h.list(), []);
  await h.record(entry('a', 1));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).map((e) => e.id), ['a']);
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
