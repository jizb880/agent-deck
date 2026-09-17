// The codex session record moved into SQLite (state_<n>.sqlite, table
// `threads`) in codex 0.154. Everything that decides whether a Recent-row can
// resume -- does this id still exist, what was the last id, what can I offer to
// resume -- reads from there now.
//
// The older layout (rollout-*.jsonl under ~/.codex/sessions/YYYY/MM/DD/ plus
// session_index.jsonl) is still consulted as a fallback for machines running an
// older codex, so both paths are exercised here. A throwaway HOME keeps the
// real ~/.codex untouched.
//
// Run with: node --test server/test/
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// node:sqlite is Node >= 22 only; the project supports Node >= 18. Loaded once
// here so the tests can skip the SQLite-specific cases on older runtimes while
// still covering the file-based fallback everywhere.
let sqlite = null;
try {
  sqlite = await import('node:sqlite');
} catch {
  sqlite = null;
}

const ID_A = '01a0a9a3-8291-7292-989a-b178a5ccb427';
const ID_B = '01a0a910-d6b6-7d90-a99e-59e3c286c2e9';

/** Build a codex home; returns its path. */
function makeCodexHome({ threads = [], rolloutIds = [], indexIds = [] } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ctlapp-codex-'));
  const codexDir = path.join(home, '.codex');
  fs.mkdirSync(codexDir, { recursive: true });

  if (indexIds.length) {
    fs.writeFileSync(
      path.join(codexDir, 'session_index.jsonl'),
      indexIds.map((id) => JSON.stringify({ id, thread_name: 'x' })).join('\n') + '\n'
    );
  }

  // Rollout files live under a day directory; "now" keeps dayDir() aligned.
  // The timestamp prefix decides recency (the name sorts lexicographically),
  // so each file gets a later one than the file before it.
  if (rolloutIds.length) {
    const now = new Date();
    const dir = path.join(
      codexDir,
      'sessions',
      String(now.getFullYear()),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0')
    );
    fs.mkdirSync(dir, { recursive: true });
    rolloutIds.forEach((id, i) => {
      const hour = String(i).padStart(2, '0');
      fs.writeFileSync(path.join(dir, `rollout-2026-01-01T${hour}-00-00-${id}.jsonl`), '{}\n');
    });
  }
  return { home, codexDir };
}

/** Write a state_5.sqlite with a threads table, if node:sqlite is available. */
function writeStateDb(codexDir, threads) {
  if (!sqlite) return false;
  const dbPath = path.join(codexDir, 'state_5.sqlite');
  const db = new sqlite.DatabaseSync(dbPath);
  db.exec(
    'CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT, title TEXT, created_at INTEGER)'
  );
  const ins = db.prepare('INSERT INTO threads (id, cwd, title, created_at) VALUES (?,?,?,?)');
  for (const t of threads) ins.run(t.id, t.cwd, t.title, t.createdAt);
  db.close();
  return true;
}

/** Import codexSessions.js with $HOME pointed at `home`. */
async function withCodexHome(home, fn) {
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  try {
    // Fresh import each time: the module resolves ~/.codex once at load time.
    const mod = await import(`../src/codexSessions.js?home=${encodeURIComponent(home)}`);
    return await fn(mod);
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  }
}

test('a recorded session is reported as existing', async (t) => {
  const { home, codexDir } = makeCodexHome();
  // node:sqlite only exists on Node >= 22; the fallback paths are covered below.
  if (!writeStateDb(codexDir, [{ id: ID_A, cwd: '/tmp/x', title: 'hi', createdAt: 100 }])) {
    return t.skip('node:sqlite unavailable');
  }
  await withCodexHome(home, async (m) => {
    assert.equal(await m.codexSessionExists(ID_A), true);
  });
});

test('a session that is not in the database is reported as absent', async (t) => {
  const { home, codexDir } = makeCodexHome();
  if (!writeStateDb(codexDir, [{ id: ID_A, cwd: '/tmp/x', title: 'hi', createdAt: 100 }])) {
    return t.skip('node:sqlite unavailable');
  }
  await withCodexHome(home, async (m) => {
    // This is what decides between "resume it" and "start fresh", so a wrong
    // true would silently drop a conversation and a wrong false would keep
    // offering one that is gone.
    assert.equal(await m.codexSessionExists(ID_B), false);
    assert.equal(await m.codexSessionExists('not-a-uuid'), false);
    assert.equal(await m.codexSessionExists(''), false);
    assert.equal(await m.codexSessionExists(null), false);
  });
});

test('the newest thread is the latest session id', async (t) => {
  const { home, codexDir } = makeCodexHome();
  if (
    !writeStateDb(codexDir, [
      { id: ID_A, cwd: '/tmp/x', title: 'newer', createdAt: 200 },
      { id: ID_B, cwd: '/tmp/y', title: 'older', createdAt: 100 },
    ])
  ) {
    return t.skip('node:sqlite unavailable');
  }
  await withCodexHome(home, async (m) => {
    assert.equal(await m.getLatestCodexSessionId(), ID_A);
  });
});

