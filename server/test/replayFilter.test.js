// Replay filter: strip terminal *queries* from scrollback, keep everything else.
//
// The danger being tested: a replayed query makes xterm.js emit an answer,
// which the client would forward to the CLI as keyboard input (stray ESCs →
// Claude Code aborts its in-flight request). The filter must remove exactly
// the query forms xterm.js answers, and must not touch visible output, colors,
// or mode-setting sequences — replay still has to reproduce terminal state.
//
// Run with: node --test server/test/
import assert from 'node:assert/strict';
import test from 'node:test';

import { stripTerminalQueries } from '../src/replayFilter.js';

const ESC = '\x1b';
const BEL = '\x07';
const ST = `${ESC}\\`;

test('strips device attribute queries (DA1/DA2/DA3)', () => {
  assert.equal(stripTerminalQueries(`a${ESC}[cb`), 'ab');
  assert.equal(stripTerminalQueries(`a${ESC}[0cb`), 'ab');
  assert.equal(stripTerminalQueries(`a${ESC}[>cb`), 'ab');
  assert.equal(stripTerminalQueries(`a${ESC}[=cb`), 'ab');
});

test('strips status and cursor position reports (DSR/CPR)', () => {
  assert.equal(stripTerminalQueries(`a${ESC}[5nb`), 'ab');
  assert.equal(stripTerminalQueries(`a${ESC}[6nb`), 'ab');
  assert.equal(stripTerminalQueries(`a${ESC}[?6nb`), 'ab'); // DECXCPR
});

test('strips DECRQM mode queries', () => {
  // Claude Code probes synchronized-output support on every launch.
  assert.equal(stripTerminalQueries(`a${ESC}[?2026$pb`), 'ab');
  assert.equal(stripTerminalQueries(`a${ESC}[4$pb`), 'ab'); // ANSI form
});

test('strips XTWINOPS report requests but keeps window commands', () => {
  assert.equal(stripTerminalQueries(`a${ESC}[14tb`), 'ab');
  assert.equal(stripTerminalQueries(`a${ESC}[14;2tb`), 'ab');
  assert.equal(stripTerminalQueries(`a${ESC}[16tb`), 'ab');
  assert.equal(stripTerminalQueries(`a${ESC}[18tb`), 'ab');
  assert.equal(stripTerminalQueries(`a${ESC}[21tb`), 'ab');
  // Resize / title push are commands, not queries — must survive.
  assert.equal(stripTerminalQueries(`${ESC}[8;54;213t`), `${ESC}[8;54;213t`);
  assert.equal(stripTerminalQueries(`${ESC}[22;0t`), `${ESC}[22;0t`);
});

test('strips kitty keyboard query but keeps push/pop', () => {
  assert.equal(stripTerminalQueries(`a${ESC}[?ub`), 'ab');
  assert.equal(stripTerminalQueries(`${ESC}[>1u`), `${ESC}[>1u`);
  assert.equal(stripTerminalQueries(`${ESC}[<u`), `${ESC}[<u`);
});

test('strips XTVERSION but keeps cursor style', () => {
  assert.equal(stripTerminalQueries(`a${ESC}[>qb`), 'ab');
  assert.equal(stripTerminalQueries(`a${ESC}[>0qb`), 'ab');
  assert.equal(stripTerminalQueries(`${ESC}[2 q`), `${ESC}[2 q`);
});

test('strips OSC color queries but keeps color sets and titles', () => {
  assert.equal(stripTerminalQueries(`a${ESC}]11;?${BEL}b`), 'ab');
  assert.equal(stripTerminalQueries(`a${ESC}]10;?${ST}b`), 'ab');
  assert.equal(stripTerminalQueries(`a${ESC}]4;256;?${BEL}b`), 'ab');
  // Setting a color / the title is not a query.
  assert.equal(stripTerminalQueries(`${ESC}]11;#ffffff${BEL}`), `${ESC}]11;#ffffff${BEL}`);
  assert.equal(stripTerminalQueries(`${ESC}]0;my title${BEL}`), `${ESC}]0;my title${BEL}`);
  // OSC 110/111 (reset color) must not be misread as a 10/11 query.
  assert.equal(stripTerminalQueries(`${ESC}]111${BEL}`), `${ESC}]111${BEL}`);
});

test('strips DECRQSS and XTGETTCAP but keeps other DCS payloads', () => {
  assert.equal(stripTerminalQueries(`a${ESC}P$qm${ST}b`), 'ab');
  assert.equal(stripTerminalQueries(`a${ESC}P+q544e${ST}b`), 'ab');
  // Sixel-style DCS is not a query; leave it alone.
  assert.equal(stripTerminalQueries(`${ESC}P0;0;8q#0${ST}`), `${ESC}P0;0;8q#0${ST}`);
});

test('keeps ordinary TUI output untouched', () => {
  const frame =
    `${ESC}[?2004h${ESC}[?1004h${ESC}[?2026h` + // mode sets survive
    `${ESC}[38;5;196mred${ESC}[0m 中文 ` +
    `${ESC}[2J${ESC}[H${ESC}[1;1Hprompt> `;
  assert.equal(stripTerminalQueries(frame), frame);
});

test('removes an interleaved startup query volley, preserving the rest', () => {
  const out =
    `boot ${ESC}[c${ESC}[?2026$p${ESC}]11;?${BEL}${ESC}[6n` +
    `${ESC}[38;2;10;20;30mready${ESC}[0m`;
  assert.equal(
    stripTerminalQueries(out),
    `boot ${ESC}[38;2;10;20;30mready${ESC}[0m`
  );
});

test('handles empty and null snapshots', () => {
  assert.equal(stripTerminalQueries(''), '');
  assert.equal(stripTerminalQueries(null), null);
});
