import fs from 'node:fs';
import path from 'node:path';
import { homeDir } from './platform.js';

const CODEX_DIR = path.join(homeDir(), '.codex');
const SESSION_INDEX_FILE = path.join(CODEX_DIR, 'session_index.jsonl');

// Codex >= 0.154 keeps its session records in SQLite. The `threads` table is
// the authority: one row per conversation, holding the id that `codex resume`
// accepts, plus the working directory and the recorded title.
//
// The older on-disk layout -- one rollout-*.jsonl per session under
// ~/.codex/sessions/YYYY/MM/DD/, indexed by ~/.codex/session_index.jsonl, which
// only grew when a session ended -- is still present on machines that have run
// older codex builds, and is kept as a fallback below so this keeps working
// there. On 0.154 the sessions directory receives nothing at all, which is why
// scanning it found no new session and every resume fell back to a fresh one.
const STATE_DB_GLOB = /^state_(\d+)\.sqlite$/;

/** Session id shape: UUIDv7 as codex writes it (plain hex groups). */
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Highest-numbered state database in ~/.codex, or null. Codex bumps the number
 * when it migrates the schema, so picking the highest avoids reading a stale
 * file left behind by an upgrade.
 */
function findStateDb() {
  try {
    const candidates = fs.readdirSync(CODEX_DIR)
      .map((f) => f.match(STATE_DB_GLOB))
      .filter(Boolean)
      .map((m) => ({ file: path.join(CODEX_DIR, m[0]), version: Number(m[1]) }));
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => b.version - a.version);
    return candidates[0].file;
  } catch {
    return null;
  }
}

// Cached so a poll loop is not reopening the database on every tick. The
// connection is short-lived per query instead -- see queryThreads -- because
// codex holds the file open for writing and a long-lived read handle would
// keep returning a stale snapshot.
//
// The cache is intentionally resettable: a codex upgrade replaces the active
// SQLite file (state_N.sqlite → state_N+1.sqlite). If we kept pointing at the
// old file after the upgrade, codexSessionExists() would report the session as
// resumable while the new binary would find it absent in the new database,
// causing it to start a fresh session and show the upgrade prompt again.
// resetStateDbCache() is called whenever a codex session exits so the next
// probe picks up whichever database the new binary is actually writing to.
let stateDbPath;
let stateDbResolved = false;

function stateDb() {
  if (!stateDbResolved) {
    stateDbPath = findStateDb();
    stateDbResolved = true;
  }
  return stateDbPath;
}

/**
 * Drop the cached state-database path so the next query re-probes ~/.codex
 * for the highest-numbered state_N.sqlite. Call this after a codex session
 * exits: an upgrade may have replaced the active database file, and a stale
 * path would make session-existence checks read the wrong file.
 *
 * Returns { upgraded: boolean } — true when the active database path changed
 * while the session was running (i.e. codex installed a new binary and
 * migrated its database). Callers use this to decide whether to clear the
 * stored session id: resuming the old session with a new binary re-shows the
 * upgrade prompt because the conversation context contains the upgrade UI
 * state, so starting fresh is the right behaviour after an upgrade.
 */
export function resetStateDbCache() {
  const oldPath = stateDbResolved ? stateDbPath : undefined;
  stateDbPath = undefined;
  stateDbResolved = false;
  // Re-probe immediately so the cache is warm for the next caller and so we
  // can compare old vs new in one place rather than spreading that logic.
  const newPath = findStateDb();
  stateDbPath = newPath;
  stateDbResolved = true;
  return { upgraded: oldPath != null && newPath !== oldPath };
}

/**
 * Run a query against the codex state database. Returns [] when SQLite support
 * or the database is unavailable, so callers degrade to the file-based
 * fallback rather than failing.
 *
 * node:sqlite landed in Node 22; the project supports Node >= 18, so the
 * import is attempted lazily and its absence is not an error.
 */
let sqliteModule;
let sqliteLoadFailed = false;

async function queryThreads(sql) {
  if (sqliteLoadFailed) return [];
  try {
    if (!sqliteModule) sqliteModule = await import('node:sqlite');
  } catch {
    sqliteLoadFailed = true;
    return [];
  }
  const dbPath = stateDb();
  if (!dbPath) return [];
  let db;
  try {
    db = new sqliteModule.DatabaseSync(dbPath, { readOnly: true });
    // Fail immediately on any lock contention rather than blocking the Node.js
    // event loop. The default busy_timeout is unlimited, which means a codex
    // upgrade holding an exclusive migration lock could freeze the whole server
    // (including WebSocket input forwarding) until it finishes. With timeout=0
    // we get SQLITE_BUSY right away, fall through to the catch, and return [].
    // The context poll just misses that tick; the next poll reads fine once the
    // upgrade is done.
    try { db.exec('PRAGMA busy_timeout = 0'); } catch { /* ignore */ }
    return db.prepare(sql).all();
  } catch {
    // A locked or half-migrated database is not an error worth surfacing: the
    // callers below all have a fallback path.
    return [];
  } finally {
    try {
      db?.close();
    } catch {
      /* already gone */
    }
  }
}

