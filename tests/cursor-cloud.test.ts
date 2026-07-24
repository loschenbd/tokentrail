import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseUsageSummary,
  fetchUsageSummary,
  sumMeteredUsd,
  fetchMeteredUsd,
} from '../src/services/cursor-cloud.js';

describe('parseUsageSummary', () => {
  test('maps the confirmed usage-summary shape', () => {
    const out = parseUsageSummary({
      billingCycleStart: '2026-07-22T23:42:23.613Z',
      billingCycleEnd: '2026-08-22T23:42:23.613Z',
      membershipType: 'pro',
      individualUsage: {
        plan: { used: 3, limit: 500, remaining: 497, totalPercentUsed: 0.6 },
        onDemand: { enabled: false, used: 0, limit: null, remaining: null },
      },
    });
    assert.equal(out.membershipType, 'pro');
    assert.equal(out.planUsed, 3);
    assert.equal(out.planLimit, 500);
    assert.equal(out.planPctUsed, 0.6);
    assert.equal(out.ondemandEnabled, false);
    assert.equal(out.cycleStart, '2026-07-22T23:42:23.613Z');
  });
  test('garbage -> all null, no throw', () => {
    const out = parseUsageSummary(null);
    assert.equal(out.membershipType, null);
    assert.equal(out.planUsed, null);
  });
});

describe('sumMeteredUsd', () => {
  const cycleStartMs = 1000;
  test('sums chargedCents for events at/after cycle start, stops when older', () => {
    const events = [
      { timestamp: '3000', chargedCents: 950 },   // $9.50
      { timestamp: '2000', chargedCents: 50 },    // $0.50
      { timestamp: '500',  chargedCents: 999 },   // before cycle -> excluded, signals reachedCycleStart
    ];
    const r = sumMeteredUsd(events, cycleStartMs);
    assert.equal(r.usd, 10);           // 9.50 + 0.50
    assert.equal(r.scanned, 2);
    assert.equal(r.reachedCycleStart, true);
  });
  test('no pre-cycle event -> reachedCycleStart false', () => {
    const r = sumMeteredUsd([{ timestamp: '3000', chargedCents: 100 }], cycleStartMs);
    assert.equal(r.usd, 1);
    assert.equal(r.reachedCycleStart, false);
  });
});

describe('fetch*', () => {
  test('fetchUsageSummary returns null on non-200', async () => {
    const f = (async () => new Response('x', { status: 401 })) as unknown as typeof fetch;
    assert.equal(await fetchUsageSummary('c', f), null);
  });
  test('fetchMeteredUsd paginates until it reaches cycle start', async () => {
    const page1 = { totalUsageEventsCount: 3, usageEventsDisplay: [
      { timestamp: '3000', chargedCents: 100 }, { timestamp: '2500', chargedCents: 100 }] };
    const page2 = { totalUsageEventsCount: 3, usageEventsDisplay: [
      { timestamp: '2000', chargedCents: 100 }, { timestamp: '500', chargedCents: 999 }] };
    let call = 0;
    const f = (async () => new Response(JSON.stringify(call++ === 0 ? page1 : page2),
      { status: 200 })) as unknown as typeof fetch;
    const out = await fetchMeteredUsd('c', 1000, f);
    assert.equal(out?.usd, 3);         // 3 in-cycle events x $1.00
    assert.equal(out?.truncated, false);
    assert.equal(out?.eventsTotal, 3);
  });
});
