import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ClaudeLimitsMonitor,
  parseCredentials,
  parseUsage,
  planLabel,
  type ClaudeCredentials,
} from '../src/services/claude-limits.js';

// Trimmed from a real /api/oauth/usage response (2026-10-22).
const USAGE = {
  five_hour: { utilization: 12.0, resets_at: '2026-10-22T19:40:00.162905+00:00' },
  seven_day: { utilization: 19.0, resets_at: '2026-10-26T09:00:00.162929+00:00' },
  seven_day_opus: null,
  seven_day_sonnet: null,
  limits: [
    { kind: 'session', group: 'session', percent: 12, severity: 'normal',
      resets_at: '2026-10-22T19:40:00.162905+00:00', scope: null, is_active: false },
    { kind: 'weekly_all', group: 'weekly', percent: 19, severity: 'normal',
      resets_at: '2026-10-26T09:00:00.162929+00:00', scope: null, is_active: true },
    { kind: 'weekly_scoped', group: 'weekly', percent: 1, severity: 'normal',
      resets_at: '2026-10-26T09:00:00.163140+00:00',
      scope: { model: { id: null, display_name: 'Fable' }, surface: null }, is_active: false },
  ],
};

describe('parseUsage', () => {
  test('reads the session, weekly and per-model windows from `limits`', () => {
    const u = parseUsage(USAGE)!;
    assert.deepEqual(u.session, { label: '5-hour', pct: 12, resetsAt: '2026-10-22T19:40:00.162Z', severity: 'normal' });
    assert.deepEqual(u.weekly, { label: 'Weekly', pct: 19, resetsAt: '2026-10-26T09:00:00.162Z', severity: 'normal' });
    assert.deepEqual(u.models, [{ label: 'Fable', pct: 1, resetsAt: '2026-10-26T09:00:00.163Z', severity: 'normal' }]);
  });

  test('falls back to five_hour / seven_day when `limits` is absent', () => {
    const u = parseUsage({
      five_hour: { utilization: 40, resets_at: '2026-10-22T19:40:00Z' },
      seven_day: { utilization: 55.5, resets_at: '2026-10-26T09:00:00Z' },
      seven_day_opus: { utilization: 70, resets_at: '2026-10-26T09:00:00Z' },
      seven_day_sonnet: null,
    })!;
    assert.equal(u.session?.pct, 40);
    assert.equal(u.weekly?.pct, 55.5);
    assert.deepEqual(u.models.map((m) => [m.label, m.pct]), [['Opus', 70]]);
    assert.equal(u.session?.severity, null);
  });

  test('returns null when neither window is present', () => {
    assert.equal(parseUsage({}), null);
    assert.equal(parseUsage(null), null);
    assert.equal(parseUsage({ limits: [{ kind: 'something_new', percent: 3 }] }), null);
  });
});

describe('planLabel', () => {
  test('names Max tiers by multiplier', () => {
    assert.equal(planLabel('max', 'default_claude_max_20x'), 'Max 20x');
    assert.equal(planLabel('max', 'default_claude_max_5x'), 'Max 5x');
    assert.equal(planLabel('max', null), 'Max');
  });
  test('capitalizes other plans and drops empties', () => {
    assert.equal(planLabel('pro', 'default_claude_ai'), 'Pro');
    assert.equal(planLabel('team', null), 'Team');
    assert.equal(planLabel(null, null), null);
    assert.equal(planLabel('', ''), null);
  });
});

