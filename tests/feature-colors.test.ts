import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  colorFor,
  PALETTE,
  OTHER_KEY,
  OTHER_COLOR,
  UNCATEGORIZED_KEY,
  STRIPED_SENTINEL,
} from '../src/dashboard/lib/feature-colors.js';

describe('colorFor', () => {
  test('returns Other color for __other__ sentinel', () => {
    assert.equal(colorFor(OTHER_KEY), OTHER_COLOR);
  });

  test('returns striped sentinel for uncategorized-mainline', () => {
    assert.equal(colorFor(UNCATEGORIZED_KEY), STRIPED_SENTINEL);
  });

  test('returns a palette color for a real feature key', () => {
    const c = colorFor('menubar');
    assert.ok(PALETTE.includes(c), `expected ${c} in palette`);
  });

  test('is deterministic for the same key', () => {
    assert.equal(colorFor('menubar'), colorFor('menubar'));
    assert.equal(colorFor('ingest'), colorFor('ingest'));
  });

  test('returns different colors for likely-different keys (no universal collision)', () => {
    const seen = new Set<string>();
    for (const key of ['menubar', 'ingest', 'rollup', 'enrich', 'dashboard', 'infer-mainline']) {
      seen.add(colorFor(key));
    }
    // 6 keys against an 8-color palette — at least 4 distinct colors is a reasonable floor.
    assert.ok(seen.size >= 4, `only ${seen.size} distinct colors among 6 keys`);
  });

  test('PALETTE has exactly 8 entries (Okabe-Ito qualitative)', () => {
    assert.equal(PALETTE.length, 8);
  });

  test('returns a palette color even for an empty string (defensive)', () => {
    const c = colorFor('');
    assert.ok(PALETTE.includes(c));
  });
});
