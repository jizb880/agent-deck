import fs from 'node:fs';
import path from 'node:path';
import { homeDir } from './platform.js';

const CODEX_DIR = path.join(homeDir(), '.codex');
const SESSION_INDEX_FILE = path.join(CODEX_DIR, 'session_index.jsonl');

/**
 * Check if a codex session exists by reading session_index.jsonl.
 * Returns true if found, false if not found or file doesn't exist.
 */
export function codexSessionExists(sessionId) {
  if (!sessionId || typeof sessionId !== 'string') return false;

  try {
    if (!fs.existsSync(SESSION_INDEX_FILE)) return false;

    const content = fs.readFileSync(SESSION_INDEX_FILE, 'utf8');
    const lines = content.trim().split('\n');

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.id === sessionId) return true;
      } catch (err) {
        // Skip malformed lines
        continue;
      }
    }

    return false;
  } catch (err) {
    // If we can't read the file, treat as "unknown" — safer to try resuming
    return true;
  }
}

/**
 * Get the most recent codex session ID from session_index.jsonl.
 * Used to track which session a newly spawned codex belongs to.
 */
export function getLatestCodexSessionId() {
  try {
    if (!fs.existsSync(SESSION_INDEX_FILE)) return null;

    const content = fs.readFileSync(SESSION_INDEX_FILE, 'utf8');
    const lines = content.trim().split('\n').filter(l => l.trim());

    if (lines.length === 0) return null;

    // Last line is the most recent session
    const lastLine = lines[lines.length - 1];
    const entry = JSON.parse(lastLine);
    return entry.id || null;
  } catch (err) {
    return null;
  }
}

/**
 * Wait for a new codex session to appear in session_index.jsonl.
 * Returns the new session ID when detected, or null after timeout.
 *
 * @param {string|null} previousSessionId - The last known session ID before spawn
 * @param {number} timeoutMs - How long to wait (default 5000ms)
 */
export async function waitForNewCodexSession(previousSessionId, timeoutMs = 5000) {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const latestId = getLatestCodexSessionId();

    // If we found a new session ID that's different from the previous one
    if (latestId && latestId !== previousSessionId) {
      return latestId;
    }

    // Wait 100ms before checking again
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  return null;
}
