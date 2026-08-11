// Strip terminal *query* sequences from a scrollback snapshot before replay.
//
// The scrollback is the raw byte stream a CLI once wrote, and it contains the
// capability queries TUIs emit on startup: device attributes (CSI c), cursor
// position / status reports (CSI 6n / 5n), mode queries (DECRQM), window size
// reports (CSI 14/16/18 t), color queries (OSC 10/11/12 ";?"), DECRQSS and
// XTGETTCAP. When a browser re-attaches, that history is replayed through
// xterm.js — which dutifully *answers* every fossilized query it sees, and the
// TerminalView forwards those answer bytes as keyboard input to the still-
// running CLI.
//
// To a raw-mode TUI that asked nothing, an unsolicited burst of ESC-prefixed
// reply bytes is garbage input: fragments land in the input box ("[?1;2c",
// ";rgb:ff/ff/ff"), and the leading ESCs read as the Escape key — which in
// Claude Code aborts the in-flight API request. With several agents re-attached
// at once (reopening the dashboard tab), every busy agent gets interrupted in
// the same instant and surfaces an API error. Filtering the queries out of the
// replay removes the trigger; answers to *live* queries (fresh output after
// attach) still flow normally.
//
// Only queries are removed. Mode *setting* sequences (bracketed paste, focus
// reporting, synchronized output on/off), colors, and every visible byte are
// preserved — replay must still reproduce the terminal state faithfully.
const QUERY_SEQUENCES = [
  // DA1 / DA2 / DA3 — CSI [>=] Ps c. Any parameterized `c` final is a device
  // attributes request; there is no other CSI ending in `c`. The `?` variant
  // is a *response* (never legitimate output), stripped for the same reason.
  /\x1b\[[>=?]?[0-9;]*c/g,
  // DSR status/cursor position (CSI 5n / 6n) and DEC variants (CSI ? Ps n).
  // Replies are `ESC[0n` / `ESC[row;colR` — the classic "R garbage" injector.
  /\x1b\[\??[0-9;]*n/g,
  // DECRQM mode query (CSI ? Ps $ p and the ANSI form). Claude Code probes
  // synchronized-output support with `CSI ?2026$p` on every launch.
  /\x1b\[\??[0-9;]*\$p/g,
  // XTWINOPS *report* requests only: 11/13/14/16/18/19/20/21 (+optional
  // second param, e.g. `14;2`). First params like 8 (resize) or 22/23 (title
  // push/pop) are commands, not queries, and are deliberately not matched.
  /\x1b\[(?:1[13468]|19|2[01])(?:;[0-9]+)?t/g,
  // Kitty keyboard protocol *query* (CSI ? u). Push/pop (`CSI > 1 u`,
  // `CSI < u`) are state changes and are kept.
  /\x1b\[\?u/g,
  // XTVERSION (CSI > Ps q). `CSI Ps SP q` (cursor style) has a space before
  // the final and does not match.
  /\x1b\[>[0-9]*q/g,
  // OSC color queries: OSC 10/11/12 ";?" (fg/bg/cursor) and OSC 4 with one or
  // more ";index;?" pairs. The *set* forms ("11;#ffffff") carry a value, not
  // `?`, and are preserved.
  /\x1b\](?:1[0-2]);\?(?:\x07|\x1b\\)/g,
  /\x1b\]4(?:;[0-9]+;\?)+(?:\x07|\x1b\\)/g,
  // DECRQSS (DCS $ q ... ST) and XTGETTCAP (DCS + q ... ST). Anchored on the
  // `$q`/`+q` introducer so sixel and other DCS payloads pass through.
  /\x1bP\$q[^\x07\x1b]*(?:\x07|\x1b\\)/g,
  /\x1bP\+q[^\x07\x1b]*(?:\x07|\x1b\\)/g,
];

/** Remove every terminal query from a replay snapshot; everything else is kept. */
export function stripTerminalQueries(snapshot) {
  if (!snapshot) return snapshot;
  let out = snapshot;
  for (const re of QUERY_SEQUENCES) out = out.replace(re, '');
  return out;
}
