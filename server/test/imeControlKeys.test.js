// imeControlKeys lives in web/src (it feeds xterm's custom key handler), but it
// is a pure function over KeyboardEvent-shaped objects with no DOM dependency,
// and this is the repo's only node --test harness — so it is exercised here.
//
// The event shapes below are what Chrome delivers with a CJK IME (Sogou, Apple
// Pinyin, MS Korean...) active: keyCode 229 / key "Process" in place of the real
// key, with the physical `code` intact. See xtermjs/xterm.js#6065.
import test from 'node:test';
import assert from 'node:assert/strict';
import { imeMaskedControlByte } from '../../web/src/imeControlKeys.js';

const masked = (code, mods = {}) => ({ keyCode: 229, key: 'Process', code, ...mods });

test('recovers Ctrl+letter chords the IME masked with keyCode 229', () => {
  assert.equal(imeMaskedControlByte(masked('KeyO', { ctrlKey: true })), '\x0f'); // claude: transcript
  assert.equal(imeMaskedControlByte(masked('KeyE', { ctrlKey: true })), '\x05'); // claude: show all
  assert.equal(imeMaskedControlByte(masked('KeyC', { ctrlKey: true })), '\x03');
  assert.equal(imeMaskedControlByte(masked('KeyA', { ctrlKey: true })), '\x01');
  assert.equal(imeMaskedControlByte(masked('KeyZ', { ctrlKey: true })), '\x1a');
});

test('recovers Ctrl+Space and a bare Escape', () => {
  assert.equal(imeMaskedControlByte(masked('Space', { ctrlKey: true })), '\x00');
  assert.equal(imeMaskedControlByte(masked('Escape')), '\x1b');
  // Escape is recovered regardless of modifiers, like a native terminal.
  assert.equal(imeMaskedControlByte(masked('Escape', { ctrlKey: true })), '\x1b');
});

test('Sogou variant: key is the letter itself but keyCode is still 229', () => {
  assert.equal(imeMaskedControlByte({ keyCode: 229, key: 'o', code: 'KeyO', ctrlKey: true }), '\x0f');
});

test('key "Process" without keyCode 229 is still treated as masked', () => {
  assert.equal(imeMaskedControlByte({ keyCode: 0, key: 'Process', code: 'KeyO', ctrlKey: true }), '\x0f');
});

test('leaves un-masked events to xterm', () => {
  // Real keyCode: xterm encodes these itself; intervening would double-send.
  assert.equal(imeMaskedControlByte({ keyCode: 79, key: 'o', code: 'KeyO', ctrlKey: true }), null);
  assert.equal(imeMaskedControlByte({ keyCode: 27, key: 'Escape', code: 'Escape' }), null);
  assert.equal(imeMaskedControlByte({ keyCode: 79, key: 'o', code: 'KeyO' }), null);
});

test('leaves composable IME keys to the composition path', () => {
  // A plain letter under the IME starts a pinyin composition — not ours.
  assert.equal(imeMaskedControlByte(masked('KeyO')), null);
  assert.equal(imeMaskedControlByte(masked('Digit1')), null);
  assert.equal(imeMaskedControlByte(masked('Space')), null);
  assert.equal(imeMaskedControlByte(masked('Comma')), null);
});

test('leaves keys pressed mid-composition to the IME', () => {
  // Esc cancels the pinyin buffer and Ctrl chords edit it; a native terminal
  // would see nothing for either, so neither may reach the PTY.
  assert.equal(imeMaskedControlByte(masked('Escape', { isComposing: true })), null);
  assert.equal(imeMaskedControlByte(masked('KeyO', { ctrlKey: true, isComposing: true })), null);
  assert.equal(imeMaskedControlByte(masked('Space', { ctrlKey: true, isComposing: true })), null);
});

test('does not claim chords with other modifiers', () => {
  assert.equal(imeMaskedControlByte(masked('KeyO', { ctrlKey: true, shiftKey: true })), null);
  assert.equal(imeMaskedControlByte(masked('KeyO', { ctrlKey: true, altKey: true })), null);
  assert.equal(imeMaskedControlByte(masked('KeyO', { ctrlKey: true, metaKey: true })), null);
  assert.equal(imeMaskedControlByte(masked('KeyO', { metaKey: true })), null); // Cmd+O
});

test('ignores ctrl chords on non-letter keys it cannot encode', () => {
  assert.equal(imeMaskedControlByte(masked('Digit1', { ctrlKey: true })), null);
  assert.equal(imeMaskedControlByte(masked('BracketLeft', { ctrlKey: true })), null);
  assert.equal(imeMaskedControlByte(masked('', { ctrlKey: true })), null);
  assert.equal(imeMaskedControlByte({ keyCode: 229, key: 'Process', ctrlKey: true }), null); // no code at all
});
