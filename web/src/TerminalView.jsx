import React, { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { wsClient } from './wsClient.js';
import { OutputCoalescer } from './outputCoalescer.js';
import { getScrollHistory, saveScrollHistory, pruneScrollHistory } from './scrollMemory.js';

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
export default function TerminalView({ sessionId, active, kind }) {
  const hostRef = useRef(null);
  const termRef = useRef(null);
  const fitRef = useRef(null);
  const detachRef = useRef(null);
  const roRef = useRef(null);
  // Mirrors the `active` prop for handlers created in the mount effect (which
  // must not re-run on tab switches — that would tear down the terminal).
  const activeRef = useRef(active);
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
  // Last-known scroll state for this session, mirrored into scrollMemory when
  // this terminal unmounts. Survives reconnects and tab switches so switching
  // away and back restores where the user was reading instead of snapping to
  // the bottom after a snapshot replay. `offset` is rows above the bottom;
  // `follow: false` means "user deliberately scrolled up".
  const scrollStateRef = useRef({ follow: true, offset: 0 });
  // While a saved position is being restored (snapshot replay after a
  // reconnect/remount), suppress the rejoin logic: the write lands at the bottom
  // and its onScroll would otherwise re-enable follow before the restore.
  const restoringRef = useRef(false);
  // True when the user wedged a wheel scroll in between replay start and the
  // write callback (snapshot writes can take ~100ms on long transcripts); the
  // restore is then abandoned in favor of what they explicitly scrolled to.
  const userScrolledRef = useRef(false);
  // Session ids currently in the roster. The unmount cleanup saves the scroll
  // position back to scrollMemory, but must not do that for a session that was
  // just removed — the roster listener prunes it a moment later, and a stale
  // save could resurrect the entry for a future id reuse.
  const liveIdsRef = useRef(null);

  useEffect(() => {
    // A remount of this session's terminal (user switched away and back)
    // restores where they were reading, not the bottom. The saved position is
    // loaded here rather than at attach, so it survives the gap between mount
    // and the server's snapshot replay.
    const saved = getScrollHistory(sessionId);
    if (saved) {
      scrollStateRef.current = { ...saved };
      // Pre-set follow so the initial fit/activation can't snap to the bottom
      // before the snapshot arrives. (restoringRef itself is armed by the
      // attached handler, whose replay is what actually restores the position.)
      if (saved.follow === false) followRef.current = false;
    }

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

    // Batches raw PTY output into whole repaint frames before term.write();
    // see outputCoalescer.js. The write callback keeps the original follow-
    // mode behavior: Claude Code redraws via scroll regions / in-place
    // updates that don't always trigger xterm's own auto-scroll, and a reflow
    // can strand the viewport above the bottom — follow mode drags it back.
    const coalescer = new OutputCoalescer((data) => {
      term.write(data, followRef.current ? () => term.scrollToBottom() : undefined);
    });

    // Depth of snapshot replays currently being parsed (reconnects can overlap).
    // While >0, xterm's onData output is NOT forwarded to the PTY. The
    // snapshot is the server emulator's rendered buffer, so it carries no
    // terminal queries for xterm.js to answer — but the gate stays as a
    // backstop: a reply typed into the CLI mid-replay reads as the Escape key
    // and aborts an agent's in-flight API request. Answers to live queries
    // (output received after attach) still flow.
    let replayDepth = 0;

    term.onData((data) => {
      if (replayDepth > 0) return;
      wsClient.input(sessionId, data);
    });

    // IME-committed punctuation. Chinese IMEs (Sogou on macOS in particular)
    // commit full-width punctuation — "，。？！" — with no composition session:
    // the keydown/keypress still carry the ASCII key ("." / ","), xterm's
    // keypress handler sends that ASCII and cancels the event, and the IME's
    // "。" never reaches the PTY. So for a bare ASCII punctuation key, bypass
    // xterm's key handling and forward what the browser/IME actually inserts
    // (the `input` event's data) instead. Plain ASCII typing takes the same
    // route with the same result; letters, digits and modifier chords are left
    // to xterm, and anything inside a composition belongs to xterm's own IME
    // handling.
    let composing = false;
    let punctuationPending = false;
    const isPunctuationKey = (key) => {
      if (typeof key !== 'string' || key.length !== 1) return false;
      const c = key.charCodeAt(0);
      const alnum = (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
      return c > 0x20 && c <= 0x7e && !alnum;
    };
    const isImePunctuation = (e) =>
      !e.ctrlKey && !e.altKey && !e.metaKey && !e.isComposing && !composing && isPunctuationKey(e.key);
    const onCompositionStart = () => {
      composing = true;
      punctuationPending = false;
    };
    const onCompositionEnd = () => {
      composing = false;
    };
    term.textarea.addEventListener('compositionstart', onCompositionStart);
    term.textarea.addEventListener('compositionend', onCompositionEnd);
    // Capture on the host so this runs before xterm's own textarea listener,
    // which would otherwise send the glyph a second time.
    const onInput = (e) => {
      if (!punctuationPending) return;
      punctuationPending = false;
      if (e.inputType !== 'insertText' || !e.data) return;
      e.stopImmediatePropagation();
      // The glyph landed in xterm's helper textarea only because the keypress
      // wasn't cancelled; keep that textarea at its empty resting state.
      if (e.target instanceof HTMLTextAreaElement) e.target.value = '';
      term.input(e.data, true);
    };
    hostRef.current.addEventListener('input', onInput, true);

    // Answer the synchronized-output probe. On launch Claude Code asks DECRQM
    // `CSI ?2026$p` and only brackets its repaints with mode 2026 when the
    // terminal reports the mode as recognized — xterm.js implements neither
    // DECRQM nor mode 2026, so the probe went unanswered and Claude Code
    // repainted unsynchronized. Reply "recognized, currently reset"
    // (`?2026;2$y`) for 2026 only; every other mode stays unanswered exactly
    // as before. Replay-gated like onData.
    term.parser.registerCsiHandler(
      { prefix: '?', intermediates: '$', final: 'p' },
      (params) => {
        if (params[0] !== 2026) return false;
        if (replayDepth === 0) wsClient.input(sessionId, '\x1b[?2026;2$y');
        return true;
      }
    );

    // Prevent browser from intercepting terminal shortcuts. Many browsers bind
    // Ctrl+O (open file), Ctrl+S (save), Ctrl+W (close tab), etc., which breaks
    // TUI apps like Claude Code that need those keys. When the terminal has
    // focus, preventDefault on intercepted keys so they reach the PTY instead.
    term.attachCustomKeyEventHandler((e) => {
      // Shift+Enter must insert a newline, not submit. Native terminals get
      // that via Claude Code's own /terminal-setup, which binds the chord to
      // send ESC+CR; xterm.js has no such binding and emits a plain CR — on
      // the web that *sent* the message instead of breaking the line. Send
      // the same ESC+CR here (verified: claude inserts a newline). Scoped to
      // Claude sessions: shells like PSReadLine read a lone ESC as "clear
      // line", which would make the chord destructive in a plain terminal.
      if (kind === 'claude' && e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (e.type === 'keydown' && replayDepth === 0) wsClient.input(sessionId, '\x1b\r');
        e.preventDefault();
        return false; // swallow keydown/keypress/keyup so xterm never adds a CR
      }
      // Punctuation: let the browser/IME insert it and forward from `input`
      // (see above). keyup still goes to xterm so its key state resets.
      if (e.type === 'keyup') {
        punctuationPending = false;
      } else if (isImePunctuation(e)) {
        if (e.type === 'keydown') punctuationPending = true;
        return false;
      } else if (e.type === 'keydown') {
        punctuationPending = false;
      }
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
      if (restoringRef.current) userScrolledRef.current = true;
    };
    hostRef.current.addEventListener('wheel', onWheel, { passive: true });
    // Rejoin within a few rows of the bottom rather than at exact equality.
    // While output streams, each new line pushes baseY down faster than a
    // manual scroll can land on it, so viewportY === baseY is essentially
    // never hit — the user chases a bottom that keeps moving and can "never
    // reach it." A small threshold lets a downward scroll re-engage follow
    // mode mid-stream, after which scrollToBottom keeps it pinned.
    const REJOIN_ROWS = 3;
    const updateScrollState = () => {
      const buf = term.buffer.active;
      const fromBottom = buf.baseY - buf.viewportY;
      if (fromBottom <= REJOIN_ROWS) {
        followRef.current = true;
        scrollStateRef.current = { follow: true, offset: 0 };
      } else {
        scrollStateRef.current = { follow: false, offset: fromBottom };
      }
    };
    term.onScroll(() => {
      if (restoringRef.current) {
        // Keyboard PgUp/PgDn mid-replay: same user take-over as a wheel.
        const fromBottom = term.buffer.active.baseY - term.buffer.active.viewportY;
        if (fromBottom > REJOIN_ROWS) userScrolledRef.current = true;
        return;
      }
      updateScrollState();
    });
    // User scrolls (wheel, scrollbar drag) update the DOM scrollTop directly
    // and — unlike terminal-driven scrolls — skip xterm's public onScroll (the
    // viewport fires those with suppressScrollEvent). Listen on the viewport
    // element too so the saved position tracks what the user actually did.
    const viewportEl = hostRef.current.querySelector('.xterm-viewport');
    const onViewportScroll = () => {
      if (restoringRef.current) {
        // Scroll left the bottom mid-replay: the user took over, drop the
        // pending restore. (xterm's own refresh syncs scrollTop without
        // changing baseY - viewportY, so it stays below REJOIN_ROWS.)
        const fromBottom = term.buffer.active.baseY - term.buffer.active.viewportY;
        if (fromBottom > REJOIN_ROWS) userScrolledRef.current = true;
        return;
      }
      updateScrollState();
    };
    if (viewportEl) viewportEl.addEventListener('scroll', onViewportScroll, { passive: true });

    const handler = (frame) => {
      switch (frame.type) {
        case 'attached': {
          coalescer.reset();
          // Snapshot replay after a reconnect (or the remount path above)
          // would land at the bottom; re-apply the user's last position for
          // this session instead. `offset` is rows above the bottom, so a
          // buffer that grew or was trimmed while we were away still lands in
          // roughly the same place in the transcript.
          const saved = scrollStateRef.current;
          restoringRef.current = true;
          userScrolledRef.current = false;
          // Pre-set follow so a fit/activation that lands mid-replay (before
          // the write callback) doesn't snap to the bottom and undo the
          // restore below.
          if (saved.follow === false) followRef.current = false;
          term.reset();
          const replay = () => {
            // The user beat the replay (wheeled while it was in flight): they
            // scrolled where they wanted, keep it.
            if (userScrolledRef.current) {
              restoringRef.current = false;
              updateScrollState();
              return;
            }
            restoringRef.current = false;
            if (saved.follow === false) {
              const buf = term.buffer.active;
              // The write finished at the bottom (viewportY === baseY), so
              // backing off by the saved offset puts the same rows as when the
              // user left — baseY, not buffer.length, is the frame of
              // reference (length also counts the visible `rows`).
              const target = Math.max(0, buf.baseY - saved.offset);
              // scrollLines fires onScroll -> updateScrollState, which would
              // overwrite the restore with its own view-position reading, so
              // re-set the saved offset after scrolling to the same place:
              // the restored position is what the user saw when they left.
              followRef.current = false;
              term.scrollLines(target - buf.viewportY);
              scrollStateRef.current = { follow: false, offset: saved.offset };
            } else {
              // write() below left the viewport at the bottom already; no need
              // for an extra scroll, but keep the state explicit for the
              // unmount-save to pick up.
              term.scrollToBottom();
              scrollStateRef.current = { follow: true, offset: 0 };
            }
          };
          if (frame.snapshot) {
            replayDepth += 1;
            term.write(frame.snapshot, () => {
              replayDepth -= 1;
              replay();
            });
          } else {
            replay();
          }
          requestAnimationFrame(tryFit);
          break;
        }
        case 'output':
          // Through the coalescer: synchronized-update frames (mode 2026) and
          // sub-frame bursts reach xterm as one write, so an in-place TUI
          // repaint (Claude Code with a long transcript) renders atomically
          // instead of flashing the cursor through its intermediate states.
          coalescer.push(frame.data);
          break;
        case 'error':
          // Render ahead of held output would reorder the stream — drain first.
          coalescer.flush();
          term.write(`\r\n\x1b[31m[${frame.message || 'error'}]\x1b[0m\r\n`);
          break;
        case 'exit':
          coalescer.flush();
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

    // Dimension reconciliation. The roster broadcast carries each session's
    // server-side PTY cols/rows; if they drift from what this terminal
    // actually shows (a resize frame silently dropped while the socket was
    // reconnecting, a fit that never landed while the pane had no size…), the
    // CLI lays text out for a width the user isn't seeing. Claude Code then
    // treats a soft-wrapped input line as one row — ArrowDown stops moving
    // down within the input and falls through to history-next. Re-assert this
    // terminal's real size whenever the roster disagrees. Gated to the active
    // pane of the focused document so two windows showing the same session
    // don't fight over the PTY size, and throttled as belt-and-braces against
    // resize/roster feedback loops.
    let lastReconcile = 0;
    const offRoster = wsClient.onRoster((sessions) => {
      // Sessions that vanished are gone; drop their scroll memory so no stale
      // position survives to a future id reuse.
      liveIdsRef.current = sessions.map((s) => s.id);
      pruneScrollHistory(liveIdsRef.current);
      if (!activeRef.current || document.hidden || !document.hasFocus()) return;
      const el = hostRef.current;
      if (!el || el.clientWidth === 0 || el.clientHeight === 0) return;
      const s = sessions.find((x) => x.id === sessionId);
      if (!s || (s.cols === term.cols && s.rows === term.rows)) return;
      const now = Date.now();
      if (now - lastReconcile < 1000) return;
      lastReconcile = now;
      wsClient.resize(sessionId, term.cols, term.rows);
    });

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
      hostRef.current?.removeEventListener('input', onInput, true);
      term.textarea?.removeEventListener('compositionstart', onCompositionStart);
      term.textarea?.removeEventListener('compositionend', onCompositionEnd);
      viewportEl?.removeEventListener('scroll', onViewportScroll);
      offRoster();
      if (roRef.current) roRef.current.disconnect();
      if (detachRef.current) detachRef.current();
      coalescer.dispose();
      // Persist the user's position before the terminal is destroyed; the next
      // mount of this session reads it back (see the mount effect above).
      // Recompute from the live buffer — updateScrollState may not have seen
      // the final scroll event yet, e.g. a wheel-up right before switching.
      // Skip the save only once we know for sure the session left the roster:
      // saving after the prune would resurrect the entry (and never be cleaned).
      const liveIds = liveIdsRef.current;
      const stillLive = liveIds === null || liveIds.includes(sessionId);
      if (stillLive) {
        const buf = term.buffer.active;
        const fromBottom = buf.baseY - buf.viewportY;
        scrollStateRef.current =
          fromBottom <= 3
            ? { follow: true, offset: 0 }
            : { follow: false, offset: fromBottom };
        saveScrollHistory(sessionId, scrollStateRef.current);
      }
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Re-fit, resync and focus when this tab becomes active. Inactive panes now
  // stay laid out (visibility:hidden, not display:none) so geometry shouldn't
  // go stale at all — but a tab switch is still the moment to repair anything
  // that did drift, so the user never has to reload to reach the last row.
  useEffect(() => {
    activeRef.current = active;
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
        // Suppressed while a snapshot replay is in flight: the replay re-applies
        // the saved position itself, and snapping now would undo it.
        if (!restoringRef.current && followRef.current) termRef.current?.scrollToBottom();
        termRef.current?.focus();
      });
    });
    return () => {
      cancelled = true;
    };
  }, [active, sessionId]);

  return <div className="term-host" ref={hostRef} />;
}
