import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { SESSION_HISTORY_LIMIT, SESSION_HISTORY_FILE } from './config.js';

/**
 * Persistent record of every session this dashboard has launched, so the
 * sidebar's "Recent" list survives a backend restart. The live roster only
 * knows about sessions created during this process lifetime; this store is the
 * source of truth across restarts.
 *
 * Each entry is one *conversation* as the user sees it, keyed by `id` — the id
 * of the session that most recently carried it. Reopening a closed entry
 * replaces that entry in place (see SessionManager.reopen), so a conversation
 * never splits into two rows just because the backend restarted.
 */
export class SessionHistory extends EventEmitter {
  constructor(file, limit = SESSION_HISTORY_LIMIT) {
    super();
    this._file = file;
    this._limit = limit;
    /** @type {Map<string, object>} id -> entry */
    this._entries = new Map();
    this._loaded = false;
    this._writeTimer = null;
    this._writeChain = Promise.resolve();
  }

  async _load() {
    if (this._loaded) return;
    this._loaded = true;
    let parsed = null;
    try {
      const raw = await fsp.readFile(this._file, 'utf8');
      parsed = JSON.parse(raw);
    } catch {
      // Missing or corrupt file (mid-write crash, first run) — start empty
      // rather than failing every read. The next record() rewrites the file.
      return;
    }
    if (!Array.isArray(parsed)) return;
    for (const e of parsed) {
      if (typeof e?.id === 'string') this._entries.set(e.id, e);
    }
    this._trim();
  }

  _sorted() {
    return [...this._entries.values()].sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0));
  }

  async list() {
    await this._load();
    return this._sorted();
  }

  async get(id) {
    await this._load();
    return this._entries.get(id) || null;
  }

  /**
   * Add or refresh a history entry. `replacesId` lets a reopened entry take
   * over the row of the conversation it continues instead of appending a
   * second one (which would push the real history off the front of the list).
   */
  async record(entry, { replacesId } = {}) {
    await this._load();
    if (replacesId) this._entries.delete(replacesId);
    this._entries.set(entry.id, { ...entry });
    this._trim();
    this.emit('change', this._sorted());
    await this._scheduleWrite(false);
    return this._entries.get(entry.id);
  }

  /** Bump an entry's recency (agent output / user interaction / exit). */
  async touch(id, lastActivity) {
    await this._load();
    const e = this._entries.get(id);
    if (!e) return;
    e.lastActivity = lastActivity;
    // No 'change' event: the client already holds the live roster with a
    // fresher timestamp, so re-broadcasting would only disturb the UI.
    this._scheduleWrite(true);
  }

  /** Patch a live entry (title etc.) without changing its position or id. */
  async update(id, patch) {
    await this._load();
    const e = this._entries.get(id);
    if (!e) return null;
    Object.assign(e, patch, { id });
    this.emit('change', this._sorted());
    await this._scheduleWrite(false);
    return e;
  }

  async remove(id) {
    await this._load();
    if (!this._entries.delete(id)) return false;
    this.emit('change', this._sorted());
    await this._scheduleWrite(false);
    return true;
  }

  _trim() {
    while (this._entries.size > this._limit) {
      // Delete the oldest (lowest lastActivity), keeping the newest tail.
      let oldest = null;
      let oldestT = Infinity;
      for (const e of this._entries.values()) {
        const t = e.lastActivity || 0;
        if (t < oldestT) {
          oldestT = t;
          oldest = e.id;
        }
      }
      if (oldest === null) break;
      this._entries.delete(oldest);
    }
  }

  /**
   * Debounce the frequent touch() writes (a burst of keystrokes is a burst of
   * lastActivity updates) into one write; structural changes write immediately.
   */
  _scheduleWrite(defer) {
    if (defer) {
      if (this._writeTimer) return this._writeChain;
      this._writeTimer = setTimeout(() => {
        this._writeTimer = null;
        this._write();
      }, 2000);
      if (this._writeTimer.unref) this._writeTimer.unref();
      return this._writeChain;
    }
    this._flushTimer();
    return this._write();
  }

  _flushTimer() {
    if (this._writeTimer) {
      clearTimeout(this._writeTimer);
      this._writeTimer = null;
    }
  }

  // Serialize writes (mirrors personaStore) and write atomically via
  // tmp+rename so a crash never leaves a truncated history file.
  _write() {
    const json = JSON.stringify(this._sorted(), null, 2);
    const tmp = this._file + '.tmp';
    this._writeChain = this._writeChain.then(async () => {
      await fsp.mkdir(path.dirname(this._file), { recursive: true });
      await fsp.writeFile(tmp, json);
      await fsp.rename(tmp, this._file);
    });
    return this._writeChain;
  }

  /** Synchronous flush for process exit — the debounce timer won't fire. */
  flushSync() {
    this._flushTimer();
    try {
      fs.mkdirSync(path.dirname(this._file), { recursive: true });
      fs.writeFileSync(this._file, JSON.stringify(this._sorted(), null, 2));
    } catch {
      /* best effort at shutdown */
    }
  }
}

export const sessionHistory = new SessionHistory(SESSION_HISTORY_FILE);
