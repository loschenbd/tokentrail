import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  colorFor,
  colorForProject,
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

test('colorForProject is deterministic', () => {
  const a = colorForProject('archi');
  const b = colorForProject('archi');
  assert.equal(a, b);
});

test('colorForProject returns a value from PALETTE', () => {
  const c = colorForProject('tokentrail');
  assert.ok(PALETTE.includes(c), `expected ${c} to be in PALETTE`);
});

test('colorForProject and colorFor have independent keyspaces', () => {
  // Not strictly guaranteed by contract (they COULD collide for a specific
  // slug), but for a broad sample the two mappings should differ often.
  const keys = ['a','b','c','d','e','f','archi','tokentrail','malslp'];
  const featurePicks = keys.map(colorFor);
  const projectPicks = keys.map(colorForProject);
  // At least one slug picks a different colour under the two functions.
  const diffs = keys.filter((_, i) => featurePicks[i] !== projectPicks[i]);
  assert.ok(diffs.length > 0, 'expected at least one key to differ');
});
