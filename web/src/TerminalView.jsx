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
  brightBlue: '#218bff',
  brightMagenta: '#a475f9',
  brightCyan: '#3192aa',
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

  useEffect(() => {
    const term = new Terminal({
      fontFamily: 'Menlo, Monaco, "SF Mono", "Courier New", monospace',
      fontSize: 13,
      lineHeight: 1.1,
      cursorBlink: true,
      scrollback: 10000,
      allowProposedApi: true,
      // Claude Code emits dim/gray truecolor text (thinking, hints, streamed
      // status) that the theme palette can't remap; force WCAG-AA legibility
      // against the white background instead.
      minimumContrastRatio: 4.5,
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
        // standard terminal behavior on resize.
        term.scrollToBottom();
        return true;
      } catch {
        return false;
      }
    };
    let tries = 0;
    const tryFit = () => {
      if (fitNow() || tries++ > 40) return;
      requestAnimationFrame(tryFit);
    };

    // Compute an initial size for the attach (falls back to 80x24).
    let cols = 80;
    let rows = 24;
    if (hostRef.current && hostRef.current.clientWidth > 0) {
      try {
        fit.fit();
        cols = term.cols;
        rows = term.rows;
      } catch {
        /* not laid out yet */
      }
    }

    term.onData((data) => wsClient.input(sessionId, data));

    const handler = (frame) => {
      switch (frame.type) {
        case 'attached':
          term.reset();
          // write() is async — scroll to bottom once the snapshot is rendered
          // so the replayed prompt/input box is in view.
          if (frame.snapshot) term.write(frame.snapshot, () => term.scrollToBottom());
          requestAnimationFrame(tryFit);
          break;
        case 'output':
          term.write(frame.data);
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

    return () => {
      if (roRef.current) roRef.current.disconnect();
      if (detachRef.current) detachRef.current();
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Re-fit + focus when this tab becomes active (it may have been display:none).
  useEffect(() => {
    if (!active) return;
    const t = setTimeout(() => {
      try {
        fitRef.current?.fit();
        if (termRef.current) {
          wsClient.resize(sessionId, termRef.current.cols, termRef.current.rows);
          termRef.current.scrollToBottom();
          termRef.current.focus();
        }
      } catch {
        /* ignore */
      }
    }, 40);
    return () => clearTimeout(t);
  }, [active, sessionId]);

  return <div className="term-host" ref={hostRef} />;
}