test('resumable sessions list newest-first with their directory and title', async (t) => {
  const { home, codexDir } = makeCodexHome();
  if (
    !writeStateDb(codexDir, [
      { id: ID_A, cwd: '/tmp/x', title: 'newer', createdAt: 200 },
      { id: ID_B, cwd: '/tmp/y', title: 'older', createdAt: 100 },
    ])
  ) {
    return t.skip('node:sqlite unavailable');
  }
  await withCodexHome(home, async (m) => {
    const all = await m.listCodexSessions();
    assert.deepEqual(all.map((e) => e.sessionId), [ID_A, ID_B]);
    assert.equal(all[0].title, 'newer');
    assert.equal(all[0].cwd, '/tmp/x');

    const onlyX = await m.listCodexSessions({ cwd: '/tmp/x' });
    assert.deepEqual(onlyX.map((e) => e.sessionId), [ID_A]);
    assert.deepEqual(await m.listCodexSessions({ cwd: '/tmp/nope' }), []);
  });
});

test('without SQLite a rollout file proves a session exists', async () => {
  const { home } = makeCodexHome({ rolloutIds: [ID_A] });
  await withCodexHome(home, async (m) => {
    assert.equal(await m.codexSessionExists(ID_A), true);
    assert.equal(await m.getLatestCodexSessionId(), ID_A);
    // No session_index.jsonl here, so an unknown id cannot be proven absent;
    // it stays "resumable" rather than being treated as a vanished history.
    assert.equal(await m.codexSessionExists(ID_B), true);
  });
});

test('an answered index makes a missing session a definite "gone"', async () => {
  // With the index present the answer is authoritative, so an id that is
  // simply not in it must report false -- that is what turns a reopen into a
  // fresh launch instead of a failed resume.
  const { home } = makeCodexHome({ rolloutIds: [ID_A], indexIds: [ID_A] });
  await withCodexHome(home, async (m) => {
    assert.equal(await m.codexSessionExists(ID_A), true);
    assert.equal(await m.codexSessionExists(ID_B), false);
  });
});

test('without SQLite the session index is used instead', async () => {
  const { home } = makeCodexHome({ indexIds: [ID_A] });
  await withCodexHome(home, async (m) => {
    assert.equal(await m.codexSessionExists(ID_A), true);
    assert.equal(await m.codexSessionExists(ID_B), false);
    assert.equal(await m.getLatestCodexSessionId(), ID_A);
  });
});

test('one rollout file among many is identified by its trailing uuid', async () => {
  const { home } = makeCodexHome({ rolloutIds: [ID_A, ID_B] });
  await withCodexHome(home, async (m) => {
    // The uuid is the last group in the filename, not the whole stem, so a
    // naive anchored match would miss both of these.
    assert.equal(await m.codexSessionExists(ID_A), true);
    assert.equal(await m.codexSessionExists(ID_B), true);
    // Rollout names sort lexicographically, so the later timestamp wins.
    assert.equal(await m.getLatestCodexSessionId(), ID_B);
  });
});

test('nothing recorded anywhere is unknown, never a false "gone"', async () => {
  const { home } = makeCodexHome();
  await withCodexHome(home, async (m) => {
    // An empty codex home cannot prove a session is absent; reporting false
    // here is what turns a reopen into a silent fresh launch.
    assert.equal(await m.codexSessionExists(ID_A), true);
    assert.equal(await m.getLatestCodexSessionId(), null);
    assert.deepEqual(await m.listCodexSessions(), []);
  });
});

// ---- capture of a newly started conversation ----

test('a new session is recognised only in the directory it belongs to', async (t) => {
  // The bug this covers: two sessions in different directories both waited for
  // "the newest thread", so whichever started a conversation first had its id
  // claimed by both -- and reopening either one resumed the same conversation.
  const { home, codexDir } = makeCodexHome();
  if (
    !writeStateDb(codexDir, [
      { id: ID_A, cwd: '/tmp/other-project', title: 'unrelated', createdAt: 300 },
    ])
  ) {
    return t.skip('node:sqlite unavailable');
  }
  await withCodexHome(home, async (m) => {
    const known = await m.listCodexSessionIds();
    // A thread that already existed is never "the new one", and a thread in a
    // different directory is not ours to claim.
    const claimed = await m.waitForNewCodexSessionIn('/tmp/my-project', known, 1200);
    assert.equal(claimed, null, 'must not claim a session from another cwd');

    // And the id it does know about is still reported for its own directory.
    assert.equal(await m.codexSessionExists(ID_A), true);
  });
});

test('listCodexSessionIds reports every known conversation', async (t) => {
  const { home, codexDir } = makeCodexHome();
  if (
    !writeStateDb(codexDir, [
      { id: ID_A, cwd: '/tmp/x', title: 'a', createdAt: 200 },
      { id: ID_B, cwd: '/tmp/y', title: 'b', createdAt: 100 },
    ])
  ) {
    return t.skip('node:sqlite unavailable');
  }
  await withCodexHome(home, async (m) => {
    const ids = await m.listCodexSessionIds();
    assert.equal(ids.has(ID_A), true);
    assert.equal(ids.has(ID_B), true);
    // An id that is not in the record must not be treated as pre-existing.
    assert.equal(ids.has('11111111-1111-1111-1111-111111111111'), false);
  });
});
