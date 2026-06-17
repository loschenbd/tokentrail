import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { rasterizeSvgToChars, DENSITY_CHARS } from '../../src/mascot/rasterize.js';

const ALLOWED_CHARS = new Set([' ', '·', '¤', '◐', '◑', '●']);

function allBlackSvg(): string {
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 120" width="60" height="120"><rect x="0" y="0" width="60" height="120" fill="#000"/></svg>';
}
function emptySvg(): string {
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 120" width="60" height="120"></svg>';
}
function halfBlackSvg(): string {
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 120" width="60" height="120"><rect x="0" y="0" width="30" height="120" fill="#000"/></svg>';
}

describe('rasterizeSvgToChars', () => {
  test('all-black SVG → every cell is the full coin char ●', () => {
    const grid = rasterizeSvgToChars(allBlackSvg(), { cols: 10, rows: 4 });
    assert.equal(grid.length, 4);
    for (const row of grid) {
      assert.equal(row.length, 10);
      for (const ch of row) assert.equal(ch, DENSITY_CHARS.full);
    }
  });

  test('empty SVG → grid trimmed to zero rows (all rows were all-space)', () => {
    const grid = rasterizeSvgToChars(emptySvg(), { cols: 10, rows: 4 });
    assert.equal(grid.length, 0);
  });

  test('half-black SVG → left half cells are ●, right half cells are space', () => {
    const grid = rasterizeSvgToChars(halfBlackSvg(), { cols: 10, rows: 4 });
    assert.equal(grid.length, 4);
    for (const row of grid) {
      for (let i = 0; i < 5; i++) assert.equal(row[i], DENSITY_CHARS.full, `col ${i} should be full`);
      for (let i = 5; i < 10; i++) assert.equal(row[i], ' ', `col ${i} should be space`);
    }
  });

  test('output uses only the allowed character set', () => {
    const grid = rasterizeSvgToChars(halfBlackSvg(), { cols: 10, rows: 4 });
    for (const row of grid) for (const ch of row) {
      assert.equal(ALLOWED_CHARS.has(ch), true, `unexpected char "${ch}"`);
    }
  });
});
