// Coalesces PTY output before it reaches xterm.write(), so full-screen TUI
// repaints render atomically instead of as a storm of intermediate states.
//
// Why: TUIs like Claude Code redraw their prompt/status area in place — cursor
// up N rows, erase, rewrite. The PTY delivers that repaint as many small
// chunks, and xterm renders whatever half-applied state exists at each frame:
// with a lot of scrollback the visible effect is the cursor "jumping around"
// the transcript mid-redraw. Terminals solve this with the synchronized-output
// protocol (DEC private mode 2026): the app brackets a repaint with
// `CSI ?2026h` (begin) … `CSI ?2026l` (end) and the terminal applies the whole
// frame at once. xterm.js implements neither the mode nor the DECRQM probe for
// it, so this module supplies the semantics at the stream layer:
//
//  - Bytes between a begin/end marker pair are held and written in a single
//    xterm.write() call, so no intermediate repaint state is ever rendered.
//  - Everything else is micro-batched (~one display frame) — this alone
//    collapses most of a repaint burst even when the CLI never got a 2026
//    handshake (e.g. Windows ConPTY re-synthesizing the stream).
//
// Safety valves, because a display layer must never freeze on bad input:
//  - a sync frame whose end marker never arrives is released after
//    `syncTimeoutMs` (the protocol spec tells terminals to do exactly this);
//  - the buffer is force-flushed past `maxBufferedBytes` regardless of state;
//  - a marker split across chunk boundaries is detected via a held tail (and a
//    partial escape sequence is safe to withhold indefinitely: it is invisible
//    by definition — xterm's own parser would also just sit mid-sequence).
//
// The markers themselves are passed through to xterm (which ignores unknown
// modes) so the scrollback the browser renders stays byte-identical to what
// the server recorded.

const BSU = '\x1b[?2026h'; // begin synchronized update
const ESU = '\x1b[?2026l'; // end synchronized update
// Longest run a split marker can leave dangling at the end of a chunk (both
// markers share it; only the final byte differs).
const MARKER_PREFIX = '\x1b[?2026';

/** Trailing chars of `s` that could be the start of a split marker, or ''. */
function partialMarkerSuffix(s) {
  const max = Math.min(MARKER_PREFIX.length, s.length);
  for (let len = max; len > 0; len--) {
    if (s.endsWith(MARKER_PREFIX.slice(0, len))) return s.slice(s.length - len);
  }
  return '';
}

export class OutputCoalescer {
  /**
   * @param {(data: string) => void} write  sink, e.g. term.write
   * @param {{batchMs?: number, syncTimeoutMs?: number, maxBufferedBytes?: number}} [opts]
   */
  constructor(write, { batchMs = 16, syncTimeoutMs = 200, maxBufferedBytes = 1 << 20 } = {}) {
    this._write = write;
    this._batchMs = batchMs;
    this._syncTimeoutMs = syncTimeoutMs;
    this._max = maxBufferedBytes;
    this._buf = '';
    this._scan = 0; // how far _buf has been scanned for markers
    this._syncing = false; // inside a BSU..ESU frame
    this._batchTimer = null;
    this._syncTimer = null;
  }

  push(data) {
    if (!data) return;
    this._buf += data;
    const frameEnded = this._scanMarkers();
    if (this._buf.length > this._max) {
      // Pathological frame size — render what we have rather than buffer
      // unboundedly. The remainder streams unsynchronized, which is exactly
      // the pre-2026 behavior.
      this._flush();
      return;
    }
    if (this._syncing) return; // hold until ESU or the sync timeout
    if (frameEnded) {
      // A complete frame is sitting in the buffer: render it now rather than
      // an animation frame later, so synchronized repaints add no latency.
      this._flush();
      return;
    }
    if (this._batchTimer === null) {
      this._batchTimer = setTimeout(() => {
        this._batchTimer = null;
        if (!this._syncing) this._flush();
      }, this._batchMs);
    }
  }

  /** Force-render everything held now, abandoning any open sync frame. */
  flush() {
    this._clearSyncTimer();
    this._syncing = false;
    this._flush();
  }

  /** Drop all held state (call before a term.reset()/snapshot replay). */
  reset() {
    if (this._batchTimer !== null) clearTimeout(this._batchTimer);
    this._batchTimer = null;
    this._clearSyncTimer();
    this._buf = '';
    this._scan = 0;
    this._syncing = false;
  }

  dispose() {
    this.reset();
  }

  /** Advance the marker scanner; returns true if an ESU closed a frame. */
  _scanMarkers() {
    let frameEnded = false;
    for (;;) {
      const marker = this._syncing ? ESU : BSU;
      const idx = this._buf.indexOf(marker, this._scan);
      if (idx === -1) {
        // Nothing (more) to find; back the scan position off the tail so a
        // marker split across pushes is still seen next time.
        const safe = this._buf.length - (marker.length - 1);
        if (safe > this._scan) this._scan = safe;
        return frameEnded;
      }
      this._scan = idx + marker.length;
      if (this._syncing) {
        this._syncing = false;
        this._clearSyncTimer();
        frameEnded = true;
      } else {
        this._syncing = true;
        this._armSyncTimer();
      }
    }
  }

  _armSyncTimer() {
    if (this._syncTimer !== null) return;
    this._syncTimer = setTimeout(() => {
      this._syncTimer = null;
      // The end marker never arrived (app crashed mid-frame, marker lost in
      // truncation…). Release the frame instead of freezing the terminal.
      this._syncing = false;
      this._flush();
    }, this._syncTimeoutMs);
  }

  _clearSyncTimer() {
    if (this._syncTimer !== null) {
      clearTimeout(this._syncTimer);
      this._syncTimer = null;
    }
  }

  _flush() {
    if (this._batchTimer !== null) {
      clearTimeout(this._batchTimer);
      this._batchTimer = null;
    }
    if (this._buf.length === 0) return;
    // Withhold a trailing partial marker so detection survives the flush.
    // (Withholding is safe: xterm parses split sequences across writes, and an
    // incomplete escape sequence renders nothing either way.)
    const hold = partialMarkerSuffix(this._buf);
    const out = hold ? this._buf.slice(0, -hold.length) : this._buf;
    this._buf = hold;
    this._scan = 0;
    if (out) this._write(out);
  }
}