/** Newest-first thread rows: [{ id, cwd, title, created_at }]. */
async function listThreads(limit = 200) {
  return queryThreads(
    `SELECT id, cwd, title, created_at FROM threads
     ORDER BY created_at DESC LIMIT ${Number(limit) || 200}`
  );
}

/**
 * Path of the JSONL file codex records a conversation into, or null.
 *
 * The file holds the per-turn token accounting, which is what the context
 * readout is derived from. Older codex builds keep it under the day directory,
 * as `rollout_path` spells out; when the column is absent the same file is
 * reconstructed from the day layout so the lookup still works.
 */
export async function codexRolloutPath(sessionId) {
  if (!sessionId || typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) return null;

  const rows = await queryThreads(
    `SELECT rollout_path FROM threads WHERE id = '${sessionId.replace(/'/g, "''")}' LIMIT 1`
  );
  if (rows.length > 0 && rows[0].rollout_path) return rows[0].rollout_path;

  // Fallback: find the file by name across the day directories.
  try {
    if (!fs.existsSync(CODEX_SESSIONS_DIR)) return null;
    for (const year of fs.readdirSync(CODEX_SESSIONS_DIR).sort().reverse()) {
      const yearDir = path.join(CODEX_SESSIONS_DIR, year);
      let months;
      try {
        months = fs.readdirSync(yearDir).sort().reverse();
      } catch {
        continue;
      }
      for (const month of months) {
        const monthDir = path.join(yearDir, month);
        let days;
        try {
          days = fs.readdirSync(monthDir).sort().reverse();
        } catch {
          continue;
        }
        for (const day of days) {
          for (const f of rolloutFilesIn(path.join(monthDir, day))) {
            if (f.includes(sessionId)) return path.join(monthDir, day, f);
          }
        }
      }
    }
  } catch {
    /* unreadable directory is not an error worth surfacing */
  }
  return null;
}

// ---- fallback: the pre-0.154 on-disk rollout layout ----

const CODEX_SESSIONS_DIR = path.join(CODEX_DIR, 'sessions');
// rollout-<timestamp>-<uuid>.jsonl — the uuid is the session id, and it is the
// *last* uuid in the name, so it is matched rather than anchored to the end.
const ROLLOUT_SESSION_ID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

function sessionIdFromRollout(filename) {
  const m = filename.match(ROLLOUT_SESSION_ID_RE);
  return m ? m[1] : null;
}

function dayDir(date) {
  return path.join(
    CODEX_SESSIONS_DIR,
    String(date.getFullYear()),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  );
}

