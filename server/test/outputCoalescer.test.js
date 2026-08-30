// The coalescer lives in web/src (it wraps xterm.write in the browser), but it
// is plain timer-based ESM with no DOM dependency, and this is the repo's only
// node --test harness — so it is exercised from here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OutputCoalescer } from '../../web/src/outputCoalescer.js';

const BSU = '\x1b[?2026h';
const ESU = '\x1b[?2026l';

const tick = (ms) => new Promise((r) => setTimeout(r, ms));

function collect(opts) {
  const writes = [];
  const c = new OutputCoalescer((d) => writes.push(d), opts);
  return { c, writes };
}

test('plain output is batched, not dropped', async () => {
  const { c, writes } = collect({ batchMs: 5 });
  c.push('hello ');
  c.push('world');
  assert.equal(writes.length, 0); // held for the batch window
  await tick(20);
  assert.deepEqual(writes, ['hello world']);
  c.dispose();
});

test('a BSU..ESU frame is written atomically, markers preserved', async () => {
  const { c, writes } = collect({ batchMs: 5 });
  c.push(BSU + 'part1');
  c.push('part2');
  await tick(20);
  assert.equal(writes.length, 0); // still inside the sync frame
  c.push('part3' + ESU);
  assert.deepEqual(writes, [BSU + 'part1part2part3' + ESU]);
  c.dispose();
});

test('markers split across chunk boundaries are still honored', async () => {
  const { c, writes } = collect({ batchMs: 5 });
  c.push('a' + BSU.slice(0, 4)); // "a" + partial begin marker
  c.push(BSU.slice(4) + 'framed');
  await tick(20);
  assert.equal(writes.length, 0); // sync began despite the split marker
  c.push(ESU.slice(0, 3));
  c.push(ESU.slice(3) + 'after');
  await tick(20);
  assert.equal(writes.join(''), 'a' + BSU + 'framed' + ESU + 'after');
  c.dispose();
});

test('a never-closed frame is released by the sync timeout', async () => {
  const { c, writes } = collect({ batchMs: 5, syncTimeoutMs: 30 });
  c.push(BSU + 'stuck');
  await tick(15);
  assert.equal(writes.length, 0);
  await tick(40);
  assert.deepEqual(writes, [BSU + 'stuck']);
  // Stream keeps flowing normally afterwards.
  c.push('later');
  await tick(20);
  assert.deepEqual(writes, [BSU + 'stuck', 'later']);
  c.dispose();
});

test('oversized buffers force-flush even mid-frame', async () => {
  const { c, writes } = collect({ batchMs: 5, maxBufferedBytes: 100 });
  c.push(BSU + 'x'.repeat(200));
  assert.equal(writes.length, 1); // released immediately, not buffered
  assert.ok(writes[0].includes('x'.repeat(200)));
  c.dispose();
});

test('back-to-back frames each flush on their end marker', async () => {
  const { c, writes } = collect({ batchMs: 5 });
  c.push(BSU + 'one' + ESU + BSU + 'two' + ESU);
  assert.equal(writes.length, 1);
  assert.equal(writes[0], BSU + 'one' + ESU + BSU + 'two' + ESU);
  c.dispose();
});

test('reset drops held state', async () => {
  const { c, writes } = collect({ batchMs: 5 });
  c.push(BSU + 'doomed');
  c.reset();
  await tick(20);
  assert.equal(writes.length, 0);
  c.push('fresh');
  await tick(20);
  assert.deepEqual(writes, ['fresh']);
  c.dispose();
});
