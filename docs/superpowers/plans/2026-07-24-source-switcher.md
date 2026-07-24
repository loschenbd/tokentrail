# Source Switcher (native app, Middle tier) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A source switcher (All | Claude | Cursor) in the native menu-bar app with a dollars-only combined total broken out by source, made window-consistent by a lightweight per-day Cursor-cost rollup.

**Architecture:** Source A already paginates the current cycle's Cursor events; aggregate those by day into a new `cursor_daily_cost` table (no per-event store). A read helper `buildSources` combines Claude's existing windowed dollar figures with Cursor's per-day rollup into a `sources` payload on `/api/today`. The SwiftUI panel gains a segmented picker that switches which source's view renders.

**Tech Stack:** Node.js + TypeScript, better-sqlite3, `node --test` via tsx; SwiftUI (single-file `Tokentrail.swift`, no unit-test harness — verified by build + screenshot).

## Global Constraints

- Migrations run on every startup; new table via idempotent `CREATE TABLE IF NOT EXISTS` in `src/db/schema.ts` `SCHEMA_STATEMENTS` (rule #1).
- **Invariant:** Cursor dollars/lines live in Cursor-only tables and are NEVER summed into `usage_events` / token USD totals. The combined `totalUsd` is computed by explicit per-source addition in `buildSources`, never by a query over `usage_events` (rule #3 spirit; matches the Cursor spec).
- All dollar figures labeled `estimated`.
- Cursor failures are non-fatal (rule #6): missing/partial Cursor data → the `sources` payload omits the cursor entry; the switcher hides the Cursor tab. No crash, no empty tab.
- Cursor daily rollup covers only the current billing cycle (all Source A fetches); a 30-day window predating the cycle undercounts Cursor — labeled "this cycle" in UI copy. Dates in `cursor_daily_cost` are UTC (from `date(timestamp)` of the ms-epoch events); the panel's Claude figures are localtime-bucketed — acceptable minor skew for this tier.
- Test runner: `node --import tsx --test <file>`; full suite `npm test`. Tests use `node:test` + `node:assert/strict` + in-memory better-sqlite3 with `runMigrations(db)`.
- Swift: no unit tests. Build with `scripts/menubar-native/build.sh` (or `swift build` in that dir) and verify a screenshot of each switcher state; the panel decodes new fields as OPTIONAL so an older daemon still parses.

---

## File Structure

- Modify `src/db/schema.ts` — add `cursor_daily_cost` table.
- Modify `src/services/cursor-cloud.ts` — `bucketMeteredByDay` + `byDay` on `CursorMetered`/`fetchMeteredUsd`.
- Modify `src/commands/cursor.ts` — `runCursorUsage` writes `cursor_daily_cost`.
- Create `src/dashboard/data/sources.ts` — `buildSources` + types.
- Modify `src/dashboard/data/api.ts` — add `sourcesToday`/`sources30d` to `TodayResponse` + `buildToday`.
- Modify `scripts/menubar-native/Sources/Tokentrail.swift` — decode `sources`, add the picker + per-source rendering.
- Tests: `tests/cursor-cloud.test.ts`, `tests/cursor-daily-cost.test.ts` (new), `tests/sources.test.ts` (new).

---

## Task 1: `cursor_daily_cost` table

**Files:**
- Modify: `src/db/schema.ts`
- Test: `tests/cursor-daily-cost.test.ts` (new)

**Interfaces:**
- Produces table `cursor_daily_cost(date PK, usd, updated_at)`.

- [ ] **Step 1: Write the failing test**

Create `tests/cursor-daily-cost.test.ts`:
```ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrations.js';

describe('cursor_daily_cost schema', () => {
  test('table exists with date PK', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const cols = db.prepare(`PRAGMA table_info(cursor_daily_cost)`).all() as Array<{ name: string; pk: number }>;
    const names = cols.map((c) => c.name);
    assert.ok(names.includes('date'));
    assert.ok(names.includes('usd'));
    assert.ok(names.includes('updated_at'));
    assert.equal(cols.find((c) => c.name === 'date')?.pk, 1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test tests/cursor-daily-cost.test.ts`
Expected: FAIL — no such table.

- [ ] **Step 3: Add the table**

Append to `SCHEMA_STATEMENTS` in `src/db/schema.ts`:
```ts
  `CREATE TABLE IF NOT EXISTS cursor_daily_cost (
    date        TEXT PRIMARY KEY,
    usd         REAL NOT NULL DEFAULT 0,
    updated_at  TEXT NOT NULL
  )`,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test tests/cursor-daily-cost.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.ts tests/cursor-daily-cost.test.ts
git commit -m "feat(cursor): add cursor_daily_cost table for per-day metered rollup"
```

---

## Task 2: `bucketMeteredByDay` + `byDay` on `fetchMeteredUsd`

**Files:**
- Modify: `src/services/cursor-cloud.ts`
- Test: `tests/cursor-cloud.test.ts`

**Interfaces:**
- Consumes: existing `sumMeteredUsd`, `fetchMeteredUsd`, `CursorMetered`.
- Produces:
  - `export function bucketMeteredByDay(events: unknown[], cycleStartMs: number): { byDay: Record<string, number>; reachedCycleStart: boolean }` — USD per `YYYY-MM-DD` (UTC), same cycle-boundary + non-finite-timestamp guards as `sumMeteredUsd`.
  - `CursorMetered` gains `byDay: Record<string, number>` (USD per date, accumulated across pages).

- [ ] **Step 1: Write the failing test**

Append to `tests/cursor-cloud.test.ts`:
```ts
import { bucketMeteredByDay } from '../src/services/cursor-cloud.js';

describe('bucketMeteredByDay', () => {
  const cycleStartMs = 1000;
  test('groups chargedCents by UTC date, respects cycle boundary', () => {
    // 1_700_000_000_000 ms = 2023-11-14; 1_700_086_400_000 = 2023-11-15
    const events = [
      { timestamp: '1700086400000', chargedCents: 250 }, // day A
      { timestamp: '1700086400001', chargedCents: 150 }, // day A
      { timestamp: '1700000000000', chargedCents: 100 }, // day B
      { timestamp: '500', chargedCents: 999 },           // before cycle -> excluded, stops
    ];
    const { byDay, reachedCycleStart } = bucketMeteredByDay(events, cycleStartMs);
    const dayA = new Date(1700086400000).toISOString().slice(0, 10);
    const dayB = new Date(1700000000000).toISOString().slice(0, 10);
    assert.equal(byDay[dayA], 4);   // (250+150)/100
    assert.equal(byDay[dayB], 1);   // 100/100
    assert.equal(reachedCycleStart, true);
  });
  test('skips non-finite timestamps', () => {
    const { byDay } = bucketMeteredByDay([{ timestamp: 'x', chargedCents: 500 }], 0);
    assert.equal(Object.keys(byDay).length, 0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test tests/cursor-cloud.test.ts`
Expected: FAIL — `bucketMeteredByDay` not exported.

- [ ] **Step 3: Implement**

In `src/services/cursor-cloud.ts`:

Change the `CursorMetered` type (line ~20) to add `byDay`:
```ts
export type CursorMetered = { usd: number; byDay: Record<string, number>; eventsScanned: number; eventsTotal: number; truncated: boolean };
```

Add the helper (near `sumMeteredUsd`):
```ts
// Per-day USD from chargedCents, for events at/after cycleStartMs. Same
// newest-first stop rule and non-finite-timestamp skip as sumMeteredUsd.
export function bucketMeteredByDay(
  events: unknown[], cycleStartMs: number
): { byDay: Record<string, number>; reachedCycleStart: boolean } {
  const cents: Record<string, number> = {};
  let reached = false;
  for (const e of events) {
    if (typeof e !== 'object' || e === null) continue;
    const o = e as Record<string, any>;
    const ts = Number(o.timestamp);
    if (!Number.isFinite(ts)) continue;
    if (ts < cycleStartMs) { reached = true; break; }
    const c = Number(o.chargedCents);
    if (!Number.isFinite(c)) continue;
    const date = new Date(ts).toISOString().slice(0, 10);
    cents[date] = (cents[date] ?? 0) + c;
  }
  const byDay: Record<string, number> = {};
  for (const [d, c] of Object.entries(cents)) byDay[d] = Math.round(c) / 100;
  return { byDay, reachedCycleStart: reached };
}
```

Update `fetchMeteredUsd` to accumulate `byDay` across pages and include it in every return. Add near the top of the function body:
```ts
  const byDayCents: Record<string, number> = {};
```
After the existing `const r = sumMeteredUsd(events, cycleStartMs);` line, add:
```ts
      const b = bucketMeteredByDay(events, cycleStartMs);
      for (const [d, u] of Object.entries(b.byDay)) byDayCents[d] = (byDayCents[d] ?? 0) + Math.round(u * 100);
```
Add a local finalizer and use it in EVERY `return {...}` / final return of `fetchMeteredUsd` (there are four return sites: the non-200 mid-page partial, the reachedCycleStart return, the post-loop return, and the catch partial return). Define once above the loop:
```ts
  const finalizeByDay = (): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const [d, c] of Object.entries(byDayCents)) out[d] = Math.round(c) / 100;
    return out;
  };
```
and add `byDay: finalizeByDay(),` to each returned `CursorMetered` object (the `page === 1` non-200 early return still returns `null`, unchanged).

**tsc consistency:** adding `byDay` as a required field on `CursorMetered` breaks every existing `CursorMetered` literal under `tsc --noEmit` (tests run via tsx and won't catch it, but `npm run build` will). Grep `tests/cursor-cloud.test.ts` for injected `metered:` / `CursorMetered` literals (the runCursorUsage seam tests from the Cursor branch) and add `byDay: {}` to each. Run `npx tsc --noEmit` at the end of this task and confirm 0 errors.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test tests/cursor-cloud.test.ts`
Expected: PASS (existing fetchMeteredUsd tests still green — they don't assert on byDay, and the added field is additive).

- [ ] **Step 5: Commit**

```bash
git add src/services/cursor-cloud.ts tests/cursor-cloud.test.ts
git commit -m "feat(cursor): per-day metered breakdown (bucketMeteredByDay + CursorMetered.byDay)"
```

---

## Task 3: `runCursorUsage` writes `cursor_daily_cost`

**Files:**
- Modify: `src/commands/cursor.ts`
- Test: `tests/cursor-daily-cost.test.ts`

**Interfaces:**
- Consumes: `CursorMetered.byDay` (Task 2), `cursor_daily_cost` table (Task 1).
- Behavior: on a run where `metered` is non-null, upsert each `byDay` entry into `cursor_daily_cost`; on partial/stale (metered null), leave existing daily rows intact.

- [ ] **Step 1: Write the failing test**

Append to `tests/cursor-daily-cost.test.ts`:
```ts
import { runCursorUsage } from '../src/commands/cursor.js';

const UTIL = { cycleStart: '2026-07-01T00:00:00Z', cycleEnd: 'b', membershipType: 'pro',
  planUsed: 1, planLimit: 10, planPctUsed: 10, ondemandEnabled: false, ondemandUsed: 0 };

test('runCursorUsage upserts per-day rows from metered.byDay', async () => {
  const db = new Database(':memory:'); runMigrations(db);
  await runCursorUsage(db, { cookie: 'c', util: UTIL as any, metered: {
    usd: 5, byDay: { '2026-07-10': 3, '2026-07-11': 2 }, eventsScanned: 2, eventsTotal: 2, truncated: false } });
  const rows = db.prepare('SELECT date, usd FROM cursor_daily_cost ORDER BY date').all();
  assert.deepEqual(rows, [{ date: '2026-07-10', usd: 3 }, { date: '2026-07-11', usd: 2 }]);
});

test('partial run (metered null) leaves existing daily rows intact', async () => {
  const db = new Database(':memory:'); runMigrations(db);
  await runCursorUsage(db, { cookie: 'c', util: UTIL as any, metered: {
    usd: 5, byDay: { '2026-07-10': 3 }, eventsScanned: 1, eventsTotal: 1, truncated: false } });
  // second run: util present, metered failed (null) -> stale, daily rows untouched
  const r = await runCursorUsage(db, { cookie: 'c', util: UTIL as any, metered: null });
  assert.equal(r, 'stale');
  const rows = db.prepare('SELECT date, usd FROM cursor_daily_cost').all();
  assert.deepEqual(rows, [{ date: '2026-07-10', usd: 3 }]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test tests/cursor-daily-cost.test.ts`
Expected: FAIL — `cursor_daily_cost` rows not written.

- [ ] **Step 3: Implement**

In `src/commands/cursor.ts` `runCursorUsage`, AFTER the `cursor_usage` upsert `.run({...})` block and BEFORE the `console.log`, add:
```ts
  // Per-day metered rollup (Cursor-only table; never summed into usage_events).
  // Only write when metered actually succeeded this run — a partial/stale run
  // keeps the last-good daily rows, mirroring the cursor_usage stale behavior.
  if (metered && metered.byDay) {
    const upsertDay = db.prepare(`
      INSERT INTO cursor_daily_cost (date, usd, updated_at)
      VALUES (@date, @usd, @now)
      ON CONFLICT(date) DO UPDATE SET usd = excluded.usd, updated_at = excluded.updated_at
    `);
    const tx = db.transaction((entries: Array<[string, number]>) => {
      for (const [date, usd] of entries) upsertDay.run({ date, usd, now });
    });
    tx(Object.entries(metered.byDay));
  }
```
(`now` is the ISO string already defined earlier in the function.)

Also update the two in-file test seams / any place constructing a `CursorMetered` literal to include `byDay` if tsc complains (search `tests/cursor-cloud.test.ts` fixtures — the injected `metered` objects there now need a `byDay` field; add `byDay: {}` to any literal missing it).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test tests/cursor-daily-cost.test.ts tests/cursor-cloud.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/commands/cursor.ts tests/cursor-daily-cost.test.ts tests/cursor-cloud.test.ts
git commit -m "feat(cursor): persist per-day metered rollup into cursor_daily_cost"
```

---

## Task 4: `buildSources` + `sources` on `/api/today`

**Files:**
- Create: `src/dashboard/data/sources.ts`
- Modify: `src/dashboard/data/api.ts`
- Test: `tests/sources.test.ts` (new)

**Interfaces:**
- Produces:
  - `export type SourceCost = { key: 'claude' | 'cursor'; label: string; usd: number; extra?: { aiLines?: number } }`
  - `export type SourcesResponse = { days: number; totalUsd: number; sources: SourceCost[] }`
  - `export function buildSources(db: DatabaseType.Database, opts: { days: number; claudeUsd: number }): SourcesResponse`
- `TodayResponse` gains `sourcesToday: SourcesResponse` and `sources30d: SourcesResponse`.

- [ ] **Step 1: Write the failing test**

Create `tests/sources.test.ts`:
```ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrations.js';
import { buildSources } from '../src/dashboard/data/sources.js';

function seedCursorDay(db: Database.Database, date: string, usd: number) {
  db.prepare(`INSERT INTO cursor_daily_cost (date, usd, updated_at) VALUES (?, ?, '2026-07-24')`).run(date, usd);
}

describe('buildSources', () => {
  test('combines claude (passed in) + cursor (daily rollup); lines only in extra', () => {
    const db = new Database(':memory:'); runMigrations(db);
    const today = (db.prepare(`SELECT date('now','localtime') AS d`).get() as { d: string }).d;
    seedCursorDay(db, today, 4.5);
    db.prepare(`INSERT INTO cursor_code_attribution
      (commit_hash, repo, branch, ai_lines, composer_lines, tab_lines, human_lines, scored_at)
      VALUES ('h','local/p','main', 900, 900, 0, 10, 1)`).run();

    const out = buildSources(db, { days: 1, claudeUsd: 9 });
    assert.equal(out.totalUsd, 13.5);                 // 9 + 4.5, dollars only
    const cursor = out.sources.find((s) => s.key === 'cursor')!;
    assert.equal(cursor.usd, 4.5);
    assert.equal(cursor.extra?.aiLines, 900);         // lines in extra, NOT in totalUsd
    const claude = out.sources.find((s) => s.key === 'claude')!;
    assert.equal(claude.usd, 9);
  });

  test('omits cursor entry when there is no cursor data', () => {
    const db = new Database(':memory:'); runMigrations(db);
    const out = buildSources(db, { days: 30, claudeUsd: 12 });
    assert.equal(out.sources.length, 1);
    assert.equal(out.sources[0]!.key, 'claude');
    assert.equal(out.totalUsd, 12);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test tests/sources.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/dashboard/data/sources.ts`:
```ts
import type DatabaseType from 'better-sqlite3';

export type SourceCost = {
  key: 'claude' | 'cursor';
  label: string;
  usd: number;
  extra?: { aiLines?: number };
};
export type SourcesResponse = { days: number; totalUsd: number; sources: SourceCost[] };

// Dollars-only combined view. Claude's windowed dollars are passed in (they are
// already computed by the panel — todayUsd / last30Usd — so the combined total
// always matches the panel). Cursor's dollars come from the per-day rollup;
// Cursor AI-lines ride along in `extra` and are NEVER added into totalUsd.
export function buildSources(
  db: DatabaseType.Database,
  opts: { days: number; claudeUsd: number }
): SourcesResponse {
  const sources: SourceCost[] = [
    { key: 'claude', label: 'Claude Code', usd: round2(opts.claudeUsd) },
  ];

  // Cursor windowed dollars from the daily rollup (UTC dates). days=1 -> today.
  const cutoff = `date('now','localtime','-${Math.max(0, opts.days - 1)} days')`;
  const cursorUsd = (db
    .prepare(`SELECT COALESCE(SUM(usd), 0) AS u FROM cursor_daily_cost WHERE date >= ${cutoff}`)
    .get() as { u: number }).u;
  const aiLines = (db
    .prepare(`SELECT COALESCE(SUM(ai_lines), 0) AS n FROM cursor_code_attribution WHERE repo IS NOT NULL`)
    .get() as { n: number }).n;

  // Include Cursor only when there's something to show (dollars or lines).
  if (cursorUsd > 0 || aiLines > 0) {
    sources.push({
      key: 'cursor', label: 'Cursor', usd: round2(cursorUsd),
      extra: aiLines > 0 ? { aiLines } : undefined,
    });
  }

  const totalUsd = round2(sources.reduce((sum, s) => sum + s.usd, 0));
  return { days: opts.days, totalUsd, sources };
}

function round2(n: number): number { return Math.round(n * 100) / 100; }
```

In `src/dashboard/data/api.ts`:
- Import: `import { buildSources, type SourcesResponse } from './sources.js';`
- Add to `TodayResponse` type: `sourcesToday: SourcesResponse; sources30d: SourcesResponse;`
- In `buildToday`, after `const value: TodayResponse = { ... }` is assembled (it already has `todayUsd` and `menubar.last30Usd`), set the two fields before caching. Restructure so they're part of the literal:
```ts
  const menubar = buildMenubarSummary(db, overview.totalUsd, hidden, visibleSql);
  const value: TodayResponse = {
    todayUsd: overview.totalUsd,
    topProjects: /* unchanged */ overview.topProjects.slice(0, MAX_PROJECTS).map((p) => ({
      key: p.key, name: p.name, usd: p.totalUsd,
      href: `${DASHBOARD_BASE_URL}/project/${encodeURIComponent(p.key)}`,
      features: (projectFeaturesMap.get(p.key) ?? []).slice(0, MAX_FEATURES_PER_PROJECT),
    })),
    anomalyCount,
    topAnomaly,
    lastEventAt,
    menubar,
    sourcesToday: buildSources(db, { days: 1, claudeUsd: overview.totalUsd }),
    sources30d: buildSources(db, { days: 30, claudeUsd: menubar.last30Usd }),
  };
```
(Extract `menubar` into a local first so it can feed `sources30d`, replacing the current inline `menubar: buildMenubarSummary(...)`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test tests/sources.test.ts`
Expected: PASS. Then `node --import tsx --test tests/api.test.ts` to confirm the buildToday change didn't break existing API tests.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/data/sources.ts src/dashboard/data/api.ts tests/sources.test.ts
git commit -m "feat(sources): buildSources + sourcesToday/sources30d on /api/today"
```

---

## Task 5: Native app switcher

**Files:**
- Modify: `scripts/menubar-native/Sources/Tokentrail.swift`
- Verify: build + screenshot (no Swift unit harness)

**Interfaces:**
- Consumes: `sourcesToday`/`sources30d` on the JSON `/api/today` response.

- [ ] **Step 1: Add Decodable models + optional fields**

In `Tokentrail.swift`, add near the other structs:
```swift
struct SourceCost: Decodable, Identifiable {
    let key: String
    let label: String
    let usd: Double
    let extra: Extra?
    struct Extra: Decodable { let aiLines: Int? }
    var id: String { key }
}
struct SourcesResponse: Decodable {
    let days: Int
    let totalUsd: Double
    let sources: [SourceCost]
}
```
Add two OPTIONAL fields to `TodayResponse` (optional so an older daemon still decodes):
```swift
    let sourcesToday: SourcesResponse?
    let sources30d: SourcesResponse?
```

- [ ] **Step 2: Add the switcher state + picker**

In `PanelView`:
```swift
    enum SourceTab: String, CaseIterable { case all = "All", claude = "Claude", cursor = "Cursor" }
    @State private var sourceTab: SourceTab = .all
```
Show the picker only when Cursor data is present (else there's nothing to switch):
```swift
    private func hasCursor(_ t: TodayResponse) -> Bool {
        (t.sourcesToday?.sources.contains { $0.key == "cursor" } ?? false)
        || (t.sources30d?.sources.contains { $0.key == "cursor" } ?? false)
    }
```
At the top of the `if let t = store.today {` block, before `header(t)`:
```swift
                if hasCursor(t) {
                    Picker("", selection: $sourceTab) {
                        ForEach(SourceTab.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                }
```

- [ ] **Step 3: Render per selected source**

Gate the existing sections on `sourceTab` and add the combined/cursor rows. Replace the body's section list so that:
- `.all` and `.claude`: render the existing `header/statBlock/trend/breakdown/worthALook/projects` exactly as today. Under `.all`, ALSO render a source-split line above the divider:
```swift
    @ViewBuilder private func sourceSplit(_ t: TodayResponse) -> some View {
        if let s = t.sources30d, s.sources.count > 1 {
            HStack(spacing: 8) {
                Text("30d by source").font(.caption).foregroundStyle(.secondary)
                Spacer()
                Text(s.sources.map { "\($0.label) \(Fmt.usd($0.usd))" }.joined(separator: " · "))
                    .font(.caption)
            }
        }
    }
```
Call `sourceSplit(t)` right after `statBlock(t)` when `sourceTab == .all`.
- `.cursor`: render a compact Cursor-only view instead of the Claude sections:
```swift
    @ViewBuilder private func cursorView(_ t: TodayResponse) -> some View {
        let today = t.sourcesToday?.sources.first { $0.key == "cursor" }
        let d30 = t.sources30d?.sources.first { $0.key == "cursor" }
        VStack(alignment: .leading, spacing: 6) {
            Text("Cursor").font(.headline)
            Text("\(Fmt.usd(today?.usd ?? 0)) today · \(Fmt.usd(d30?.usd ?? 0)) this cycle (est.)")
                .font(.callout)
            if let lines = d30?.extra?.aiLines, lines > 0 {
                Text("\(lines) AI-authored lines (all-time)")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
    }
```
Structure the body as:
```swift
                if sourceTab == .cursor {
                    cursorView(t)
                } else {
                    header(t)
                    Divider()
                    statBlock(t)
                    if sourceTab == .all { sourceSplit(t) }
                    if t.menubar.trend.days.count >= 2 {
                        TrendChart(trend: t.menubar.trend, focused: $focused)
                        BreakdownView(trend: t.menubar.trend, focused: $focused)
                    }
                    Divider(); worthALook(t)
                    if !t.topProjects.isEmpty { Divider(); projects(t) }
                }
                Divider()
                actions()
```
(Confirm `Fmt.usd` exists — it does, per the `Fmt` enum. If the exact name differs, use the existing dollar formatter in `Fmt`.)

- [ ] **Step 4: Build and verify**

Run: `bash scripts/menubar-native/build.sh` (or `cd scripts/menubar-native && swift build`).
Expected: builds clean. Then launch the app (or the headless preview if one exists) against the running daemon and capture a screenshot of each switcher state — All (with the "30d by source" split), Claude (unchanged), Cursor (dollars + AI-lines). Confirm the picker is hidden entirely on a daemon/DB with no Cursor data.

- [ ] **Step 5: Commit**

```bash
git add scripts/menubar-native/Sources/Tokentrail.swift
git commit -m "feat(menubar): source switcher (All | Claude | Cursor) with dollars-only combined view"
```

---

## Self-Review

**Spec coverage:**
- §2.1 `cursor_daily_cost` → Task 1. ✓
- §2.2 Source A change (`bucketMeteredByDay`, `byDay`) → Task 2; write rollup → Task 3. ✓
- §2.3 `buildSources` per-source series → Task 4. ✓
- §2.4 `sourcesToday`/`sources30d` on `/api/today`, optional Swift decode → Tasks 4, 5. ✓
- §3 native picker + per-source rendering (All split, Claude unchanged, Cursor lines, hidden tab when no Cursor) → Task 5. ✓
- §4 invariant (combined via explicit addition, never over usage_events), non-fatal omit → Tasks 4 (buildSources adds per source; omits cursor when empty). ✓
- §5 testing incl. lines-not-in-total, partial-run leaves rollup intact → Tasks 3, 4. ✓

**Placeholder scan:** No TBD/"handle errors"; the only judgment call flagged inline is confirming `Fmt.usd`'s exact name in Task 5 (the formatter demonstrably exists). No blank steps.

**Type consistency:** `CursorMetered.byDay` (Task 2) is consumed in Task 3's write and Task 3 test literals; `buildSources(db, { days, claudeUsd })` / `SourcesResponse` / `SourceCost` names match across Tasks 4–5 and the Swift `SourcesResponse`/`SourceCost` decoders. `sourcesToday`/`sources30d` names match between api.ts and Swift.
