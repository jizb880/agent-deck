// Whether the terminal keeps the viewport pinned to the bottom as output
// streams. Split out of TerminalView so the rule is testable without a DOM
// and lives in one place.
//
// The rule is about intent, not position:
//
//   - follow starts on, so a fresh pane tracks live output;
//   - an explicit wheel-up leaves follow, and ONLY an explicit scroll back
//     down re-attaches it;
//   - while detached, nothing drags the viewport down — not a reflow, and
//     certainly not the next chunk of streamed output.
//
// The bug this replaces re-attached on position alone ("within 3 rows of the
// bottom"), evaluated on every scroll event. One wheel notch is ~3 rows, so a
// single upward notch landed inside that band, re-armed follow, and the write
// callback's scrollToBottom() yanked the viewport down again. While the CLI
// streamed output the pane could not be scrolled at all; when it was idle
// there were no writes to yank it, which is why it seemed to scroll only
// "when it isn't working".
//
// `deltaFromBottom` is the change in `fromBottom` since the previous event,
// positive when the viewport moved UP the buffer. Using that instead of raw
// viewportY makes one thing disambiguable: when xterm trims the top of the
// scrollback, both viewportY and baseY drop together, fromBottom does not
// change, and the event must not count as user intent.
export const REJOIN_ROWS = 3;

/**
 * @param {object} p
 * @param {boolean} p.follow          current follow state
 * @param {number}  p.fromBottom      rows between the viewport and the bottom
 *                                    of the scrolled-out buffer
 *                                    (baseY - viewportY)
 * @param {number}  [p.deltaFromBottom] change in fromBottom this event
 *                                    (positive = viewport moved up)
 * @param {boolean} [p.wheelUp]       this event is a wheel-up gesture
 * @param {boolean} [p.hasScrollback] the buffer has rows above the viewport
 * @returns {boolean} whether to follow the bottom
 */
export function nextFollow({
  follow,
  fromBottom,
  deltaFromBottom = 0,
  wheelUp = false,
  hasScrollback = true,
}) {
  // An explicit upward gesture detaches — but only if there is history to
  // read. In a full-screen TUI (no scrollback) a wheel-up means nothing and
  // must not strand the pane off the bottom forever. The check is on the
  // buffer, not on the current position: a wheel-up from the very bottom has
  // fromBottom === 0 at the moment the event fires (the viewport has not
  // moved yet), and that is exactly the gesture that must detach.
  if (wheelUp) return hasScrollback ? false : follow;

  // There is no "above" to be reading: whatever the state, the bottom is
  // where output appears, so re-attach.
  if (fromBottom <= 0) return true;

  // Re-attach only on a deliberate push DOWN into the bottom band. Position
  // alone is not enough (that was the bug), and upward or output-growth
  // movement while detached must leave the reader where they are.
  if (!follow && deltaFromBottom < 0 && fromBottom <= REJOIN_ROWS) return true;

  return follow;
}
