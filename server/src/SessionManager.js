import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { PtySession } from './PtySession.js';
import { buildLaunch } from './launcher.js';
import { personaStore } from './personaStore.js';
import { sessionHistory } from './sessionHistory.js';
import { CLI_KINDS, REAP_EXITED_AFTER_MS, CONTEXT_POLL_MS } from './config.js';
import { transcriptExists } from './claudeSessions.js';
import { codexSessionExists, listCodexSessionIds, waitForNewCodexSessionIn, resetStateDbCache } from './codexSessions.js';
import { contextUsageFor } from './contextUsage.js';

/**
 * Registry of all live PTY sessions. Emits 'sessions' whenever the roster or a
 * session's status changes so the WS bridge can broadcast a fresh list.
 */
export class SessionManager extends EventEmitter {
  constructor() {
    super();
    /** @type {Map<string, PtySession>} */
    this.sessions = new Map();
    // Shared context-occupancy poller; started lazily on the first Claude
    // session and stopped when the last one goes away.
    this._contextTimer = null;
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
    let codexSessionId = null;
    let pinnedSessionId = undefined;
    if (persona.kind === 'claude') {
      if (resumeSessionId && forkSession === false) {
        claudeSessionId = resumeSessionId;
      } else {
        claudeSessionId = crypto.randomUUID();
        pinnedSessionId = claudeSessionId;
      }
    } else if (persona.kind === 'codex') {
      // For codex, we track the session ID but don't generate it upfront.
      // Codex creates its own session ID internally. When resuming, we use
      // the stored ID from a previous session. If no resume ID, codex will
      // create a new session and we'll capture its ID later.
      if (resumeSessionId) {
        codexSessionId = resumeSessionId;
      }
    }

    const overrides = {
      kind,
      cwd,
      model,
      agent,
      appendSystemPrompt,
      addDirs,
      resumeSessionId: codexSessionId || resumeSessionId,
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
    session.codexSessionId = codexSessionId || null;

    // Wire the session up before the awaited history write below: if that
    // write is slow or fails, the child is already running and must not sit
    // in the roster with no listeners.
    session.on('status', () => this._emitSessions());
    session.on('exit', () => {
      sessionHistory.touch(session.id, session.lastActivity);
      // A codex upgrade replaces the active SQLite database file while the
      // session was running. Drop the cached db path so the next existence
      // check re-probes ~/.codex for the highest-numbered state_N.sqlite —
      // otherwise we keep querying the pre-upgrade file, find the session
      // there, try to resume it with the new binary, and the new binary
      // opens the new database, finds nothing, and shows the upgrade prompt
      // again as if the session never existed.
      if (session.kind === 'codex') resetStateDbCache();
      this._emitSessions();
      this._scheduleReap(session.id);
    });
    // Agent output is recency too (touch() is debounced on the history side),
    // otherwise an agent that worked unattended for an hour ranks by the last
    // keystroke after a restart.
    session.on('data', () => sessionHistory.touch(session.id, session.lastActivity));
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

    await sessionHistory.record(
      {
        id: session.id,
        kind: session.kind,
        title: session.title,
        personaId: session.personaId,
        personaName: session.personaName,
        cwd: session.cwd,
        // Store the model the launch really used, for any CLI that takes one,
        // so a reopen relaunches with it rather than the CLI's default.
        model: CLI_KINDS[launch.kind]?.modelFlag ? overrides.model || persona.model || null : null,
        autoMode: !!overrides.autoMode,
        claudeSessionId: claudeSessionId || null,
        codexSessionId: codexSessionId || null,
        createdAt: session.createdAt,
        lastActivity: session.lastActivity,
      },
      { replacesId: replacesHistoryId }
    );

    // Capture the id of a freshly started codex conversation, so reopening it
    // from the Recent list resumes it instead of starting over.
    //
    // Codex records nothing at spawn and never prints its id: the thread row
    // appears only once the first message is sent. So this watches in the
    // background rather than waiting a fixed moment after launch, and fires
    // whenever the conversation actually begins. Until then there is nothing to
    // resume, and a session the user never sent anything to has no id to store.
    //
    // Scoped by cwd and by the ids that already existed. Both matter: a
    // parallel session in another directory writes its row at the same time,
    // and taking "whatever is newest" handed one session the other's id -- so
    // reopening either one resumed the same wrong conversation.
    if (session.kind === 'codex' && !codexSessionId) {
      listCodexSessionIds()
        .then((known) =>
          waitForNewCodexSessionIn(session.cwd, known).then((newSessionId) => [newSessionId, known])
        )
        .then(async ([newSessionId]) => {
          // A session that exited and left the roster has no row left to
          // update, and no reason to keep holding an id for.
          if (!newSessionId || this.sessions.get(session.id) !== session) return;
          await sessionHistory.update(session.id, { codexSessionId: newSessionId });
          session.codexSessionId = newSessionId;
          // The poll only tracks sessions with an id to read, and this session
          // did not have one when it was created, so start it now.
          this._ensureContextPoll();
          // Re-broadcast so clients pick up the id with the rest of the roster.
          this._emitSessions();
        })
        .catch(() => {
          // Losing the id costs a resume, not the session; stay silent.
        });
    }

    // Start tracking occupancy as soon as there is a session file to read.
    // A Claude session carries its transcript id from the start; a codex one
    // that was just *resumed* already has an id, even though a fresh codex
    // session does not and will be picked up later when its id is captured.
    if (this._contextSessionId(session)) {
      this._refreshContext(session).catch(() => {});
      this._ensureContextPoll();
    }

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
    // The exit listener that would record final recency is dropped below,
    // before the (asynchronous) exit arrives.
    sessionHistory.touch(id, s.lastActivity);
    s.removeAllListeners();
    s.release();
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
    } else if (entry.kind === 'codex' && entry.codexSessionId) {
      const exists = await codexSessionExists(entry.codexSessionId);
      if (exists === false) {
        resumed = false;
      } else {
        resumeSessionId = entry.codexSessionId;
      }
    } else {
      // No transcript id ever recorded (non-claude/codex, or an older entry): can't
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
  // doesn't pin memory forever under session churn. The grace window lets a
  // client still reattach to read the final output / exit code.
  _scheduleReap(id) {
    const t = setTimeout(() => {
      const s = this.sessions.get(id);
      if (s && s.status === 'exited') this.remove(id);
    }, REAP_EXITED_AFTER_MS);
    if (t.unref) t.unref();
  }

  /**
   * Keep every live session's context occupancy up to date, for the CLIs that
   * record it. The figure is derived from the CLI's own session file rather
   * than from anything the session emits: each only ever shows it on its own
   * status line, so there is no stream to hook. That also means it moves
   * without any output arriving, which is why this is a poll and not an event.
   * One shared timer covers all sessions and stops once none are left, so an
   * idle dashboard does no work.
   */
  _ensureContextPoll() {
    if (this._contextTimer) return;
    const timer = setInterval(() => {
      const tracked = [...this.sessions.values()].filter(
        (s) => s.status !== 'exited' && this._contextSessionId(s)
      );
      if (tracked.length === 0) {
        clearInterval(timer);
        this._contextTimer = null;
        return;
      }
      for (const s of tracked) this._refreshContext(s);
    }, CONTEXT_POLL_MS);
    // Never hold the process open for a status readout.
    if (timer.unref) timer.unref();
    this._contextTimer = timer;
  }

  /**
   * The id whose session file holds this session's token accounting, or null
   * when the session has none to read. Codex only gains one once its first
   * message is sent, so a fresh codex session starts untracked and is picked up
   * by the poll as soon as the id is captured.
   */
  _contextSessionId(session) {
    if (session.kind === 'claude') return session._claudeSessionId;
    if (session.kind === 'codex') return session.codexSessionId;
    return null;
  }

  /** Read one session's context usage and broadcast it when it changed. */
  async _refreshContext(session) {
    const sessionId = this._contextSessionId(session);
    if (!sessionId) return;
    const next = await contextUsageFor({
      cwd: session.cwd,
      sessionId,
      kind: session.kind,
    });
    // A read that found nothing is not news: the session file may not exist yet
    // on a brand new session, and clearing the display on a transient failure
    // would make the figure flicker away for no reason.
    if (!next) return;
    const prev = session.context;
    if (prev && prev.tokens === next.tokens && prev.window === next.window) return;
    session.context = next;
    this._emitSessions();
  }

  _emitSessions() {
    this.emit('sessions', this.list());
  }
}

export const sessionManager = new SessionManager();
