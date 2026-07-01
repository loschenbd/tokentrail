import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  colorFor,
  colorForProject,
  resolveProjectColors,
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

test('colorForProject returns a valid hex color', () => {
  const c = colorForProject('tokentrail');
  assert.match(c, /^#[0-9a-f]{6}$/i);
});

test('colorForProject returns OTHER_COLOR for the __other__ sentinel', () => {
  assert.equal(colorForProject(OTHER_KEY), OTHER_COLOR);
});

test('resolveProjectColors returns a unique color per key', () => {
  const keys = ['archi', 'tokentrail', 'malslp', 'benjaminloschen', 'mudandsilicon',
                'imessage-history', 'gemify-universal', 'pm-os', 'projects', 'job-search',
                'ben-skylar', 'blogs'];
  const map = resolveProjectColors(keys);
  const picks = new Set(Object.values(map));
  assert.equal(picks.size, keys.length, `expected ${keys.length} unique colors, got ${picks.size}`);
});

test('resolveProjectColors preserves OTHER_COLOR for the sentinel', () => {
  const map = resolveProjectColors([OTHER_KEY, 'archi']);
  assert.equal(map[OTHER_KEY], OTHER_COLOR);
});
