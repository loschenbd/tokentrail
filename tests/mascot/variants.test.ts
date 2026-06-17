import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { variants, BEND_DXS, BEND_DYS, CENTER_INDEX } from '../../src/mascot/variants.js';

describe('variants', () => {
  test('returns exactly 15 entries', () => {
    assert.equal(variants().length, 15);
  });

  test('covers the full 5×3 bend grid with no duplicates', () => {
    const seen = new Set<string>();
    for (const v of variants()) {
      const key = `${v.bend.dx}|${v.bend.dy}`;
      assert.equal(seen.has(key), false, `duplicate bend ${key}`);
      seen.add(key);
    }
    assert.equal(seen.size, 15);
    for (const dx of BEND_DXS) for (const dy of BEND_DYS) {
      assert.equal(seen.has(`${dx}|${dy}`), true, `missing bend ${dx}|${dy}`);
    }
  });

  test('every entry has a non-empty svg', () => {
    for (const v of variants()) assert.match(v.svg, /^<svg/);
  });

  test('CENTER_INDEX points to bend (0, 0)', () => {
    const vs = variants();
    assert.equal(vs[CENTER_INDEX].bend.dx, 0);
    assert.equal(vs[CENTER_INDEX].bend.dy, 0);
  });

  test('order is iy * 5 + ix (rows first, then columns)', () => {
    const vs = variants();
    assert.deepEqual(vs[0].bend, { dx: -1.0, dy: -1.0 });
    assert.deepEqual(vs[4].bend, { dx:  1.0, dy: -1.0 });
    assert.deepEqual(vs[5].bend, { dx: -1.0, dy:  0   });
    assert.deepEqual(vs[14].bend, { dx: 1.0, dy:  1.0 });
  });
});