function rolloutFilesIn(dir) {
  try {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((f) => f.startsWith('rollout-') && f.endsWith('.jsonl'))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/** Latest session id recorded in session_index.jsonl, or null. */
function latestFromIndex() {
  try {
    if (!fs.existsSync(SESSION_INDEX_FILE)) return null;
    const lines = fs.readFileSync(SESSION_INDEX_FILE, 'utf8').trim().split('\n').filter(Boolean);
    if (lines.length === 0) return null;
    const entry = JSON.parse(lines[lines.length - 1]);
    return entry.id || null;
  } catch {
    return null;
  }
}

// ---- public API ----

/**
 * The session id of the most recently created codex conversation, or null.
 *
 * Used to snapshot "what existed before I spawned" so a new session can be
 * told apart from the previous one. Returns null when nothing is known yet.
 */
export async function getLatestCodexSessionId() {
  const threads = await listThreads(1);
  if (threads.length > 0 && threads[0].id) return threads[0].id;

  // Fallback: newest rollout file today or yesterday.
  for (let daysAgo = 0; daysAgo < 2; daysAgo++) {
    const files = rolloutFilesIn(dayDir(new Date(Date.now() - daysAgo * 86_400_000)));
    if (files.length > 0) {
      const id = sessionIdFromRollout(files[0]);
      if (id) return id;
    }
  }
  return latestFromIndex();
}

/**
 * Whether a recorded session still exists, i.e. whether `codex resume <id>`
 * has something to resume.
 *
 * Returns true / false when the answer is known, and true when it cannot be
 * determined — attempting a resume the CLI rejects is a visible failure the
 * user can act on, whereas silently skipping a real conversation loses their
 * history.
 */
export async function codexSessionExists(sessionId) {
  if (!sessionId || typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) return false;

  const threads = await listThreads(500);
  if (threads.length > 0) {
    return threads.some((t) => t.id === sessionId);
  }

  // No SQLite support (Node < 22) or no state database: fall back to the files.
  try {
    if (fs.existsSync(CODEX_SESSIONS_DIR)) {
      for (const year of fs.readdirSync(CODEX_SESSIONS_DIR).sort().reverse()) {
        const yearDir = path.join(CODEX_SESSIONS_DIR, year);
        try {
          if (!fs.statSync(yearDir).isDirectory()) continue;
        } catch {
          continue;
        }
        for (const month of fs.readdirSync(yearDir).sort().reverse()) {
          const monthDir = path.join(yearDir, month);
          try {
            if (!fs.statSync(monthDir).isDirectory()) continue;
          } catch {
            continue;
          }
          for (const day of fs.readdirSync(monthDir).sort().reverse()) {
            const dir = path.join(monthDir, day);
            try {
              if (!fs.statSync(dir).isDirectory()) continue;
            } catch {
              continue;
            }
            for (const f of rolloutFilesIn(dir)) {
              if (f.includes(sessionId)) return true;
            }
          }
        }
      }
    }

    if (!fs.existsSync(SESSION_INDEX_FILE)) return true; // unknown, not absent
    const content = fs.readFileSync(SESSION_INDEX_FILE, 'utf8');
    for (const line of content.trim().split('\n')) {
      if (!line.trim()) continue;
      try {
        if (JSON.parse(line).id === sessionId) return true;
      } catch {
        continue;
      }
    }
    return false;
  } catch {
    return true;
  }
}

/**
 * Resolve a directory to its canonical spelling so two names for one place
 * compare equal. macOS is the reason this matters: /tmp is a symlink to
 * /private/tmp, codex records whichever spelling it was given, and a caller
 * filtering by cwd would otherwise miss sessions it just created.
 */
function canonicalDir(dir) {
  if (!dir) return '';
  try {
    return fs.realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
}

/**
 * Every session id codex currently knows about, as a Set.
 *
 * Used to tell a *new* conversation apart from one that already existed: codex
 * records nothing at spawn, so the only way to recognise the one a given
 * session just started is to compare against what was there before.
 */
export async function listCodexSessionIds() {
  const rows = await listThreads(2000);
  const ids = new Set();
  for (const r of rows) {
    if (r.id && SESSION_ID_RE.test(r.id)) ids.add(r.id);
  }
  if (ids.size === 0) {
    // Fallback for a codex that still writes rollout files.
    for (let daysAgo = 0; daysAgo < 2; daysAgo++) {
      for (const f of rolloutFilesIn(dayDir(new Date(Date.now() - daysAgo * 86_400_000)))) {
        const id = sessionIdFromRollout(f);
        if (id) ids.add(id);
      }
    }
    const fromIndex = latestFromIndex();
    if (fromIndex) ids.add(fromIndex);
  }
  return ids;
}

/**
 * Watch for a codex conversation to appear that was not in `knownIds`, and
 * return its id, or null on timeout.
 *
 * `cwd` scopes the watch to one working directory. Without it two sessions
 * running side by side both claim whichever thread appears first — which is
 * exactly how two different projects ended up sharing one stored id, so the
 * second of them would resume the first one's conversation.
 *
 * Codex writes a thread row only once the first message is sent, so this fires
 * when the conversation actually begins rather than at launch; until then there
 * is no id to store and nothing to resume.
 */
export async function waitForNewCodexSessionIn(cwd, knownIds, timeoutMs = 15 * 60_000) {
  const startTime = Date.now();
  const want = cwd ? canonicalDir(cwd) : null;
  const skip = knownIds instanceof Set ? knownIds : new Set(knownIds || []);

  while (Date.now() - startTime < timeoutMs) {
    const rows = await listThreads(50);
    for (const r of rows) {
      if (!r.id || skip.has(r.id) || !SESSION_ID_RE.test(r.id)) continue;
      if (want && canonicalDir(r.cwd) !== want) continue;
      return r.id;
    }

    // Fallback: a codex build that still writes rollout files.
    if (rows.length === 0) {
      for (const f of rolloutFilesIn(dayDir(new Date()))) {
        const id = sessionIdFromRollout(f);
        if (id && !skip.has(id)) return id;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return null;
}

/**
 * Conversations available to resume, newest first, for a picker UI:
 * [{ sessionId, title, cwd, updatedAt }]. Empty when the record cannot be read.
 */
export async function listCodexSessions({ cwd, limit = 30 } = {}) {
  const rows = await listThreads(500);
  let entries = rows
    .filter((r) => r.id && SESSION_ID_RE.test(r.id))
    .map((r) => ({
      sessionId: r.id,
      title: r.title || '',
      cwd: r.cwd || '',
      updatedAt: Number(r.created_at) * 1000,
    }));
  if (cwd) {
    const want = canonicalDir(cwd);
    entries = entries.filter((e) => canonicalDir(e.cwd) === want);
  }
  return entries.slice(0, limit);
}

