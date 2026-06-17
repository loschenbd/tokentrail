import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { renderFrame, pickFrameIndex, shouldColor } from '../../src/commands/mascot.js';
import type { FrameBundle, Frame } from '../../src/mascot/load-frames.js';

const bundle: FrameBundle = {
  cols: 3, rows: 2, centerIndex: 7,
  frames: Array.from({ length: 15 }, (_, i) => ({
    bend: { dx: 0, dy: 0 },
    grid: [['●', ' ', '·'], ['¤', '◐', '●']],
  })),
};

describe('renderFrame', () => {
  test('plain (no color) renders grid as plain text with newlines', () => {
    const frame = bundle.frames[0];
    assert(frame, 'frame should exist');
    const out = renderFrame(frame, false);
    assert.equal(out, '● ·\n¤◐●');
    assert.equal(out.includes('\x1b['), false);
  });

  test('colored renders include ANSI escape sequences', () => {
    const frame = bundle.frames[0];
    assert(frame, 'frame should exist');
    const out = renderFrame(frame, true);
    assert.equal(out.includes('\x1b[38;5;94m'), true);
    assert.equal(out.includes('\x1b[0m'), true);
  });

  test('colored output is exactly the expected ANSI sequence (verifies transitions)', () => {
    const frame = bundle.frames[0];
    assert(frame, 'frame should exist');
    const out = renderFrame(frame, true);
    const expected =
      '\x1b[38;5;94m●\x1b[0m \x1b[38;5;58m·\x1b[0m\n' +
      '\x1b[38;5;58m¤\x1b[0m\x1b[38;5;94m◐●\x1b[0m';
    assert.equal(out, expected);
  });
});

describe('pickFrameIndex', () => {
  test('forced index in range returns that index', () => {
    assert.equal(pickFrameIndex(5, bundle, new Date('2026-06-16T12:00:00Z')), 5);
  });
  test('forced index out of range falls back to centerIndex', () => {
    assert.equal(pickFrameIndex(99, bundle, new Date('2026-06-16T12:00:00Z')), bundle.centerIndex);
  });
  test('morning (hour 8) → dy=-1 → index 2 (center column of first row)', () => {
    assert.equal(pickFrameIndex(undefined, bundle, new Date('2026-06-16T08:00:00')), 2);
  });
  test('afternoon (hour 14) → dy=0 → index 7', () => {
    assert.equal(pickFrameIndex(undefined, bundle, new Date('2026-06-16T14:00:00')), 7);
  });
  test('evening (hour 20) → dy=+1 → index 12', () => {
    assert.equal(pickFrameIndex(undefined, bundle, new Date('2026-06-16T20:00:00')), 12);
  });
});

describe('shouldColor', () => {
  test('default on TTY with no flags → true', () => {
    assert.equal(shouldColor({ env: {}, isTTY: true }), true);
  });
  test('NO_COLOR env var → false', () => {
    assert.equal(shouldColor({ env: { NO_COLOR: '1' }, isTTY: true }), false);
  });
  test('--no-color flag → false', () => {
    assert.equal(shouldColor({ noColor: true, env: {}, isTTY: true }), false);
  });
  test('not a TTY → false', () => {
    assert.equal(shouldColor({ env: {}, isTTY: false }), false);
  });
});
