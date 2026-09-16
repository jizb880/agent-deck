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

/**
 * Watch for a *new* codex conversation to appear, i.e. one whose id differs
 * from `previousSessionId`. Resolves to its id, or null on timeout.
 *
 * A fresh codex writes its thread row only once the first message is sent — it
 * does not record anything at spawn and never prints its id. So this cannot
 * fire at launch; it fires once the user actually starts the conversation,
 * which is also the first moment the conversation could be resumed again. The
 * poll is deliberately long-lived for that reason.
 */
export async function waitForNewCodexSession(previousSessionId, timeoutMs = 15 * 60_000) {
  const startTime = Date.now();
  // Rollout files that already exist, so the fallback path can tell a new file
  // apart from a pre-existing one.
  const initialDir = dayDir(new Date());
  const seenBefore = new Set(rolloutFilesIn(initialDir));

  while (Date.now() - startTime < timeoutMs) {
    const threads = await listThreads(1);
    if (threads.length > 0) {
      const id = threads[0].id;
      if (id && id !== previousSessionId) return id;
    } else {
      // Fallback path for codex builds that still write rollout files.
      const dir = dayDir(new Date());
      for (const f of rolloutFilesIn(dir)) {
        if (dir === initialDir && seenBefore.has(f)) continue;
        const id = sessionIdFromRollout(f);
        if (id && id !== previousSessionId) return id;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return null;
}
