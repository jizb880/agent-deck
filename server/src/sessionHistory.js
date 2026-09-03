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
 *
 * Emits 'change' (sorted entries) on structural edits and 'warn' (message,
 * err) when the file could not be read or written; it never throws for I/O.
 */
export class SessionHistory extends EventEmitter {
  constructor(file, limit = SESSION_HISTORY_LIMIT) {
    super();
    this._file = file;
    this._limit = limit;
    /** @type {Map<string, object>} id -> entry */
    this._entries = new Map();
    // One shared read: concurrent first callers all wait on the same promise,
    // and `_loaded` flips only once the file's contents are in `_entries`.
    this._loadPromise = null;
    this._loaded = false;
    // A read failure other than "no file yet". We then refuse to write for the
    // rest of the process: overwriting a file we could not read is how data
    // gets lost, and we can't tell a transient EBUSY from a real problem.
    this._loadError = null;
    // Change counter vs. the counter of the last snapshot that reached disk.
    // flushSync() uses it to do nothing when there is nothing to flush.
    this._gen = 0;
    this._writtenGen = 0;
    this._writeTimer = null;
    this._writeChain = Promise.resolve();
  }

  /**
   * Read the file (once). Resolves to the number of entries loaded. Safe to
   * call eagerly at startup; every accessor calls it too.
   */
  load() {
    if (!this._loadPromise) this._loadPromise = this._doLoad();
    return this._loadPromise;
  }

  async _doLoad() {
    let raw;
    try {
      raw = await fsp.readFile(this._file, 'utf8');
    } catch (err) {
      if (err?.code !== 'ENOENT') {
        this._loadError = err;
        this.emit(
          'warn',
          `session history: cannot read ${this._file} (${err.code || err.message}); ` +
            'the file will not be overwritten this run',
          err
        );
      }
      this._loaded = true;
      return 0;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error('not a JSON array');
    } catch (err) {
      // Unreadable content (a half-written file, a hand edit gone wrong). Set
      // it aside instead of starting empty on top of it: the very next write
      // would otherwise destroy the only copy.
      const aside = `${this._file}.corrupt-${Date.now()}`;
      try {
        await fsp.rename(this._file, aside);
        this.emit(
          'warn',
          `session history: ${this._file} is unreadable (${err.message}); moved it to ${aside} and starting empty`,
          err
        );
      } catch (renameErr) {
        this._loadError = renameErr;
        this.emit(
          'warn',
          `session history: ${this._file} is unreadable and could not be moved aside ` +
            `(${renameErr.code || renameErr.message}); the file will not be overwritten this run`,
          renameErr
        );
      }
      this._loaded = true;
      return 0;
    }

    for (const e of parsed) {
      if (typeof e?.id === 'string') this._entries.set(e.id, e);
    }
    this._trim();
    this._loaded = true;
    return this._entries.size;
  }

  _sorted() {
    return [...this._entries.values()].sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0));
  }

  async list() {
    await this.load();
    return this._sorted();
  }

  async get(id) {
    await this.load();
    return this._entries.get(id) || null;
  }

  /**
   * Add or refresh a history entry. `replacesId` lets a reopened entry take
   * over the row of the conversation it continues instead of appending a
   * second one (which would push the real history off the front of the list).
   *
   * Resolves once the write has been attempted; a failed write is reported via
   * 'warn' rather than thrown, so persistence trouble never fails a launch.
   */
  async record(entry, { replacesId } = {}) {
    await this.load();
    if (replacesId) this._entries.delete(replacesId);
    this._entries.set(entry.id, { ...entry });
    this._trim();
    this._changed();
    await this._scheduleWrite(false);
    return this._entries.get(entry.id);
  }

  /** Bump an entry's recency (agent output / user interaction / exit). */
  async touch(id, lastActivity) {
    await this.load();
    const e = this._entries.get(id);
    if (!e || e.lastActivity === lastActivity) return;
    e.lastActivity = lastActivity;
    this._gen++;
    // No 'change' event: the client already holds the live roster with a
    // fresher timestamp, so re-broadcasting would only disturb the UI.
    this._scheduleWrite(true);
  }

  /** Patch a live entry (title etc.) without changing its position or id. */
  async update(id, patch) {
    await this.load();
    const e = this._entries.get(id);
    if (!e) return null;
    Object.assign(e, patch, { id });
    this._changed();
    await this._scheduleWrite(false);
    return e;
  }

  async remove(id) {
    await this.load();
    if (!this._entries.delete(id)) return false;
    this._changed();
    await this._scheduleWrite(false);
    return true;
  }

  _changed() {
    this._gen++;
    this.emit('change', this._sorted());
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
  // tmp+rename so a crash never leaves a truncated history file. The chain
  // never rejects: one ENOSPC/EPERM used to leave it rejected for good, which
  // silently dropped every later write and made every later record() throw.
  _write() {
    if (this._loadError) return this._writeChain;
    const gen = this._gen;
    const json = JSON.stringify(this._sorted(), null, 2);
    const tmp = this._file + '.tmp';
    this._writeChain = this._writeChain.then(async () => {
      try {
        await fsp.mkdir(path.dirname(this._file), { recursive: true });
        await fsp.writeFile(tmp, json);
        // flushSync() may have put a newer snapshot on disk while this one
        // was queued; renaming over it would roll the file back.
        if (gen < this._writtenGen) {
          await fsp.unlink(tmp).catch(() => {});
          return;
        }
        await fsp.rename(tmp, this._file);
        if (gen > this._writtenGen) this._writtenGen = gen;
      } catch (err) {
        this.emit(
          'warn',
          `session history: could not write ${this._file} (${err.code || err.message})`,
          err
        );
      }
    });
    return this._writeChain;
  }

  /**
   * Synchronous flush for process exit — the debounce timer won't fire.
   *
   * A no-op unless this process has loaded the file and changed something
   * since the last completed write. A process that exits before its first
   * history access (a failed listen, Ctrl-C before the browser reconnected, a
   * `--watch` restart) holds an empty map, and writing that over the real file
   * is exactly how the Recent list used to vanish.
   */
  flushSync() {
    this._flushTimer();
    if (!this._loaded || this._loadError || this._gen === this._writtenGen) return;
    // Own tmp name: an async write may still be in flight on `.tmp`.
    const tmp = this._file + '.flush.tmp';
    try {
      fs.mkdirSync(path.dirname(this._file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(this._sorted(), null, 2));
      fs.renameSync(tmp, this._file);
      this._writtenGen = this._gen;
    } catch {
      /* best effort at shutdown */
    }
  }
}

export const sessionHistory = new SessionHistory(SESSION_HISTORY_FILE);
