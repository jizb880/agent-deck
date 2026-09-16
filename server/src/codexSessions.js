import fs from 'node:fs';
import path from 'node:path';
import { homeDir } from './platform.js';

const CODEX_DIR = path.join(homeDir(), '.codex');
const SESSION_INDEX_FILE = path.join(CODEX_DIR, 'session_index.jsonl');
// Codex writes one rollout-*.jsonl file per session here, created at session
// start — unlike session_index.jsonl which is only written at session end.
const CODEX_SESSIONS_DIR = path.join(CODEX_DIR, 'sessions');

// Rollout files are named: rollout-TIMESTAMP-<uuid>.jsonl
// The UUID at the end is the session ID.
const ROLLOUT_SESSION_ID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/** Extract session ID from a rollout filename, or null if not parseable. */
function sessionIdFromRollout(filename) {
  const m = filename.match(ROLLOUT_SESSION_ID_RE);
  return m ? m[1] : null;
}

/** Return the day-level sessions directory for a given Date. */
function dayDir(date) {
  return path.join(
    CODEX_SESSIONS_DIR,
    String(date.getFullYear()),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  );
}

/** List rollout filenames in a day directory, newest-first (name is sortable). */
function rolloutFilesIn(dir) {
  try {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter(f => f.startsWith('rollout-') && f.endsWith('.jsonl'))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/**
 * Check if a codex session exists.
 * Checks rollout files first (present for both live and completed sessions),
 * then falls back to session_index.jsonl (only written at session end).
 * Returns true if found, false if definitely absent, true if unreadable
 * (safer to attempt resume than to silently skip it).
 */
export function codexSessionExists(sessionId) {
  if (!sessionId || typeof sessionId !== 'string') return false;

  try {
    // Fast scan: look in rollout dirs for the past 90 days.
    // Rollout files contain the session UUID in their name, so a substring
    // match on the directory listing is enough — no need to parse contents.
    if (fs.existsSync(CODEX_SESSIONS_DIR)) {
      const years = fs.readdirSync(CODEX_SESSIONS_DIR).sort().reverse();
      outer: for (const year of years) {
        const yearDir = path.join(CODEX_SESSIONS_DIR, year);
        try { if (!fs.statSync(yearDir).isDirectory()) continue; } catch { continue; }
        const months = fs.readdirSync(yearDir).sort().reverse();
        for (const month of months) {
          const monthDir = path.join(yearDir, month);
          try { if (!fs.statSync(monthDir).isDirectory()) continue; } catch { continue; }
          const days = fs.readdirSync(monthDir).sort().reverse();
          for (const day of days) {
            const dir = path.join(monthDir, day);
            try { if (!fs.statSync(dir).isDirectory()) continue; } catch { continue; }
            for (const f of rolloutFilesIn(dir)) {
              if (f.includes(sessionId)) return true;
            }
          }
        }
        // Stop after first (most recent) year that has any content
        if (years.indexOf(year) > 2) break outer;
      }
    }

    // Fallback: session_index.jsonl (only present after a session completes)
    if (!fs.existsSync(SESSION_INDEX_FILE)) return false;
    const content = fs.readFileSync(SESSION_INDEX_FILE, 'utf8');
    for (const line of content.trim().split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.id === sessionId) return true;
      } catch { continue; }
    }
    return false;
  } catch {
    // Unreadable — optimistically try to resume rather than silently drop it.
    return true;
  }
}

/**
 * Return the session ID of the most recently created rollout file (i.e. the
 * session Codex is currently running or last ran).  Checks today then
 * yesterday so a session that started just before midnight is still found.
 * Falls back to session_index.jsonl if no rollout files exist yet.
 */
export function getLatestCodexSessionId() {
  for (let daysAgo = 0; daysAgo < 2; daysAgo++) {
    const dir = dayDir(new Date(Date.now() - daysAgo * 86_400_000));
    const files = rolloutFilesIn(dir);
    if (files.length > 0) {
      const id = sessionIdFromRollout(files[0]);
      if (id) return id;
    }
  }

  // Fallback: session_index.jsonl (last entry is chronologically most recent)
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

/**
 * Wait for a new codex session to appear by watching for a new rollout file.
 * Codex creates the rollout file immediately at session startup — unlike
 * session_index.jsonl which is only written at session end — so this reliably
 * captures the session ID within a second or two of spawn.
 *
 * Snapshots the rollout files that already exist at call time so it can
 * detect the first new file that appears after the spawn.
 *
 * @param {string|null} previousSessionId - Last known session ID (kept for
 *   the fallback path but no longer the primary detection mechanism)
 * @param {number} timeoutMs - How long to poll before giving up (default 10 s)
 */
export async function waitForNewCodexSession(previousSessionId, timeoutMs = 10_000) {
  const startTime = Date.now();

  // Snapshot the rollout files that exist right now (before the new session
  // has had a chance to write anything).
  const initialDir = dayDir(new Date());
  const seenBefore = new Set(rolloutFilesIn(initialDir));

  while (Date.now() - startTime < timeoutMs) {
    // The date may have rolled over; recompute each iteration.
    const dir = dayDir(new Date());
    const current = rolloutFilesIn(dir);

    for (const f of current) {
      // A file that wasn't in the initial snapshot is new.
      if (dir === initialDir && seenBefore.has(f)) continue;
      const id = sessionIdFromRollout(f);
      if (id && id !== previousSessionId) return id;
    }

    await new Promise(resolve => setTimeout(resolve, 200));
  }

  return null;
}
