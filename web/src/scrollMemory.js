// Remembers each session's scroll position across TerminalView unmount/remount.
//
// RightPanel renders only the active session's terminal, so switching sessions
// disposes the old xterm instance and mounts a fresh one that replays the
// server-side scrollback. Without this module the new instance has no idea the
// user was reading an earlier part of the transcript and snaps to the bottom —
// losing their place every time they switch away and back.
//
// Keyed by sessionId so an entry survives the component lifecycle. The offset
// is stored as rows above the bottom of the scrolled-out buffer (baseY -
// viewportY), so a buffer that grew or was trimmed while we were away restores
// to roughly the same place in the transcript rather than a raw line number.

const historyBySession = new Map();

export function saveScrollHistory(sessionId, { follow, offset }) {
  historyBySession.set(sessionId, { follow, offset });
}

export function getScrollHistory(sessionId) {
  return historyBySession.get(sessionId) ?? null;
}

// Drop entries for sessions that no longer exist in the roster. Called from
// the roster subscription in TerminalView so a session that was reaped or
// removed (not just switched away from) doesn't leave its scroll position
// behind for a future id reuse.
export function pruneScrollHistory(liveSessionIds) {
  const live = new Set(liveSessionIds);
  for (const id of historyBySession.keys()) {
    if (!live.has(id)) historyBySession.delete(id);
  }
}
