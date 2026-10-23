// Follow-mode policy for the terminal viewport.
//
// Regression: "while codex is working, the conversation can't be scrolled."
// Follow was re-armed on position alone (within 3 rows of the bottom) on every
// scroll event. One wheel notch is ~3 rows, so a single upward notch landed
// inside the band and the next streamed chunk's scrollToBottom() pulled the
// viewport back down. Idle, there was no output to pull it, so the pane
// seemed to scroll only "when it isn't working".
//
// followMode.js lives in web/src (it drives xterm in the browser) but is plain
// ESM with no DOM dependency; node --test is the repo's test harness, so it is
// exercised from here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { nextFollow, REJOIN_ROWS } from '../../web/src/followMode.js';

test('a wheel-up detaches follow', () => {
  assert.equal(nextFollow({ follow: true, fromBottom: 0, wheelUp: true, hasScrollback: true }), false);
});

test('a wheel-up with no scrollback does not detach', () => {
  // Full-screen TUI: there is nothing above to read, and detaching would
  // leave the pane stuck while output kept repainting.
  assert.equal(nextFollow({ follow: true, fromBottom: 0, wheelUp: true, hasScrollback: false }), true);
});

test('a detached viewport stays put while output streams', () => {
  // Output grows the buffer below the viewport: fromBottom increases.
  assert.equal(nextFollow({ follow: false, fromBottom: 40, deltaFromBottom: 5 }), false);
});

test('scrolling back down toward the bottom re-attaches', () => {
  assert.equal(nextFollow({ follow: false, fromBottom: 2, deltaFromBottom: -2 }), true);
  assert.equal(nextFollow({ follow: false, fromBottom: REJOIN_ROWS, deltaFromBottom: -1 }), true);
});

test('scrolling down but still far from the bottom does not re-attach', () => {
  assert.equal(nextFollow({ follow: false, fromBottom: 10, deltaFromBottom: -1 }), false);
});

test('position alone near the bottom does not re-attach', () => {
  // The exact bug: a stale position reading inside the band, with no
  // downward movement, must not re-arm follow.
  assert.equal(nextFollow({ follow: false, fromBottom: 2, deltaFromBottom: 0 }), false);
  assert.equal(nextFollow({ follow: false, fromBottom: 2, deltaFromBottom: 2 }), false);
});

test('dragging the scrollbar to the very bottom always re-attaches', () => {
  assert.equal(nextFollow({ follow: false, fromBottom: 0, deltaFromBottom: 0 }), true);
});

test('a reflow while following never detaches', () => {
  // A resize can strand the viewport above the bottom; follow must survive it
  // so the next write scrolls it back. Only a wheel-up detaches.
  assert.equal(nextFollow({ follow: true, fromBottom: 8, deltaFromBottom: 8 }), true);
});

test('scrollback trimming is not a scroll', () => {
  // xterm drops rows off the top: baseY and viewportY both fall, fromBottom
  // is unchanged. That must not look like downward intent.
  assert.equal(nextFollow({ follow: false, fromBottom: 20, deltaFromBottom: 0 }), false);
  assert.equal(nextFollow({ follow: true, fromBottom: 0, deltaFromBottom: 0 }), true);
});
