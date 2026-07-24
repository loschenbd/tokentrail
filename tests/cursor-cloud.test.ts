import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
  parseUsageSummary,
  fetchUsageSummary,
  sumMeteredUsd,
  fetchMeteredUsd,
} from '../src/services/cursor-cloud.js';
import { runMigrations } from '../src/db/migrations.js';
import { runCursorUsage } from '../src/commands/cursor.js';

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

const UTIL = { cycleStart: 'a', cycleEnd: 'b', membershipType: 'pro', planUsed: 3,
  planLimit: 500, planPctUsed: 0.6, ondemandEnabled: false, ondemandUsed: 0 };

test('runCursorUsage writes a fresh row folding both endpoints', async () => {
  const db = new Database(':memory:'); runMigrations(db);
  const r = await runCursorUsage(db, { cookie: 'c', util: UTIL as any,
    metered: { usd: 12.4, eventsScanned: 210, eventsTotal: 13481, truncated: false } });
  assert.equal(r, 'updated');
  const row: any = db.prepare('SELECT * FROM cursor_usage WHERE id=1').get();
  assert.equal(row.membership_type, 'pro');
  assert.equal(row.metered_usd, 12.4);
  assert.equal(row.plan_pct_used, 0.6);
  assert.equal(row.stale, 0);
});

test('runCursorUsage marks stale + keeps last-good when fetch fails', async () => {
  const db = new Database(':memory:'); runMigrations(db);
  await runCursorUsage(db, { cookie: 'c', util: UTIL as any,
    metered: { usd: 5, eventsScanned: 1, eventsTotal: 1, truncated: false } });
  const r = await runCursorUsage(db, { cookie: 'c', util: null, metered: null });
  assert.equal(r, 'stale');
  const row: any = db.prepare('SELECT metered_usd, stale FROM cursor_usage WHERE id=1').get();
  assert.equal(row.metered_usd, 5);
  assert.equal(row.stale, 1);
});

test('runCursorUsage skips with no cookie', async () => {
  const db = new Database(':memory:'); runMigrations(db);
  assert.equal(await runCursorUsage(db, { cookie: null }), 'skipped');
});
