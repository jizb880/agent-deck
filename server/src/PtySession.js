import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import pty from 'node-pty';
import { SCROLLBACK_BYTES, IDLE_AFTER_MS } from './config.js';

/**
 * A single long-lived PTY running one CLI. Owns its child process, a bounded
 * scrollback buffer (so a reconnecting browser can redraw history), and a
 * coarse status heuristic (running -> busy/idle, or exited).
 *
 * Lifecycle is independent of any WebSocket: clients attach and detach freely;
 * the child keeps running as long as the backend process lives.
 */
export class PtySession extends EventEmitter {
  constructor({ launch, personaId, personaName, title }) {
    super();
    this.id = crypto.randomUUID();
    this.kind = launch.kind;
    this.personaId = personaId || null;
    this.personaName = personaName || null;
    this.title = title || launch.label || launch.kind;
    this.cwd = launch.cwd;
    this.commandLine = launch.commandLine;
    this.cols = 120;
    this.rows = 30;
    this.createdAt = Date.now();
    this.lastActivity = Date.now();
    this.exitCode = null;
    this.exitSignal = null;
    this.status = 'starting';
    this._idleTimer = null;

    // Scrollback ring: array of Buffer chunks with a running byte total.
    this._buffers = [];
    this._bytes = 0;

    this.child = pty.spawn(launch.file, launch.args, {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd: launch.cwd,
      env: launch.env,
    });

    this.status = 'running';

    this.child.onData((data) => this._onData(data));
    this.child.onExit(({ exitCode, signal }) => this._onExit(exitCode, signal));
  }

  _onData(data) {
    const chunk = Buffer.from(data, 'utf8');
    this._buffers.push(chunk);
    this._bytes += chunk.length;
    // Trim oldest chunks once we exceed the cap.
    while (this._bytes > SCROLLBACK_BYTES && this._buffers.length > 1) {
      this._bytes -= this._buffers.shift().length;
    }
    this.lastActivity = Date.now();
    this._markBusy();
    this.emit('data', data);
  }

  _markBusy() {
    if (this.status === 'exited') return;
    if (this.status !== 'busy') {
      this.status = 'busy';
      this.emit('status', this.status);
    }
    if (this._idleTimer) clearTimeout(this._idleTimer);
    this._idleTimer = setTimeout(() => {
      if (this.status === 'busy') {
        this.status = 'idle';
        this.emit('status', this.status);
      }
    }, IDLE_AFTER_MS);
    if (this._idleTimer.unref) this._idleTimer.unref();
  }

  _onExit(exitCode, signal) {
    this.status = 'exited';
    this.exitCode = exitCode;
    this.exitSignal = signal ?? null;
    if (this._idleTimer) clearTimeout(this._idleTimer);
    this.emit('status', this.status);
    this.emit('exit', { exitCode, signal });
  }

  /** Full scrollback as a single string for replay on attach. */
  getScrollback() {
    return Buffer.concat(this._buffers).toString('utf8');
  }

  /** Release scrollback memory (called when the session is reaped/removed). */
  releaseBuffers() {
    this._buffers = [];
    this._bytes = 0;
  }

  write(data) {
    if (this.status === 'exited') return;
    this.child.write(data);
  }

  // Backpressure: a slow WS client can request the PTY pause reading from the
  // CLI so the kernel pipe applies flow control to the process (correct Unix
  // behavior) instead of us buffering output unboundedly in Node. Refcounted
  // so multiple attached clients don't fight; the PTY resumes only when every
  // requester has released.
  pause() {
    if (this.status === 'exited') return;
    this._pauseCount = (this._pauseCount || 0) + 1;
    if (this._pauseCount === 1) {
      try {
        this.child.pause();
      } catch {
        /* ignore */
      }
    }
  }

  resume() {
    if (this._pauseCount > 0) this._pauseCount -= 1;
    if (this._pauseCount === 0 && this.status !== 'exited') {
      try {
        this.child.resume();
      } catch {
        /* ignore */
      }
    }
  }

  resize(cols, rows) {
    if (this.status === 'exited') return;
    const c = Math.max(2, Math.floor(cols) || 0);
    const r = Math.max(1, Math.floor(rows) || 0);
    if (c === this.cols && r === this.rows) return;
    this.cols = c;
    this.rows = r;
    try {
      this.child.resize(c, r);
    } catch {
      // Child may have just exited; ignore.
    }
  }

  kill(signal = 'SIGTERM') {
    if (this.status === 'exited') return;
    try {
      this.child.kill(signal);
    } catch {
      /* already gone */
    }
  }

  toJSON() {
    return {
      id: this.id,
      kind: this.kind,
      title: this.title,
      personaId: this.personaId,
      personaName: this.personaName,
      cwd: this.cwd,
      cols: this.cols,
      rows: this.rows,
      status: this.status,
      exitCode: this.exitCode,
      exitSignal: this.exitSignal,
      createdAt: this.createdAt,
      lastActivity: this.lastActivity,
    };
  }
}
