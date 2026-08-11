import React, { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { wsClient } from './wsClient.js';

// Light terminal theme (GitHub-light-ish ANSI palette tuned for a white bg).
const LIGHT_THEME = {
  background: '#ffffff',
  foreground: '#24292f',
  cursor: '#0969da',
  cursorAccent: '#ffffff',
  selectionBackground: '#b6d7ff',
  black: '#24292f',
  red: '#cf222e',
  green: '#116329',
  yellow: '#953800',
  blue: '#0969da',
  magenta: '#8250df',
  cyan: '#1b7c83',
  white: '#57606a',
  brightBlack: '#57606a',
  brightRed: '#a40e26',
  brightGreen: '#1a7f37',
  brightYellow: '#633c01',
  // Bright accents darkened for the white bg: TUIs designed for dark
  // terminals (Claude Code select menus, pointers) lean on these, and the
  // stock GitHub-light values sit near 3:1 contrast — nearly invisible.
  brightBlue: '#0550ae',
  brightMagenta: '#6639ba',
  brightCyan: '#1b7c83',
  brightWhite: '#424a53',
};

/**
 * Renders one PTY session in an xterm.js terminal (rendered directly into its
 * pane — a stable DOM node). Replays scrollback on attach, and fits to its
 * container, retrying until the container actually has a size (so a freshly
 * mounted pane never advertises 0 cols to the backend).
 */
export default function TerminalView({ sessionId, active }) {
  const hostRef = useRef(null);
  const termRef = useRef(null);
  const fitRef = useRef(null);
  const detachRef = useRef(null);
  const roRef = useRef(null);
  // Exposed so the "tab became active" effect can reuse the same retry-based
  // refit the mount path uses, instead of a single fit that silently fails if
  // layout hasn't settled yet.
  const tryFitRef = useRef(null);
  // Forces xterm to rebuild a scroll extent that went stale while hidden.
  const resyncRef = useRef(null);
  // Follow-the-bottom mode: true unless the user deliberately scrolled up.
  // Deciding by intent (wheel up = leave, back at bottom = rejoin) instead of
  // by current position is what lets us recover a viewport that a reflow or
  // in-place TUI redraw stranded above the bottom.
  const followRef = useRef(true);

  useEffect(() => {
    const term = new Terminal({
      // Per-platform monospace faces, best-first: the mac ones, then the
      // Windows console fonts (Cascadia ships with Terminal/VS, Consolas with
      // Windows itself), then common Linux faces. Falling all the way through
      // to generic `monospace` changes cell metrics, which FitAddon feeds
      // straight into the cols/rows advertised to the PTY.
      fontFamily:
        'Menlo, Monaco, "SF Mono", "Cascadia Mono", "Cascadia Code", Consolas, ' +
        '"DejaVu Sans Mono", "Liberation Mono", "Ubuntu Mono", "Courier New", monospace',
      fontSize: 13,
      lineHeight: 1.1,
      cursorBlink: true,
      scrollback: 10000,
      allowProposedApi: true,
      // Claude Code emits dim/gray truecolor text (thinking, hints, streamed
      // status) and paints its select-menu highlight/pointer with dark-theme
      // colors the palette can't remap; 4.5 (AA) still left the selection
      // cursor hard to spot on white, so force AAA-level contrast.
      minimumContrastRatio: 7,
      theme: LIGHT_THEME,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(hostRef.current);
    termRef.current = term;
    fitRef.current = fit;

    // Fit only once the host has real dimensions; retry a few frames otherwise.
    const fitNow = () => {
      const el = hostRef.current;
      if (!el || el.clientWidth === 0 || el.clientHeight === 0) return false;
      try {
        fit.fit();
        wsClient.resize(sessionId, term.cols, term.rows);
        // Reflow can leave the viewport stuck above the bottom; TUIs like
        // Claude Code redraw in place (no new scroll), so it never snaps
        // back on its own and the prompt stays hidden. Snap explicitly —
        // unless the user deliberately scrolled up to read scrollback.
        if (followRef.current) term.scrollToBottom();
        return true;
      } catch {
        return false;
      }
    };
    // Retry across a few frames until the host has real dimensions. Each
    // schedule gets its own counter so later triggers (focus, resize) still
    // retry even after an earlier burst exhausted its attempts.
    const tryFit = () => {
      let tries = 0;
      const attempt = () => {
        if (fitNow() || tries++ > 40) return;
        requestAnimationFrame(attempt);
      };
      attempt();
    };
    tryFitRef.current = tryFit;

    // Last-resort recovery for a viewport whose scroll extent went stale.
    // xterm only recomputes the scrollbar's extent when its dimensions
    // change, and fit() is a no-op when cols/rows already match — so a pane
    // that took output while it had no measurable size can end up with a
    // scroll area shorter than its buffer, i.e. a scrollbar that cannot be
    // dragged to the last row. Reloading the page was the only cure. Compare
    // the rendered extent against the buffer and, if short, force one real
    // resize so xterm rebuilds it.
    const resyncIfStale = () => {
      const el = hostRef.current;
      if (!el || el.clientHeight === 0) return;
      const viewport = el.querySelector('.xterm-viewport');
      if (!viewport || viewport.clientHeight === 0) return;
      const cols = term.cols;
      const rows = term.rows;
      // The viewport shows exactly `rows` rows, so this is the live cell height.
      const cellH = viewport.clientHeight / Math.max(rows, 1);
      const expected = term.buffer.active.length * cellH;
      // Allow a row of slack for rounding.
      if (viewport.scrollHeight >= expected - cellH) return;
      try {
        term.resize(cols, Math.max(rows - 1, 2));
        term.resize(cols, rows);
        wsClient.resize(sessionId, cols, rows);
        if (followRef.current) term.scrollToBottom();
      } catch {
        /* ignore */
      }
    };
    resyncRef.current = resyncIfStale;

    // Compute an initial size for the attach. When the host hasn't been laid
    // out yet (clientWidth 0 — the normal case on a fresh page load), attach
    // *without* dimensions so the server keeps the PTY's current size. The old
    // 80x24 fallback bounced every re-attached session through a tiny resize
    // (real size -> 80x24 -> real size one frame later), forcing two SIGWINCH
    // reflows on every CLI each time the dashboard tab was reopened.
    let cols;
    let rows;
    if (hostRef.current && hostRef.current.clientWidth > 0) {
      try {
        fit.fit();
        cols = term.cols;
        rows = term.rows;
      } catch {
        /* not laid out yet */
      }
    }

    // Depth of snapshot replays currently being parsed (reconnects can overlap).
    // While >0, xterm's onData output is NOT forwarded to the PTY: replaying
    // history makes xterm.js re-answer every terminal query recorded in it
    // (device attributes, cursor position, colors…), and forwarding those
    // replies would type stray ESC-sequences into the running CLI — Claude
    // Code reads the ESCs as the Escape key and aborts its in-flight API
    // request. The server strips queries from snapshots too (replayFilter.js);
    // this gate covers partial sequences that survive scrollback trimming and
    // keeps a few ms of replay-time keystrokes from interleaving mid-redraw.
    // Answers to live queries (output received after attach) still flow.
    let replayDepth = 0;

    term.onData((data) => {
      if (replayDepth > 0) return;
      wsClient.input(sessionId, data);
    });

    // Prevent browser from intercepting terminal shortcuts. Many browsers bind
    // Ctrl+O (open file), Ctrl+S (save), Ctrl+W (close tab), etc., which breaks
    // TUI apps like Claude Code that need those keys. When the terminal has
    // focus, preventDefault on intercepted keys so they reach the PTY instead.
    term.attachCustomKeyEventHandler((e) => {
      // Only intercept when Ctrl/Cmd is pressed (not plain typing).
      if (!e.ctrlKey && !e.metaKey) return true;
      // List of keys the browser commonly intercepts that TUIs expect to receive.
      // Add more as needed for other CLI shortcuts.
      const intercepted = ['o', 'O', 's', 'S', 'w', 'W', 'n', 'N', 't', 'T', 'p', 'P'];
      if (intercepted.includes(e.key)) {
        e.preventDefault();
        e.stopPropagation();
        return true; // still send to terminal
      }
      return true;
    });

    // Leave follow mode only on a deliberate upward scroll; rejoin whenever
    // the viewport comes back near the bottom (wheel, scrollbar, or scroll).
    const onWheel = (e) => {
      if (e.deltaY < 0) followRef.current = false;
    };
    hostRef.current.addEventListener('wheel', onWheel, { passive: true });
    // Rejoin within a few rows of the bottom rather than at exact equality.
    // While output streams, each new line pushes baseY down faster than a
    // manual scroll can land on it, so viewportY === baseY is essentially
    // never hit — the user chases a bottom that keeps moving and can "never
    // reach it." A small threshold lets a downward scroll re-engage follow
    // mode mid-stream, after which scrollToBottom keeps it pinned.
    const REJOIN_ROWS = 3;
    term.onScroll(() => {
      const buf = term.buffer.active;
      if (buf.baseY - buf.viewportY <= REJOIN_ROWS) followRef.current = true;
    });

    const handler = (frame) => {
      switch (frame.type) {
        case 'attached':
          term.reset();
          followRef.current = true;
          // write() is async — scroll to bottom once the snapshot is rendered
          // so the replayed prompt/input box is in view. The gate opens in the
          // same callback: by then every auto-reply the replay provoked has
          // been emitted (and dropped).
          if (frame.snapshot) {
            replayDepth += 1;
            term.write(frame.snapshot, () => {
              replayDepth -= 1;
              term.scrollToBottom();
            });
          }
          requestAnimationFrame(tryFit);
          break;
        case 'output':
          // Keep the viewport pinned while output streams. Claude Code
          // redraws via scroll regions / in-place updates that don't always
          // trigger xterm's own auto-scroll, and a reflow can strand the
          // viewport above the bottom — follow mode drags it back.
          term.write(frame.data, followRef.current ? () => term.scrollToBottom() : undefined);
          break;
        case 'error':
          term.write(`\r\n\x1b[31m[${frame.message || 'error'}]\x1b[0m\r\n`);
          break;
        case 'exit':
          term.write(
            `\r\n\x1b[33m[session exited: code=${frame.exitCode ?? '?'}` +
              (frame.exitSignal ? ` signal=${frame.exitSignal}` : '') +
              `]\x1b[0m\r\n`
          );
          break;
        default:
          break;
      }
    };
    detachRef.current = wsClient.attach(sessionId, handler, cols, rows);

    const ro = new ResizeObserver(() => tryFit());
    ro.observe(hostRef.current);
    roRef.current = ro;
    requestAnimationFrame(tryFit);

    // Re-fit when the window regains focus/visibility — the same recovery a
    // tab switch performs, without requiring one. Covers viewport desyncs
    // that accumulate while the page is backgrounded.
    const onWindowActive = () => {
      tryFit();
      resyncIfStale();
    };
    window.addEventListener('focus', onWindowActive);
    document.addEventListener('visibilitychange', onWindowActive);
    // Late font loads change cell metrics; re-fit once fonts settle.
    if (document.fonts?.ready) document.fonts.ready.then(onWindowActive).catch(() => {});

    return () => {
      window.removeEventListener('focus', onWindowActive);
      document.removeEventListener('visibilitychange', onWindowActive);
      hostRef.current?.removeEventListener('wheel', onWheel);
      if (roRef.current) roRef.current.disconnect();
      if (detachRef.current) detachRef.current();
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Re-fit, resync and focus when this tab becomes active. Inactive panes now
  // stay laid out (visibility:hidden, not display:none) so geometry shouldn't
  // go stale at all — but a tab switch is still the moment to repair anything
  // that did drift, so the user never has to reload to reach the last row.
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    // Two rAFs: let the browser finish laying out / painting the newly visible
    // pane before we measure, so the first fit attempt sees real dimensions.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (cancelled) return;
        tryFitRef.current?.();
        // fit() alone can't help when cols/rows are unchanged but the scroll
        // extent is stale; this is what restores the ability to drag all the
        // way to the last row after coming back to the tab.
        resyncRef.current?.();
        if (followRef.current) termRef.current?.scrollToBottom();
        termRef.current?.focus();
      });
    });
    return () => {
      cancelled = true;
    };
  }, [active, sessionId]);

  return <div className="term-host" ref={hostRef} />;
}
