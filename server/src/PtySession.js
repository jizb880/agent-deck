import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import pty from 'node-pty';
import headless from '@xterm/headless';
import serialize from '@xterm/addon-serialize';
import { SCROLLBACK_LINES, IDLE_AFTER_MS, KILL_ESCALATE_MS } from './config.js';
import { isWindows } from './platform.js';

const { Terminal: HeadlessTerminal } = headless;
const { SerializeAddon } = serialize;

// A character that means a row is carrying content rather than decoration.
// Letters and digits cover every human language a CLI prints, CJK included,
// while leaving out the box-drawing, block and braille glyphs that animated
// backdrops are built from. Used by the busy/idle heuristic (see _screenText).
const CONTENT_CHAR_RE = /[\p{L}\p{N}]/u;

/**
 * A single long-lived PTY running one CLI. Owns its child process, a headless
 * terminal emulator that mirrors what the CLI has drawn (so a reconnecting
 * browser can redraw the rendered history), and a coarse status heuristic
 * (running -> busy/idle, or exited).
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
    this.codexSessionId = null; // Captured after codex starts
    // Context-window occupancy for a Claude session, filled in by
    // SessionManager from the transcript (see contextUsage.js). null means the
    // figure is not known yet or does not apply to this kind of session.
    this.context = null; // { tokens, window, percent, model }
    this._idleTimer = null;
    this._killTimer = null;
    // Plain text of the screen at the last repaint that changed it. null until
    // the first render, so a session whose opening frame is blank still counts
    // as having drawn something. See _onRendered().
    this._lastScreen = null;

    // Everything the child ever printed, as the terminal *rendered* it. The
    // previous design kept the last 1 MiB of raw bytes, but a TUI like Claude
    // Code redraws its screen constantly: 1 MiB of that rendered to ~600
    // lines, and the earlier prompts of a long session were simply gone once
    // a client re-attached. Keeping the emulator's buffer instead makes the
    // snapshot the rendered scrollback, which is both complete and compact.
    this._term = new HeadlessTerminal({
      cols: this.cols,
      rows: this.rows,
      scrollback: SCROLLBACK_LINES,
      allowProposedApi: true,
    });
    this._serializer = new SerializeAddon();
    this._term.loadAddon(this._serializer);
    // Resolves once the most recently received output has been parsed.
    this._lastWrite = Promise.resolve();
    // serialize() restores the terminal's modes but not cursor visibility;
    // Claude Code hides the cursor, and a replay must not un-hide it.
    this._cursorHidden = false;
    this._term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, (params) => {
      if (params.includes(25)) this._cursorHidden = true;
      return false;
    });
    this._term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => {
      if (params.includes(25)) this._cursorHidden = false;
      return false;
    });

    // Reply to the terminal probes the CLIs send at startup. A freshly created
    // session has no WebSocket attached yet -- the browser only attaches once
    // the create request has returned and React has mounted the pane -- so a
    // probe sent in the first milliseconds has nobody to answer it and the CLI
    // commits to a guess. Doing it here means the answer is always available,
    // because this emulator has been parsing the child's output since its first
    // byte. Registered before pty.spawn() below so nothing can slip past.
    //
    // OSC 10 / OSC 11 ask for the terminal's foreground and background colours.
    // Codex asks both at startup and keys its whole palette off the reply: it
    // paints for a light terminal when told the background is white and for a
    // dark one otherwise, and the two use different colour vocabularies
    // (measured: 14 distinct SGR sequences when answered versus 12 when not).
    // xterm.js cannot answer at all -- it registers handlers for *setting*
    // these colours and ignores the query form -- which is why a Codex dialog
    // could come up styled for the opposite theme. The dashboard's theme is a
    // fixed light one (see LIGHT_THEME in web/src/TerminalView.jsx), so the
    // answer is a constant rather than anything client-dependent.
    for (const [code, rgb] of [
      [10, 'rgb:2429/2f24/2f24'],
      [11, 'rgb:ffff/ffff/ffff'],
    ]) {
      this._term.parser.registerOscHandler(code, (payload) => {
        // "?" is the query form; anything else is the CLI *setting* the colour,
        // which xterm.js already tracks and which needs no reply.
        if (payload === '?') this.write(`\x1b]${code};${rgb}\x1b\\`);
        return true;
      });
    }

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
    this._lastWrite = new Promise((resolve) =>
      this._term.write(data, () => {
        // A throwing status heuristic must never strand this promise:
        // getSnapshot() awaits it, so a rejection would hang every later
        // snapshot and leave the pane blank on reattach.
        try {
          this._onRendered();
        } catch {
          /* status is cosmetic; output handling is not */
        }
        resolve();
      })
    );
    this.lastActivity = Date.now();
    this.emit('data', data);
  }

  // Busy/idle follows what the terminal *shows*, not whether bytes arrived.
  //
  // Two separate animations made a finished Codex session report "busy"
  // forever, which is the 处理中 the sidebar never cleared:
  //
  //   1. It repaints its highlighted row about twelve times a second, printing
  //      identical characters with only the colour attributes changed.
  //   2. Its welcome screen runs a decorative backdrop of braille glyphs that
  //      genuinely rearranges, in a handful of rows, forever.
  //
  // So neither "did bytes arrive" nor "did any text change" is the right
  // question. What distinguishes work from decoration is *where* it happens: a
  // spinner, a streamed answer or a tool's output all touch a row carrying
  // words, while the backdrop only ever rewrites rows made purely of symbols.
  // Activity therefore counts only when a content row changes. Measured against
  // a live idle session: 143 chunks and 102 whole-screen text changes in ten
  // seconds, but those were confined to three symbol-only rows and the session
  // was using 0.1% CPU. On a working session the same measure tracked the run
  // exactly, from the first streamed line to the last.
  _onRendered() {
    const screen = this._screenText();
    if (screen === this._lastScreen) return;
    this._lastScreen = screen;
    this._markBusy();
  }

  /**
   * Text of the visible screen with decoration stripped: lines are joined only
   * when they contain at least one letter, digit or CJK character. Styling and
   * trailing blanks are excluded, and so is any row made purely of symbols.
   */
  _screenText() {
    const buf = this._term.buffer.active;
    const lines = [];
    for (let i = 0; i < this._term.rows; i++) {
      const line = buf.getLine(buf.viewportY + i);
      const text = line ? line.translateToString(true) : '';
      if (!CONTENT_CHAR_RE.test(text)) continue;
      lines.push(text);
    }
    return lines.join('\n');
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

  // User interaction (attach / keystroke / resize) counts as recency too, not
  // just agent output — otherwise "recent sessions" would rank a session that
  // never stopped printing above one the user just switched to and read.
  touch() {
    if (this.status === 'exited') return;
    this.lastActivity = Date.now();
    this.emit('touched');
  }

  _onExit(exitCode, signal) {
    this.status = 'exited';
    this.exitCode = exitCode;
    this.exitSignal = signal ?? null;
    if (this._idleTimer) clearTimeout(this._idleTimer);
    if (this._killTimer) clearTimeout(this._killTimer);
    this.emit('status', this.status);
    this.emit('exit', { exitCode, signal });
  }

  /**
   * The rendered terminal state — scrollback, screen, cursor, modes — as an
   * escape-sequence stream a freshly reset client terminal can replay.
   *
   * Waits for all output received so far to be parsed, then serializes in the
   * same turn, so the result is exact as of the moment it resolves: a caller
   * that subscribed to 'data' before calling this can discard every chunk it
   * saw up to then (they are in the snapshot) and forward the rest.
   */
  async getSnapshot() {
    let pending;
    do {
      pending = this._lastWrite;
      await pending;
    } while (pending !== this._lastWrite);
    let out = this._serializer.serialize();
    if (this._cursorHidden) out += '\x1b[?25l';
    return out;
  }

  /** Free the emulator's buffer (called when the session is reaped/removed). */
  release() {
    this._term.dispose();
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
    try {
      this.child.resize(c, r);
    } catch {
      // The resize did NOT happen (child just exited, or ConPTY rejected it —
      // a known flake right after spawn on Windows). Crucially, don't record
      // the new size: doing so made every retry with the same dims early-out
      // above, leaving the PTY permanently at its old width while server and
      // clients all believed it matched. A CLI laying out for that phantom
      // width breaks in subtle ways — e.g. Claude Code sees a soft-wrapped
      // input line as a single row, so ArrowDown falls through to history
      // instead of moving down a display row.
      return;
    }
    this.cols = c;
    this.rows = r;
    // Keep the mirror at the PTY's size so its reflow (and the snapshot a
    // client gets back) match what the CLI is laying out for.
    this._term.resize(c, r);
  }

  /**
   * Terminate the CLI. Returns true if the kill was issued, false if it could
   * not be (so callers don't forget a session whose process is still alive).
   *
   * Windows has no POSIX signals: node-pty *throws* "Signals not supported on
   * windows." for any signal argument, and when the terminal isn't ready yet it
   * queues that throw so it lands asynchronously, outside any try/catch here.
   * Passing a signal there would therefore never kill anything — it would just
   * leak the process and the ConPTY host. So on Windows we call kill() with no
   * argument (which closes the pseudoconsole and terminates the child) and skip
   * the escalation entirely, since there is no weaker signal to escalate from.
   */
  kill(signal = 'SIGTERM') {
    if (this.status === 'exited') return true;
    try {
      if (isWindows()) {
        this.child.kill();
        return true;
      }
      this.child.kill(signal);
    } catch (err) {
      // The child may have exited between our status check and the call, which
      // is benign. Anything else means the kill did not happen, and the caller
      // needs to know rather than assume success.
      if (this.status === 'exited') return true;
      this._lastKillError = err;
      return false;
    }
    if (signal === 'SIGKILL') return true;
    // Interactive login shells (`terminal` kind) ignore SIGTERM; escalate to
    // SIGKILL if the child hasn't exited within the grace period so a "stop"
    // request always terminates the session.
    if (this._killTimer) clearTimeout(this._killTimer);
    this._killTimer = setTimeout(() => {
      if (this.status === 'exited') return;
      try {
        this.child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }, KILL_ESCALATE_MS);
    if (this._killTimer.unref) this._killTimer.unref();
    return true;
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
      codexSessionId: this.codexSessionId,
      context: this.context,
    };
  }
}
