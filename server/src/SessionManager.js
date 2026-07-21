import { EventEmitter } from 'node:events';
import { PtySession } from './PtySession.js';
import { buildLaunch } from './launcher.js';
import { personaStore } from './personaStore.js';
import { REAP_EXITED_AFTER_MS } from './config.js';

/**
 * Registry of all live PTY sessions. Emits 'sessions' whenever the roster or a
 * session's status changes so the WS bridge can broadcast a fresh list.
 */
export class SessionManager extends EventEmitter {
  constructor() {
    super();
    /** @type {Map<string, PtySession>} */
    this.sessions = new Map();
  }

  list() {
    return [...this.sessions.values()].map((s) => s.toJSON());
  }

  get(id) {
    return this.sessions.get(id) || null;
  }

  async create({ personaId, kind, cwd, model, agent, appendSystemPrompt, addDirs, title }) {
    let persona = { kind: kind || 'claude' };
    let resolvedName = null;
    if (personaId) {
      const p = await personaStore.get(personaId);
      if (!p) throw new Error(`Persona not found: ${personaId}`);
      persona = p;
      resolvedName = p.name;
    }

    const overrides = { kind, cwd, model, agent, appendSystemPrompt, addDirs };
    // Drop undefined so persona defaults win.
    for (const k of Object.keys(overrides)) {
      if (overrides[k] === undefined || overrides[k] === '') delete overrides[k];
    }

    const launch = buildLaunch(persona, overrides);
    const session = new PtySession({
      launch,
      personaId: personaId || null,
      personaName: resolvedName,
      title,
    });

    this.sessions.set(session.id, session);

    session.on('status', () => this._emitSessions());
    session.on('exit', () => {
      this._emitSessions();
      this._scheduleReap(session.id);
    });

    this._emitSessions();
    return session;
  }

  kill(id, signal) {
    const s = this.sessions.get(id);
    if (!s) return false;
    s.kill(signal);
    return true;
  }

  /** Remove an exited session from the roster (or force-kill then remove). */
  remove(id) {
    const s = this.sessions.get(id);
    if (!s) return false;
    if (s.status !== 'exited') s.kill('SIGKILL');
    s.removeAllListeners();
    s.releaseBuffers();
    this.sessions.delete(id);
    this._emitSessions();
    return true;
  }

  // Auto-remove an exited session after a grace period so its scrollback
  // (~1 MiB) doesn't pin memory forever under session churn. The grace window
  // lets a client still reattach to read the final output / exit code.
  _scheduleReap(id) {
    const t = setTimeout(() => {
      const s = this.sessions.get(id);
      if (s && s.status === 'exited') this.remove(id);
    }, REAP_EXITED_AFTER_MS);
    if (t.unref) t.unref();
  }

  _emitSessions() {
    this.emit('sessions', this.list());
  }
}

export const sessionManager = new SessionManager();
