import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { PtySession } from './PtySession.js';
import { buildLaunch } from './launcher.js';
import { personaStore } from './personaStore.js';
import { sessionHistory } from './sessionHistory.js';
import { REAP_EXITED_AFTER_MS } from './config.js';
import { transcriptExists } from './claudeSessions.js';

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

  async create({
    personaId,
    kind,
    cwd,
    model,
    agent,
    appendSystemPrompt,
    addDirs,
    title,
    resumeSessionId,
    autoMode,
    forkSession,
    replacesHistoryId,
  }) {
    let persona = { kind: kind || 'claude' };
    let resolvedName = null;
    if (personaId) {
      const p = await personaStore.get(personaId);
      if (!p) throw new Error(`Persona not found: ${personaId}`);
      persona = p;
      resolvedName = p.name;
    }

    // The launcher stays deterministic: it never invents an id. For claude we
    // pin one here so the dashboard knows exactly which transcript a session
    // maps to and can resume it after a restart. Resuming in place (reopen from
    // Recent) keeps the target id and must NOT also pass --session-id: claude
    // rejects that pairing unless --fork-session is present. Every other
    // claude launch gets a fresh id — including the launch dialog's fork,
    // which we verified re-keys the forked transcript to the supplied id.
    let claudeSessionId = null;
    let pinnedSessionId = undefined;
    if (persona.kind === 'claude') {
      if (resumeSessionId && forkSession === false) {
        claudeSessionId = resumeSessionId;
      } else {
        claudeSessionId = crypto.randomUUID();
        pinnedSessionId = claudeSessionId;
      }
    }

    const overrides = {
      kind,
      cwd,
      model,
      agent,
      appendSystemPrompt,
      addDirs,
      resumeSessionId,
      autoMode,
      sessionId: pinnedSessionId,
      forkSession,
    };
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
    session._claudeSessionId = claudeSessionId || null;

    await sessionHistory.record(
      {
        id: session.id,
        kind: session.kind,
        title: session.title,
        personaId: session.personaId,
        personaName: session.personaName,
        cwd: session.cwd,
        model: launch.kind === 'claude' ? overrides.model || persona.model : null,
        autoMode: !!overrides.autoMode,
        claudeSessionId: claudeSessionId || null,
        createdAt: session.createdAt,
        lastActivity: session.lastActivity,
      },
      { replacesId: replacesHistoryId }
    );

    session.on('status', () => this._emitSessions());
    session.on('exit', () => {
      sessionHistory.touch(session.id, session.lastActivity);
      this._emitSessions();
      this._scheduleReap(session.id);
    });
    // touch() marks user interaction (attach/keystroke/resize). Re-broadcast
    // so clients can re-rank "recent sessions", but throttle: a burst of
    // keystrokes must not become a burst of roster frames.
    session.on('touched', () => {
      sessionHistory.touch(session.id, session.lastActivity);
      const now = Date.now();
      if (now - (this._lastTouchEmit || 0) > 500) {
        this._lastTouchEmit = now;
        this._emitSessions();
      }
    });

    this._emitSessions();
    return session;
  }

  /** Rename a session; broadcasts the updated roster so all clients sync. */
  rename(id, title) {
    const s = this.sessions.get(id);
    if (!s) return null;
    s.title = title;
    sessionHistory.update(id, { title });
    this._emitSessions();
    return s;
  }

  /** Signal a session. False if it's unknown, or the kill could not be issued. */
  kill(id, signal) {
    const s = this.sessions.get(id);
    if (!s) return false;
    return s.kill(signal);
  }

  /**
   * Remove an exited session from the roster (or force-kill then remove).
   *
   * Returns false if the process is still alive and could not be killed —
   * dropping it from the roster in that case would answer "closed" while
   * leaving an orphan running with no handle left to stop it.
   */
  remove(id) {
    const s = this.sessions.get(id);
    if (!s) return false;
    if (s.status !== 'exited' && !s.kill('SIGKILL')) return false;
    s.removeAllListeners();
    s.releaseBuffers();
    this.sessions.delete(id);
    this._emitSessions();
    return true;
  }

  /**
   * Reopen a persisted history entry — the "recent" row of a session from a
   * previous backend run. Returns { session, resumed }, or null if the entry
   * is unknown.
   *
   * A claude entry resumes its original conversation in place (no fork), which
   * is what makes the Recent list feel continuous across a restart. If the
   * transcript vanished meanwhile, we start a fresh session and report
   * resumed:false so the UI can say so. Other kinds relaunch with the stored
   * cwd/model — their CLIs have no transcript format we read, so that is the
   * best a "reopen" can mean.
   */
  async reopen(historyId) {
    const entry = await sessionHistory.get(historyId);
    if (!entry) return null;

    // If that conversation is already open and alive, just return it: the
    // frontend only needs to focus the tab. An exited zombie is removed first
    // so it can't linger in the Sessions list next to its reopened twin.
    const live = this.sessions.get(entry.id);
    if (live && live.status !== 'exited') {
      return { session: live, resumed: true };
    }
    if (live) this.remove(entry.id);

    let personaId = entry.personaId;
    if (personaId) {
      const p = await personaStore.get(personaId);
      if (!p) personaId = undefined; // persona deleted — fall back to a bare launch
    }

    // Resume the same conversation unless it's provably gone. "Unknown" is
    // treated as resumable so a Windows encoding miss doesn't cost the history
    // (the CLI would just report the bad id and the tab dies — the honest
    // failure, rather than silently starting empty).
    let resumeSessionId = undefined;
    let resumed = true;
    if (entry.kind === 'claude' && entry.claudeSessionId) {
      const exists = await transcriptExists(entry.cwd, entry.claudeSessionId);
      if (exists === false) {
        resumed = false;
      } else {
        resumeSessionId = entry.claudeSessionId;
      }
    } else {
      // No transcript id ever recorded (non-claude, or an older entry): can't
      // continue, so reopen is a fresh launch with the stored settings.
      resumed = false;
      if (!entry.cwd) resumeSessionId = undefined;
    }

    const session = await this.create({
      personaId,
      kind: entry.kind,
      cwd: entry.cwd,
      model: entry.model,
      title: entry.title,
      autoMode: entry.autoMode,
      // claude conversations continue in place; everything else starts anew.
      resumeSessionId,
      forkSession: false,
      replacesHistoryId: entry.id,
    });

    return { session, resumed };
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
