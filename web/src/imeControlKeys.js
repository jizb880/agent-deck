// Recovers control keys that a CJK IME has masked from xterm.js.
//
// With Sogou / Apple Pinyin (or any Chinese/Japanese/Korean IME) active, Chrome
// on macOS and Windows reports keyCode 229 ("Process") for every key the IME
// claims — even Ctrl+<letter> chords and a bare Escape, which never begin a
// composition and never produce an `input` event. xterm.js 5.5 derives every
// control byte from the legacy keyCode (65..90 → keyCode-64) and its
// CompositionHelper swallows any non-composing 229 keydown outright, so the
// chord is dropped: nothing reaches onData, nothing reaches the PTY. In Claude
// Code that shows up as Ctrl+O (transcript), Ctrl+E (show all) and Esc doing
// nothing while the IME is on, and working again the moment it is switched to
// ASCII mode. Upstream: xtermjs/xterm.js#6065 (fix in #6066, unmerged).
//
// The physical `code` is still correct on those events, so the byte can be
// recovered from it. Scope is deliberately the same as upstream's: Ctrl+letter,
// Ctrl+Space and Escape, only when the IME has actually masked the event
// (keyCode 229 or key "Process"). Plain composable keys are left alone so the
// IME's own composition/input path keeps handling them.

/**
 * The control byte a masked keyboard event stands for, or null when the event
 * is not an IME-masked control input (and should go to xterm as usual).
 * @param {{ keyCode?: number, key?: string, code?: string, ctrlKey?: boolean, altKey?: boolean, metaKey?: boolean, shiftKey?: boolean, isComposing?: boolean }} e
 * @returns {string | null}
 */
export function imeMaskedControlByte(e) {
  if (e.keyCode !== 229 && e.key !== 'Process') return null;
  // Mid-composition the IME owns the key: Esc there cancels the pinyin buffer
  // and Ctrl chords edit it, and neither reaches a native terminal either.
  if (e.isComposing) return null;
  const code = e.code || '';
  // Escape has no printable meaning and never composes: recover it regardless
  // of modifiers, as a native terminal would deliver it.
  if (code === 'Escape') return '\x1b';
  if (!e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return null;
  if (code.length === 4 && code.startsWith('Key')) {
    const c = code.charCodeAt(3);
    if (c >= 0x41 && c <= 0x5a) return String.fromCharCode(c - 64);
  }
  if (code === 'Space') return '\x00';
  return null;
}
