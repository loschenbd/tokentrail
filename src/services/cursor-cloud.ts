import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type DatabaseType from 'better-sqlite3';
import { getConfig } from '../lib/config.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof DatabaseType;

const USAGE_SUMMARY_URL = 'https://cursor.com/api/usage-summary';
const EVENTS_URL = 'https://cursor.com/api/dashboard/get-filtered-usage-events';
const MAX_PAGES = 200;       // safety cap; matches CodexBar. Truncation is flagged, never silent.

export type CursorUtilization = {
  cycleStart: string | null; cycleEnd: string | null; membershipType: string | null;
  planUsed: number | null; planLimit: number | null; planPctUsed: number | null;
  ondemandEnabled: boolean | null; ondemandUsed: number | null;
};
export type CursorMetered = { usd: number; eventsScanned: number; eventsTotal: number; truncated: boolean };

function stateDbPath(): string {
  const override = getConfig().cursorStateDbPath;
  if (override) return override;
  return join(homedir(), 'Library', 'Application Support', 'Cursor',
    'User', 'globalStorage', 'state.vscdb');
}

function jwtSub(jwt: string): string | null {
  try {
    const payload = jwt.split('.')[1];
    if (!payload) return null;
    const json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof json.sub === 'string' ? json.sub : null;
  } catch { return null; }
}

// Cookie = "<sub>::<jwt>". Manual config cookie wins (already composed).
export function deriveSessionCookie(): string | null {
  const manual = getConfig().cursorSessionCookie;
  if (manual) return manual;
  const path = stateDbPath();
  if (!existsSync(path)) return null;
  let db: DatabaseType.Database | null = null;
  try {
    db = new Database(path, { readonly: true, fileMustExist: true });
    const row = db.prepare("SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken'")
      .get() as { value: string } | undefined;
    const jwt = row?.value;
    if (!jwt) return null;
    const sub = jwtSub(jwt);
    if (!sub) return null;
    return `${sub}::${jwt}`;
  } catch (err) {
    console.warn(`Cursor: could not read session token (${(err as Error).message}).`);
    return null;
  } finally { db?.close(); }
}

function num(v: unknown): number | null {
  const n = Number(v); return Number.isFinite(n) ? n : null;
}

export function parseUsageSummary(json: unknown): CursorUtilization {
  const empty: CursorUtilization = {
    cycleStart: null, cycleEnd: null, membershipType: null, planUsed: null,
    planLimit: null, planPctUsed: null, ondemandEnabled: null, ondemandUsed: null };
  if (typeof json !== 'object' || json === null) return empty;
  const o = json as Record<string, any>;
  const plan = o.individualUsage?.plan ?? {};
  const od = o.individualUsage?.onDemand ?? {};
  return {
    cycleStart: typeof o.billingCycleStart === 'string' ? o.billingCycleStart : null,
    cycleEnd: typeof o.billingCycleEnd === 'string' ? o.billingCycleEnd : null,
    membershipType: typeof o.membershipType === 'string' ? o.membershipType : null,
    planUsed: num(plan.used), planLimit: num(plan.limit), planPctUsed: num(plan.totalPercentUsed),
    ondemandEnabled: typeof od.enabled === 'boolean' ? od.enabled : null,
    ondemandUsed: num(od.used),
  };
}

export async function fetchUsageSummary(
  cookie: string, fetchImpl: typeof fetch = fetch
): Promise<CursorUtilization | null> {
  try {
    const res = await fetchImpl(USAGE_SUMMARY_URL, {
      headers: { Cookie: `WorkosCursorSessionToken=${cookie}`, Origin: 'https://cursor.com' } });
    if (!res.ok) { console.warn(`Cursor: usage-summary ${res.status}.`); return null; }
    return parseUsageSummary(await res.json());
  } catch (err) { console.warn(`Cursor: usage-summary failed (${(err as Error).message}).`); return null; }
}

// Sum chargedCents (as USD) over events newer-or-equal to cycleStartMs.
// Events arrive newest-first; the first event older than cycleStart means we
// have seen the whole current cycle -> reachedCycleStart=true (stop paging).
export function sumMeteredUsd(
  events: unknown[], cycleStartMs: number
): { usd: number; scanned: number; reachedCycleStart: boolean } {
  let cents = 0, scanned = 0, reached = false;
  for (const e of events) {
    if (typeof e !== 'object' || e === null) continue;
    const o = e as Record<string, any>;
    const ts = Number(o.timestamp);
    if (Number.isFinite(ts) && ts < cycleStartMs) { reached = true; break; }
    const c = Number(o.chargedCents);
    if (Number.isFinite(c)) cents += c;
    scanned++;
  }
  return { usd: Math.round(cents) / 100, scanned, reachedCycleStart: reached };
}

export async function fetchMeteredUsd(
  cookie: string, cycleStartMs: number, fetchImpl: typeof fetch = fetch
): Promise<CursorMetered | null> {
  let usd = 0, scanned = 0, total = 0, truncated = false;
  let prevFirstTs: string | null = null;
  try {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await fetchImpl(EVENTS_URL, {
        method: 'POST',
        headers: { Cookie: `WorkosCursorSessionToken=${cookie}`, Origin: 'https://cursor.com',
          'Content-Type': 'application/json' },
        body: JSON.stringify({ page }),
      });
      if (!res.ok) { console.warn(`Cursor: usage-events ${res.status}.`); return page === 1 ? null : { usd, eventsScanned: scanned, eventsTotal: total, truncated: true }; }
      const body = (await res.json()) as Record<string, any>;
      total = Number(body.totalUsageEventsCount) || total;
      const events: unknown[] = Array.isArray(body.usageEventsDisplay) ? body.usageEventsDisplay : [];
      if (events.length === 0) break;
      // Pagination-unsupported guard: if page N returns the same first event as
      // page N-1, the `page` param is not honored -> stop and flag truncated.
      const firstTs = (events[0] as any)?.timestamp ?? null;
      if (page > 1 && firstTs === prevFirstTs) { truncated = true; break; }
      prevFirstTs = firstTs;
      const r = sumMeteredUsd(events, cycleStartMs);
      usd += r.usd; scanned += r.scanned;
      if (r.reachedCycleStart) return { usd: round2(usd), eventsScanned: scanned, eventsTotal: total, truncated: false };
      // Otherwise keep paginating — a genuinely-last real page is caught by
      // the empty-page check above on the next iteration. Don't guess "last
      // page" from a short page: pagination page sizes aren't guaranteed.
      if (page === MAX_PAGES) truncated = true;
    }
    return { usd: round2(usd), eventsScanned: scanned, eventsTotal: total, truncated };
  } catch (err) {
    console.warn(`Cursor: usage-events failed (${(err as Error).message}).`);
    return scanned > 0 ? { usd: round2(usd), eventsScanned: scanned, eventsTotal: total, truncated: true } : null;
  }
}

function round2(n: number): number { return Math.round(n * 100) / 100; }
