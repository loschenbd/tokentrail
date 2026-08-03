import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { enrichmentDue } from '../src/dashboard/freshen.js';

describe('enrichmentDue (commit/PR enrichment throttle)', () => {
  const THROTTLE = 60 * 60_000; // 1h

  test('due on first run (lastAt = 0)', () => {
    assert.equal(enrichmentDue(1_000_000, 0, false, THROTTLE), true);
  });

  test('not due within the throttle window', () => {
    const now = 5_000_000;
    assert.equal(enrichmentDue(now, now - (THROTTLE - 1), false, THROTTLE), false);
  });

  test('due once a full throttle window has passed', () => {
    const now = 5_000_000;
    assert.equal(enrichmentDue(now, now - THROTTLE, false, THROTTLE), true);
  });

  test('never due while a run is in flight, even past the window', () => {
    const now = 5_000_000;
    assert.equal(enrichmentDue(now, now - THROTTLE * 3, true, THROTTLE), false);
  });
});