describe('parseCredentials', () => {
  test('reads the claudeAiOauth entry', () => {
    const raw = JSON.stringify({
      mcpOAuth: { x: { accessToken: 'not-this-one' } },
      claudeAiOauth: { accessToken: 'tok', refreshToken: 'r', expiresAt: 1_800_000_000_000,
        subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' },
    });
    assert.deepEqual(parseCredentials(raw), { accessToken: 'tok', expiresAt: 1_800_000_000_000, plan: 'Max 20x' });
  });
  test('null for API-key setups, missing tokens and junk', () => {
    assert.equal(parseCredentials(JSON.stringify({ mcpOAuth: {} })), null);
    assert.equal(parseCredentials(JSON.stringify({ claudeAiOauth: { expiresAt: 1 } })), null);
    assert.equal(parseCredentials('not json'), null);
  });
});

describe('ClaudeLimitsMonitor', () => {
  const T0 = Date.parse('2026-10-22T17:00:00Z');
  const CREDS: ClaudeCredentials = { accessToken: 'tok', expiresAt: T0 + 4 * 3600_000, plan: 'Max 20x' };

  function harness(opts: {
    creds?: ClaudeCredentials | null;
    responses?: Array<{ status: number; body?: unknown; retryAfter?: string }>;
  } = {}) {
    let now = T0;
    let creds: ClaudeCredentials | null = opts.creds === undefined ? CREDS : opts.creds;
    const responses = [...(opts.responses ?? [{ status: 200, body: USAGE }])];
    const calls: Array<{ url: string; auth: string | null; beta: string | null }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const h = new Headers(init?.headers);
      calls.push({ url, auth: h.get('authorization'), beta: h.get('anthropic-beta') });
      const r = responses.length > 1 ? responses.shift()! : responses[0]!;
      if (r.status === 0) throw new TypeError('fetch failed');
      const headers = new Headers(r.retryAfter ? { 'retry-after': r.retryAfter } : {});
      return new Response(JSON.stringify(r.body ?? {}), { status: r.status, headers });
    }) as typeof fetch;
    const monitor = new ClaudeLimitsMonitor({
      readCredentials: async () => creds,
      fetchImpl,
      now: () => now,
      log: () => {},
    });
    return {
      monitor, calls,
      advance: (ms: number) => { now += ms; },
      setCreds: (c: ClaudeCredentials | null) => { creds = c; },
    };
  }

  test('first snapshot waits for the fetch and sends the OAuth headers', async () => {
    const h = harness();
    const s = await h.monitor.snapshot();
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0]!.url, 'https://api.anthropic.com/api/oauth/usage');
    assert.equal(h.calls[0]!.auth, 'Bearer tok');
    assert.equal(h.calls[0]!.beta, 'oauth-2025-04-20');
    assert.equal(s?.plan, 'Max 20x');
    assert.equal(s?.session?.pct, 12);
    assert.equal(s?.weekly?.pct, 19);
    assert.equal(s?.stale, false);
    assert.equal(s?.note, null);
    assert.equal(s?.fetchedAt, new Date(T0).toISOString());
  });

  test('refreshes only on tick, once the interval has passed', async () => {
    const h = harness();
    await h.monitor.snapshot();
    h.advance(60_000);
    await h.monitor.tick();
    assert.equal(h.calls.length, 1, 'no refetch inside the interval');
    h.advance(3 * 60_000);
    await h.monitor.snapshot();
    assert.equal(h.calls.length, 1, 'reading a snapshot never fetches after the first');
    await h.monitor.tick();
    assert.equal(h.calls.length, 2);
    assert.equal((await h.monitor.snapshot())?.fetchedAt, new Date(T0 + 4 * 60_000).toISOString());
  });

  test('a slow first refresh does not hold up the snapshot', async () => {
    let release!: () => void;
    const monitor = new ClaudeLimitsMonitor({
      readCredentials: async () => { await new Promise<void>((r) => { release = r; }); return CREDS; },
      fetchImpl: (async () => new Response(JSON.stringify(USAGE))) as typeof fetch,
      now: () => T0,
      log: () => {},
    });
    const t = Date.now();
    assert.equal(await monitor.snapshot(), null);
    assert.ok(Date.now() - t < 2000, 'returns within the menu bar timeout');
    release();
    await monitor.tick();
    assert.equal((await monitor.snapshot())?.weekly?.pct, 19);
  });

  test('null when there is no Claude subscription login', async () => {
    const h = harness({ creds: null });
    assert.equal(await h.monitor.snapshot(), null);
    assert.equal(h.calls.length, 0);
  });

  test('expired token: no fetch, keeps the last numbers and marks them stale', async () => {
    const h = harness();
    await h.monitor.snapshot();
    h.setCreds({ ...CREDS, expiresAt: T0 + 60_000 });
    h.advance(5 * 60_000);
    await h.monitor.tick();
    const s = await h.monitor.snapshot();
    assert.equal(h.calls.length, 1, 'never calls Anthropic with an expired token');
    assert.equal(s?.stale, true);
    assert.equal(s?.session?.pct, 12);
    assert.match(s?.note ?? '', /expired/i);
  });

  test('429: backs off for at least ten minutes and honors a longer Retry-After', async () => {
    const h = harness({ responses: [{ status: 200, body: USAGE }, { status: 429, retryAfter: '1200' }, { status: 200, body: USAGE }] });
    await h.monitor.snapshot();
    h.advance(3 * 60_000);
    await h.monitor.tick();
    const s = await h.monitor.snapshot();
    assert.equal(s?.stale, true);
    assert.equal(s?.session?.pct, 12);
    h.advance(15 * 60_000);
    await h.monitor.tick();
    assert.equal(h.calls.length, 2, 'still inside the 20-minute Retry-After');
    h.advance(6 * 60_000);
    await h.monitor.tick();
    assert.equal(h.calls.length, 3);
    assert.equal((await h.monitor.snapshot())?.stale, false);
  });

  test('network failure: retries after a minute', async () => {
    const h = harness({ responses: [{ status: 200, body: USAGE }, { status: 0 }, { status: 200, body: USAGE }] });
    await h.monitor.snapshot();
    h.advance(3 * 60_000);
    await h.monitor.tick();
    assert.equal((await h.monitor.snapshot())?.stale, true);
    h.advance(30_000);
    await h.monitor.tick();
    assert.equal(h.calls.length, 2);
    h.advance(30_000);
    await h.monitor.tick();
    assert.equal(h.calls.length, 3);
    assert.equal((await h.monitor.snapshot())?.stale, false);
  });

  test('401: stops using that token until Claude Code saves a new one', async () => {
    const h = harness({ responses: [{ status: 401 }] });
    const s = await h.monitor.snapshot();
    assert.equal(s?.stale, true);
    assert.equal(s?.session, null);
    assert.equal(s?.fetchedAt, null);
    h.advance(5 * 60_000);
    await h.monitor.tick();
    assert.equal(h.calls.length, 1, 'same rejected token is not retried');
    h.setCreds({ ...CREDS, accessToken: 'tok2' });
    h.advance(2 * 60_000);
    await h.monitor.tick();
    assert.equal(h.calls.length, 2);
  });

  test('a window whose reset time has passed reads as 0%', async () => {
    const h = harness({ responses: [{ status: 200, body: USAGE }, { status: 500 }] });
    await h.monitor.snapshot();
    // Past the 5-hour reset (19:40Z), with every refresh since failing.
    h.advance(3 * 3600_000);
    await h.monitor.tick();
    const s = await h.monitor.snapshot();
    assert.equal(s?.stale, true);
    assert.deepEqual(s?.session, { label: '5-hour', pct: 0, resetsAt: null, severity: null });
    assert.equal(s?.weekly?.pct, 19);
  });

  test('a credentials read that throws is treated as no login', async () => {
    const monitor = new ClaudeLimitsMonitor({
      readCredentials: async () => { throw new Error('keychain locked'); },
      fetchImpl: (async () => { throw new Error('unreachable'); }) as typeof fetch,
      now: () => T0,
      log: () => {},
    });
    assert.equal(await monitor.snapshot(), null);
  });
});
