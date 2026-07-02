# Project Detail Page Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite the `/project/:key` page as a five-section story — Hero, Velocity, Features, Active work, Worth reconciling — with server-side SVG bar/sparkline visuals shaded by the project's own hue.

**Architecture:** Extend `ProjectDetailVM` with velocity/peak/week metadata + per-feature sparkline data + anomaly cause. Two new server-side SVG helpers (`renderVelocityChart`, `renderSparkline`) live in `src/dashboard/render/`. `render/project.ts` becomes a five-card skeleton assembled from small helpers. Client JS only touches the unattributed CTA (reuses the SSE endpoint already shipped for the overview).

**Tech Stack:** Node.js + TypeScript, better-sqlite3, Fastify (existing routes), server-rendered HTML + inline SVG for velocity/sparklines, existing `dashboard.js` for the small amount of client behavior (unattributed CTA reuse).

## Global Constraints

Copied verbatim from `docs/superpowers/specs/2026-07-01-project-detail-page-redesign.md`:

- Single-column, same width as the overview main-col.
- Parchment palette (`#F6EFDD`-ish), serif hero, sans body, tabular-nums for numbers.
- Per-project hue via `resolveProjectColors` — the hero, velocity bars, feature sparklines, and unattributed sparkline all shade from that base.
- Feature sparkline color: `shadeForFeature(resolveProjectColors[projectKey], featureKey)` — same as overview burn-paths.
- Section order: Hero → Velocity → Features → Active work → Worth reconciling.
- Trail-elevation is REPLACED by a daily velocity chart. Trail-elevation stays on the VM (feature page still uses it) but the project render stops calling it.
- No new DB migrations. All new data derived from existing tables (`feature_rollups`, `session_commits`, `session_prs`, `anomalies`, `sessions`).
- Server-side SVG for sparkline + velocity chart (no JS required to display).
- Unattributed CTA on this page hits the SAME SSE endpoint (`GET /api/infer-mainline/stream`) as the overview.
- "Worth reconciling" section collapses to a single subtle `All clear on archi.` line when unattributed is $0 AND anomalies is empty.
- `most-active feature` line in hero is omitted when `vm.features` is empty.
- Dollar-delta line reads `(new project)` when priorUsd is 0 and totalUsd is nonzero.

---

## File map

- **Modify** `src/dashboard/data/project.ts` — extend `ProjectDetailVM` with `avgUsdPerDay`, `weekStats`, `peakDay`, per-feature `lastActive` + `daily`, per-anomaly optional `cause`. Update `buildProjectDetail` to populate them.
- **Modify** `tests/project-data.test.ts` — extend for the new fields.
- **Create** `src/dashboard/render/sparkline.ts` — server-side SVG sparkline helper.
- **Create** `tests/sparkline-render.test.ts` — unit tests.
- **Create** `src/dashboard/render/velocity.ts` — server-side SVG velocity bar chart helper.
- **Create** `tests/velocity-render.test.ts` — unit tests.
- **Modify** `src/dashboard/render/project.ts` — rewrite around five sections using the helpers above.
- **Create** `tests/project-render.test.ts` — structural tests (each section renders, empty-state collapses, section order).
- **Modify** `src/dashboard/static/dashboard.css` — new rules for the redesigned page.
- **Modify** `src/dashboard/static/dashboard.js` — wire the project-page unattributed CTA to the SSE endpoint (reuses the overview's helper by ID).

---

## Task 1: Extend ProjectDetailVM with velocity/peak/week metadata

**Files:**
- Modify: `src/dashboard/data/project.ts`
- Test: `tests/project-data.test.ts`

**Interfaces:**
- Consumes: existing `ProjectDetailVM`, `buildProjectDetail`, `dailySeries: Array<{ date; total; commits; prs }>`.
- Produces: `ProjectDetailVM` gains:
  ```ts
  avgUsdPerDay: number;
  weekStats: {
    thisWeekUsd: number;
    lastWeekUsd: number;
    priorWeekUsd: number;
    thisVsLastPct: number;
    lastVsPriorPct: number;
  };
  peakDay: {
    date: string;
    totalUsd: number;
    featureKey: string;
    featureName: string;
  } | null;
  ```

- [ ] **Step 1: Write the failing tests for weekStats + avgUsdPerDay + peakDay**

Append to `tests/project-data.test.ts` inside the existing `describe('buildProjectDetail', ...)`:

```ts
  test('avgUsdPerDay equals totalUsd / days', () => {
    const db = makeDb();
    const today = db.prepare(`SELECT date('now','-1 day','localtime') AS d`).get() as { d: string };
    insertRollup(db, { date: today.d, featureKey: 'archi-a', featureName: 'A', repo: 'loschenbd/archi', cost: 70, sessionIds: 'sess-a', sessions: 1 });
    const vm = buildProjectDetail(db, { projectKey: 'repo:loschenbd/archi', days: 7 })!;
    assert.equal(vm.avgUsdPerDay, 10);
  });

  test('weekStats totals + deltas over a 30d window with three explicit weeks', () => {
    const db = makeDb();
    const day = (n: number) => (db.prepare(`SELECT date('now','-${n} days','localtime') AS d`).get() as { d: string }).d;
    // This week (days 0..6): $200 across two days
    insertRollup(db, { date: day(0), featureKey: 'f1', featureName: 'F1', repo: 'loschenbd/archi', cost: 120, sessionIds: 'sA', sessions: 1 });
    insertRollup(db, { date: day(3), featureKey: 'f1', featureName: 'F1', repo: 'loschenbd/archi', cost: 80, sessionIds: 'sB', sessions: 1 });
    // Last week (days 7..13): $100
    insertRollup(db, { date: day(10), featureKey: 'f1', featureName: 'F1', repo: 'loschenbd/archi', cost: 100, sessionIds: 'sC', sessions: 1 });
    // Prior week (days 14..20): $50
    insertRollup(db, { date: day(17), featureKey: 'f1', featureName: 'F1', repo: 'loschenbd/archi', cost: 50, sessionIds: 'sD', sessions: 1 });

    const vm = buildProjectDetail(db, { projectKey: 'repo:loschenbd/archi', days: 30 })!;
    assert.equal(vm.weekStats.thisWeekUsd, 200);
    assert.equal(vm.weekStats.lastWeekUsd, 100);
    assert.equal(vm.weekStats.priorWeekUsd, 50);
    assert.equal(vm.weekStats.thisVsLastPct, 100);   // (200-100)/100
    assert.equal(vm.weekStats.lastVsPriorPct, 100);  // (100-50)/50
  });

  test('weekStats deltas handle a zero denominator', () => {
    const db = makeDb();
    const day = (n: number) => (db.prepare(`SELECT date('now','-${n} days','localtime') AS d`).get() as { d: string }).d;
    insertRollup(db, { date: day(0), featureKey: 'f', featureName: 'F', repo: 'loschenbd/archi', cost: 40, sessionIds: 's', sessions: 1 });
    const vm = buildProjectDetail(db, { projectKey: 'repo:loschenbd/archi', days: 30 })!;
    // Only this week has spend; lastWeek = priorWeek = 0
    assert.equal(vm.weekStats.thisWeekUsd, 40);
    assert.equal(vm.weekStats.lastWeekUsd, 0);
    assert.equal(vm.weekStats.priorWeekUsd, 0);
    assert.equal(vm.weekStats.thisVsLastPct, 100);   // 0 denom + nonzero num → 100
    assert.equal(vm.weekStats.lastVsPriorPct, 0);    // 0 denom + zero num → 0
  });

  test('peakDay is the highest-spend day with the top feature that day', () => {
    const db = makeDb();
    const day = (n: number) => (db.prepare(`SELECT date('now','-${n} days','localtime') AS d`).get() as { d: string }).d;
    insertRollup(db, { date: day(1), featureKey: 'small', featureName: 'Small feat', repo: 'loschenbd/archi', cost: 10, sessionIds: 'sA', sessions: 1 });
    insertRollup(db, { date: day(2), featureKey: 'big',   featureName: 'Big feat',   repo: 'loschenbd/archi', cost: 300, sessionIds: 'sB', sessions: 1 });
    insertRollup(db, { date: day(2), featureKey: 'tiny',  featureName: 'Tiny feat',  repo: 'loschenbd/archi', cost: 5,   sessionIds: 'sC', sessions: 1 });
    const vm = buildProjectDetail(db, { projectKey: 'repo:loschenbd/archi', days: 7 })!;
    assert.ok(vm.peakDay);
    assert.equal(vm.peakDay!.date, day(2));
    assert.equal(vm.peakDay!.totalUsd, 305);
    assert.equal(vm.peakDay!.featureKey, 'big');
    assert.equal(vm.peakDay!.featureName, 'Big feat');
  });

  test('peakDay is null when the project has no spend in-window', () => {
    // buildProjectDetail returns null for a zero-spend project; verify
    // that when there IS at least one rollup but it landed outside the
    // window, the resulting VM is null (existing contract) rather than
    // returning a broken peakDay.
    const db = makeDb();
    const day30 = (db.prepare(`SELECT date('now','-40 days','localtime') AS d`).get() as { d: string }).d;
    insertRollup(db, { date: day30, featureKey: 'old', featureName: 'Old', repo: 'loschenbd/archi', cost: 10, sessionIds: 'sX', sessions: 1 });
    const vm = buildProjectDetail(db, { projectKey: 'repo:loschenbd/archi', days: 30 });
    assert.equal(vm, null);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- 2>&1 | grep -E "avgUsdPerDay|weekStats|peakDay|not ok"`
Expected: FAIL — `TypeError: Cannot read properties of undefined (reading 'thisWeekUsd')` and similar, since these fields do not exist yet.

- [ ] **Step 3: Extend the VM type in `src/dashboard/data/project.ts`**

Add to the `ProjectDetailVM` type (after `deltaPct: number;`):

```ts
  avgUsdPerDay: number;
  weekStats: {
    thisWeekUsd: number;
    lastWeekUsd: number;
    priorWeekUsd: number;
    thisVsLastPct: number;
    lastVsPriorPct: number;
  };
  peakDay: {
    date: string;
    totalUsd: number;
    featureKey: string;
    featureName: string;
  } | null;
```

- [ ] **Step 4: Populate the fields in `buildProjectDetail`**

Just before the existing `return { ... }` at the bottom of `buildProjectDetail`, insert:

```ts
  const avgUsdPerDay = round2(head.totalUsd / days);

  // Rolling weeks: this = days 0..6, last = 7..13, prior = 14..20.
  // We take these from dailySeries (already zero-filled). dailySeries is
  // ordered oldest→newest, so this week is the tail.
  const totalsByDate = new Map(dailySeries.map((d) => [d.date, d.total]));
  const dateAt = (n: number) => (db.prepare(`SELECT date('now', '-${n} days', 'localtime') AS d`).get() as { d: string }).d;
  const sumRange = (from: number, to: number): number => {
    let s = 0;
    for (let i = from; i <= to; i++) s += totalsByDate.get(dateAt(i)) ?? 0;
    return round2(s);
  };
  const thisWeekUsd = sumRange(0, 6);
  const lastWeekUsd = sumRange(7, 13);
  const priorWeekUsd = sumRange(14, 20);
  const deltaPctBetween = (curr: number, prev: number): number => {
    if (prev > 0) return Math.round(((curr - prev) / prev) * 100);
    return curr > 0 ? 100 : 0;
  };
  const weekStats = {
    thisWeekUsd,
    lastWeekUsd,
    priorWeekUsd,
    thisVsLastPct: deltaPctBetween(thisWeekUsd, lastWeekUsd),
    lastVsPriorPct: deltaPctBetween(lastWeekUsd, priorWeekUsd),
  };

  // Peak day: highest-total day in-window with the top feature on that
  // date. If two days tie, pick the more recent one (later in the series).
  let peakDay: ProjectDetailVM['peakDay'] = null;
  let peakUsd = 0;
  for (const d of dailySeries) {
    if (d.total >= peakUsd && d.total > 0) {
      peakUsd = d.total;
      peakDay = { date: d.date, totalUsd: d.total, featureKey: '', featureName: '' };
    }
  }
  if (peakDay) {
    const topFeat = db
      .prepare(`SELECT feature_key AS k, MAX(feature_name) AS n, SUM(total_cost_usd) AS s FROM feature_rollups WHERE ${filterSql} AND date = @peakDate GROUP BY feature_key ORDER BY s DESC LIMIT 1`)
      .get({ ...filterParams, peakDate: peakDay.date }) as { k: string; n: string; s: number } | undefined;
    if (topFeat) {
      peakDay.featureKey = topFeat.k;
      peakDay.featureName = topFeat.n ?? topFeat.k;
    }
  }
```

Add `avgUsdPerDay`, `weekStats`, `peakDay` to the returned object (inside the existing `return { ... }`):

```ts
    avgUsdPerDay,
    weekStats,
    peakDay,
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test 2>&1 | tail -8`
Expected: 236+ pass, 0 fail (we're adding 5 tests, so `# tests 241 # pass 241`).

- [ ] **Step 6: Commit**

```bash
git add src/dashboard/data/project.ts tests/project-data.test.ts
git commit -m "$(cat <<'EOF'
feat(project-data): add avgUsdPerDay, weekStats, peakDay to VM

Feeds the Velocity section of the redesigned project page. Computed
from the existing dailySeries + one extra rollup query for the peak
day's top feature.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Extend features[] with lastActive + daily, anomalies[] with optional cause

**Files:**
- Modify: `src/dashboard/data/project.ts`
- Test: `tests/project-data.test.ts`

**Interfaces:**
- Consumes: existing per-feature `{ featureKey, featureName, totalUsd, sessionCount }` and per-anomaly `{ id, kind, date, featureKey, sessionId, amount, reason }`.
- Produces: features[] gains
  ```ts
  lastActive: string;                                    // yyyy-mm-dd, max date in-window
  daily: Array<{ date: string; totalUsd: number }>;      // per-day cost for the sparkline
  ```
  anomalies[] gains
  ```ts
  cause: { kind: 'session' | 'feature'; ref: string; label: string } | null;
  ```

- [ ] **Step 1: Write the failing tests**

Append to `tests/project-data.test.ts`:

```ts
  test('each feature carries lastActive and a zero-filled daily series', () => {
    const db = makeDb();
    const day = (n: number) => (db.prepare(`SELECT date('now','-${n} days','localtime') AS d`).get() as { d: string }).d;
    insertRollup(db, { date: day(1), featureKey: 'archi-a', featureName: 'A', repo: 'loschenbd/archi', cost: 25, sessionIds: 'sess-1', sessions: 1 });
    insertRollup(db, { date: day(3), featureKey: 'archi-a', featureName: 'A', repo: 'loschenbd/archi', cost: 75, sessionIds: 'sess-2', sessions: 1 });
    const vm = buildProjectDetail(db, { projectKey: 'repo:loschenbd/archi', days: 7 })!;
    const feat = vm.features.find((f) => f.featureKey === 'archi-a')!;
    assert.equal(feat.lastActive, day(1));
    assert.equal(feat.daily.length, 7);
    // daily is oldest→newest; day(1) is the second-to-last entry.
    const byDate = Object.fromEntries(feat.daily.map((d) => [d.date, d.totalUsd]));
    assert.equal(byDate[day(1)], 25);
    assert.equal(byDate[day(3)], 75);
    assert.equal(byDate[day(0)], 0);
  });

  test('anomalies expose a session cause when the anomaly is tied to a session', () => {
    const db = makeDb();
    const day = (n: number) => (db.prepare(`SELECT date('now','-${n} days','localtime') AS d`).get() as { d: string }).d;
    insertRollup(db, { date: day(1), featureKey: 'archi-a', featureName: 'A', repo: 'loschenbd/archi', cost: 100, sessionIds: 'sess-a', sessions: 1 });
    db.prepare(`INSERT INTO sessions (session_id, title) VALUES (?, ?)`).run('sess-a', 'Rework the pulses');
    db.prepare(`INSERT INTO anomalies (kind, date, feature_key, session_id, amount, baseline, multiplier, reason)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('spike_day', day(1), 'archi-a', 'sess-a', 100, 10, 10, '100 — 10× the prior week\'s typical day');
    const vm = buildProjectDetail(db, { projectKey: 'repo:loschenbd/archi', days: 7 })!;
    const anom = vm.anomalies[0]!;
    assert.equal(anom.cause?.kind, 'session');
    assert.equal(anom.cause?.ref, 'sess-a');
    assert.equal(anom.cause?.label, 'Rework the pulses');
  });

  test('anomalies with no session but a feature key get a feature cause', () => {
    const db = makeDb();
    const day = (n: number) => (db.prepare(`SELECT date('now','-${n} days','localtime') AS d`).get() as { d: string }).d;
    insertRollup(db, { date: day(1), featureKey: 'archi-a', featureName: 'Feature A pretty', repo: 'loschenbd/archi', cost: 100, sessionIds: 'sess-a', sessions: 1 });
    db.prepare(`INSERT INTO anomalies (kind, date, feature_key, session_id, amount, baseline, multiplier, reason)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('first_activity', day(1), 'archi-a', null, 100, 0, 100, 'first activity in 6 days');
    const vm = buildProjectDetail(db, { projectKey: 'repo:loschenbd/archi', days: 7 })!;
    const anom = vm.anomalies[0]!;
    assert.equal(anom.cause?.kind, 'feature');
    assert.equal(anom.cause?.ref, 'archi-a');
    assert.equal(anom.cause?.label, 'Feature A pretty');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test 2>&1 | grep -E "lastActive|cause|not ok" | head -10`
Expected: FAIL — `feat.lastActive` is undefined; `anom.cause` is undefined.

- [ ] **Step 3: Extend the VM type**

In `src/dashboard/data/project.ts`, update the features[] and anomalies[] entries:

```ts
  features: Array<{
    featureKey: string;
    featureName: string;
    totalUsd: number;
    sessionCount: number;
    lastActive: string;
    daily: Array<{ date: string; totalUsd: number }>;
  }>;
  ...
  anomalies: Array<{
    id: number;
    kind: string;
    date: string;
    featureKey: string | null;
    sessionId: string | null;
    amount: number;
    reason: string;
    cause: { kind: 'session' | 'feature'; ref: string; label: string } | null;
  }>;
```

- [ ] **Step 4: Populate the new fields in `buildProjectDetail`**

Right after the existing `features = db.prepare(...).all(...)` block, add:

```ts
  // Per-feature lastActive + zero-filled daily series in-window.
  const featureDailyByKey = new Map<string, Map<string, number>>();
  const featureLastActive = new Map<string, string>();
  for (const r of db
    .prepare(`SELECT feature_key AS k, date AS d, SUM(total_cost_usd) AS s FROM feature_rollups WHERE ${filterSql} AND date >= ${startExpr} GROUP BY feature_key, date`)
    .all(filterParams) as Array<{ k: string; d: string; s: number }>) {
    if (!featureDailyByKey.has(r.k)) featureDailyByKey.set(r.k, new Map());
    featureDailyByKey.get(r.k)!.set(r.d, r.s);
    const prev = featureLastActive.get(r.k);
    if (!prev || r.d > prev) featureLastActive.set(r.k, r.d);
  }

  const dailyDates = dailySeries.map((d) => d.date);
  const featuresWithSparkline = features.map((f) => {
    const perDate = featureDailyByKey.get(f.featureKey) ?? new Map<string, number>();
    return {
      ...f,
      totalUsd: round2(f.totalUsd),
      lastActive: featureLastActive.get(f.featureKey) ?? dailyDates[dailyDates.length - 1] ?? '',
      daily: dailyDates.map((d) => ({ date: d, totalUsd: round2(perDate.get(d) ?? 0) })),
    };
  });
```

Also replace the previous `features: features.map((f) => ({ ...f, totalUsd: round2(f.totalUsd) })),` line in the return object with:

```ts
    features: featuresWithSparkline,
```

For anomalies, replace the existing `const anomalies = ...` block with:

```ts
  const anomaliesRaw = featureKeys.length === 0
    ? []
    : db
      .prepare(`
        SELECT id, kind, date, feature_key AS featureKey, session_id AS sessionId,
               ROUND(amount, 2) AS amount, reason
        FROM anomalies
        WHERE dismissed_at IS NULL
          AND date >= ${startExpr}
          AND feature_key IN (SELECT value FROM json_each(?))
        ORDER BY multiplier DESC, date DESC
        LIMIT 5
      `)
      .all(JSON.stringify(featureKeys)) as Array<{
        id: number;
        kind: string;
        date: string;
        featureKey: string | null;
        sessionId: string | null;
        amount: number;
        reason: string;
      }>;

  // Cause line: prefer the session (title looked up in `sessions`) if the
  // anomaly references one; otherwise fall back to the anomaly's feature
  // (using the human name from our per-feature list).
  const featureNameByKey = new Map(featuresWithSparkline.map((f) => [f.featureKey, f.featureName || f.featureKey]));
  const anomalySessionIds = anomaliesRaw
    .map((a) => a.sessionId)
    .filter((s): s is string => !!s);
  const sessionTitleByRef = new Map<string, string>();
  if (anomalySessionIds.length > 0) {
    for (const r of db
      .prepare(`SELECT session_id AS sid, title FROM sessions WHERE session_id IN (SELECT value FROM json_each(?))`)
      .all(JSON.stringify(anomalySessionIds)) as Array<{ sid: string; title: string | null }>) {
      sessionTitleByRef.set(r.sid, r.title ?? r.sid);
    }
  }
  const anomalies: ProjectDetailVM['anomalies'] = anomaliesRaw.map((a) => {
    let cause: { kind: 'session' | 'feature'; ref: string; label: string } | null = null;
    if (a.sessionId) {
      cause = { kind: 'session', ref: a.sessionId, label: sessionTitleByRef.get(a.sessionId) ?? a.sessionId };
    } else if (a.featureKey) {
      cause = { kind: 'feature', ref: a.featureKey, label: featureNameByKey.get(a.featureKey) ?? a.featureKey };
    }
    return { ...a, cause };
  });
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test 2>&1 | tail -8`
Expected: all tests pass; totals bump to `# tests 244`.

- [ ] **Step 6: Commit**

```bash
git add src/dashboard/data/project.ts tests/project-data.test.ts
git commit -m "$(cat <<'EOF'
feat(project-data): per-feature sparkline data + anomaly cause line

features[] gets a lastActive date and a zero-filled daily series so the
project-page sparkline can render server-side. anomalies[] picks up a
cause pointer (session title when tied to a session, feature name when
not) — the second line the anomaly row shows on the redesigned page.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Server-side SVG sparkline helper

**Files:**
- Create: `src/dashboard/render/sparkline.ts`
- Test: `tests/sparkline-render.test.ts`

**Interfaces:**
- Consumes: `resolveProjectColors`, `shadeForFeature` from `src/dashboard/lib/feature-colors.ts` (existing).
- Produces:
  ```ts
  export function renderSparkline(opts: {
    points: Array<{ date: string; totalUsd: number }>;
    color: string;             // hex, already computed by caller
    width?: number;            // default 80
    height?: number;           // default 16
    ariaLabel?: string;
  }): string;                  // returns an <svg>…</svg> string
  ```
  - Zero-height baseline when `points` is empty or every totalUsd is 0.
  - Poly-line only (no fill area) — matches the overview unattributed card sparkline.
  - Deterministic output for the same input (used in snapshot tests).

- [ ] **Step 1: Write the failing tests**

Create `tests/sparkline-render.test.ts`:

```ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { renderSparkline } from '../src/dashboard/render/sparkline.js';

describe('renderSparkline', () => {
  test('empty points → svg with no polyline', () => {
    const svg = renderSparkline({ points: [], color: '#123456' });
    assert.match(svg, /^<svg\b/);
    assert.doesNotMatch(svg, /<polyline\b/);
  });

  test('all-zero points → flat baseline polyline at the bottom edge', () => {
    const svg = renderSparkline({
      points: [
        { date: '2026-06-01', totalUsd: 0 },
        { date: '2026-06-02', totalUsd: 0 },
      ],
      color: '#abcdef',
      width: 40,
      height: 10,
    });
    assert.match(svg, /<polyline\b/);
    // Baseline y-coordinate is at (height - pad). Verify at least one point
    // near that y, and the stroke uses the supplied color.
    assert.match(svg, /stroke="#abcdef"/);
  });

  test('non-zero points scale to the specified height', () => {
    const svg = renderSparkline({
      points: [
        { date: '2026-06-01', totalUsd: 10 },
        { date: '2026-06-02', totalUsd: 20 },
      ],
      color: '#000000',
      width: 20,
      height: 20,
    });
    // Should have exactly one polyline with two comma-separated coords.
    const match = svg.match(/points="([^"]+)"/);
    assert.ok(match);
    const coords = match![1]!.split(' ').filter((p) => p.length > 0);
    assert.equal(coords.length, 2);
  });

  test('sets aria-label when provided', () => {
    const svg = renderSparkline({ points: [], color: '#000', ariaLabel: 'archi-a 30d' });
    assert.match(svg, /aria-label="archi-a 30d"/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test 2>&1 | grep -E "renderSparkline|not ok" | head -5`
Expected: FAIL — `Cannot find module './sparkline.js'`.

- [ ] **Step 3: Implement the sparkline helper**

Create `src/dashboard/render/sparkline.ts`:

```ts
export type SparklinePoint = { date: string; totalUsd: number };

export function renderSparkline(opts: {
  points: readonly SparklinePoint[];
  color: string;
  width?: number;
  height?: number;
  ariaLabel?: string;
}): string {
  const w = opts.width ?? 80;
  const h = opts.height ?? 16;
  const pad = 1;
  const aria = opts.ariaLabel
    ? ` aria-label="${escapeAttr(opts.ariaLabel)}"`
    : ' aria-hidden="true"';
  if (opts.points.length === 0) {
    return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"${aria}></svg>`;
  }
  const max = Math.max(1, ...opts.points.map((p) => p.totalUsd));
  const stepX = (w - pad * 2) / Math.max(1, opts.points.length - 1);
  const pts = opts.points.map((p, i) => {
    const x = pad + i * stepX;
    const y = h - pad - (p.totalUsd / max) * (h - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"${aria}>` +
    `<polyline points="${pts}" fill="none" stroke="${escapeAttr(opts.color)}" stroke-width="1.5" />` +
    `</svg>`;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test 2>&1 | tail -8`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/render/sparkline.ts tests/sparkline-render.test.ts
git commit -m "$(cat <<'EOF'
feat(render): server-side SVG sparkline helper

Shared between the redesigned project-detail feature list and the
overview's unattributed card. Deterministic output, no JS, escapes
color / aria attrs.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Server-side SVG velocity chart helper

**Files:**
- Create: `src/dashboard/render/velocity.ts`
- Test: `tests/velocity-render.test.ts`

**Interfaces:**
- Consumes: nothing (color hex passed in by caller).
- Produces:
  ```ts
  export function renderVelocityChart(opts: {
    days: Array<{ date: string; total: number }>;
    color: string;
    width?: number;              // default 640
    height?: number;             // default 140
    peakDate?: string | null;    // if set, the peak bar renders in a darker shade
  }): string;                    // returns an <svg>…</svg> string with bars + x-axis labels
  ```
  - Bar chart, one bar per day.
  - X-axis labels roughly every 7th day, formatted as `Mon D` (e.g. `Jun 8`).
  - Empty days render as no-bar (zero-height slot).
  - Peak bar uses a darker shade (multiply by ~0.85 in HSL lightness).

- [ ] **Step 1: Write the failing tests**

Create `tests/velocity-render.test.ts`:

```ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { renderVelocityChart } from '../src/dashboard/render/velocity.js';

describe('renderVelocityChart', () => {
  test('empty days → svg with no bars', () => {
    const svg = renderVelocityChart({ days: [], color: '#F0E442' });
    assert.match(svg, /^<svg\b/);
    assert.doesNotMatch(svg, /<rect\b/);
  });

  test('renders one bar per day and skips zero-total days', () => {
    const svg = renderVelocityChart({
      days: [
        { date: '2026-06-01', total: 0 },
        { date: '2026-06-02', total: 50 },
        { date: '2026-06-03', total: 0 },
      ],
      color: '#F0E442',
    });
    const rects = (svg.match(/<rect\b/g) ?? []).length;
    assert.equal(rects, 1);
  });

  test('emits x-axis labels formatted as "Mon D"', () => {
    const svg = renderVelocityChart({
      days: [
        { date: '2026-06-01', total: 10 },
        { date: '2026-06-08', total: 20 },
      ],
      color: '#F0E442',
    });
    assert.match(svg, /Jun 1/);
    assert.match(svg, /Jun 8/);
  });

  test('peakDate bar is rendered with a distinct fill', () => {
    const svg = renderVelocityChart({
      days: [
        { date: '2026-06-01', total: 100 },
        { date: '2026-06-02', total: 200 },
      ],
      color: '#F0E442',
      peakDate: '2026-06-02',
    });
    // Two rects with two DIFFERENT fill attributes.
    const fills = [...svg.matchAll(/<rect[^>]*fill="([^"]+)"/g)].map((m) => m[1]);
    assert.equal(fills.length, 2);
    assert.notEqual(fills[0], fills[1]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test 2>&1 | grep -E "velocity|not ok" | head -5`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the velocity chart helper**

Create `src/dashboard/render/velocity.ts`:

```ts
export type VelocityDay = { date: string; total: number };

export function renderVelocityChart(opts: {
  days: readonly VelocityDay[];
  color: string;
  width?: number;
  height?: number;
  peakDate?: string | null;
}): string {
  const w = opts.width ?? 640;
  const h = opts.height ?? 140;
  const padLeft = 10;
  const padRight = 10;
  const padTop = 8;
  const padBottom = 18;
  const drawW = w - padLeft - padRight;
  const drawH = h - padTop - padBottom;

  if (opts.days.length === 0) {
    return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true"></svg>`;
  }

  const max = Math.max(1, ...opts.days.map((d) => d.total));
  const slot = drawW / opts.days.length;
  const barW = Math.max(2, slot * 0.7);

  const peakFill = darken(opts.color, 0.15);
  const bars: string[] = [];
  for (let i = 0; i < opts.days.length; i++) {
    const d = opts.days[i]!;
    if (d.total <= 0) continue;
    const barH = Math.max(1, (d.total / max) * drawH);
    const x = padLeft + i * slot + (slot - barW) / 2;
    const y = padTop + (drawH - barH);
    const fill = opts.peakDate === d.date ? peakFill : opts.color;
    bars.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${barH.toFixed(1)}" fill="${escapeAttr(fill)}" rx="1" />`);
  }

  // X-axis: label every ~7th day, always including the first and last day.
  const labels: string[] = [];
  const labelIndices = new Set<number>([0, opts.days.length - 1]);
  for (let i = 7; i < opts.days.length - 3; i += 7) labelIndices.add(i);
  for (const i of labelIndices) {
    const d = opts.days[i]!;
    const cx = padLeft + i * slot + slot / 2;
    labels.push(`<text x="${cx.toFixed(1)}" y="${(h - 4).toFixed(1)}" font-size="10" fill="#6b563d" text-anchor="middle">${formatShortDate(d.date)}</text>`);
  }

  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">${bars.join('')}${labels.join('')}</svg>`;
}

function formatShortDate(iso: string): string {
  // iso is yyyy-mm-dd; parse without a timezone shift.
  const [y, m, dRaw] = iso.split('-').map(Number);
  const d = dRaw ?? 1;
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${MONTHS[(m ?? 1) - 1]} ${d}`;
}

function darken(hex: string, amount: number): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const dr = Math.max(0, Math.round(r * (1 - amount)));
  const dg = Math.max(0, Math.round(g * (1 - amount)));
  const db = Math.max(0, Math.round(b * (1 - amount)));
  return `#${dr.toString(16).padStart(2,'0')}${dg.toString(16).padStart(2,'0')}${db.toString(16).padStart(2,'0')}`;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test 2>&1 | tail -8`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/render/velocity.ts tests/velocity-render.test.ts
git commit -m "$(cat <<'EOF'
feat(render): server-side SVG velocity bar chart

Drop-in replacement for the client-rendered trail-elevation area chart
on the project page. One bar per day, peak-day fill darkens the same
hue, x-axis labels every ~7 days. No JS.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Rewrite render/project.ts skeleton with Hero + section placeholders

**Files:**
- Modify: `src/dashboard/render/project.ts`
- Test: `tests/project-render.test.ts`

**Interfaces:**
- Consumes: `ProjectDetailVM` with the extensions from Tasks 1 and 2, `resolveProjectColors`, `shadeForFeature` from `src/dashboard/lib/feature-colors.js`, `escapeHtml` from `src/dashboard/render/shell.js`.
- Produces: `renderProject(vm)` returns HTML with a single `<div class="project-page">` root containing five `<section>` elements (`hero`, `velocity`, `features`, `active-work`, `worth-reconciling`) — each carrying a `data-section="<slug>"` attribute so structural tests can grep for them. Only the hero has content in this task; the others are empty stubs.

- [ ] **Step 1: Write the failing tests**

Create `tests/project-render.test.ts`:

```ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { renderProject } from '../src/dashboard/render/project.js';
import type { ProjectDetailVM } from '../src/dashboard/data/project.js';

function baseVm(overrides: Partial<ProjectDetailVM> = {}): ProjectDetailVM {
  return {
    projectKey: 'repo:loschenbd/archi',
    projectName: 'archi',
    totalUsd: 2203,
    priorUsd: 288,
    deltaPct: 649,
    sessionCount: 17,
    featureCount: 18,
    avgUsdPerDay: 73,
    weekStats: {
      thisWeekUsd: 487, lastWeekUsd: 661, priorWeekUsd: 419,
      thisVsLastPct: -26, lastVsPriorPct: 58,
    },
    peakDay: { date: '2026-06-15', totalUsd: 412, featureKey: 'local-rag-chatbot', featureName: 'Local RAG + chatbot' },
    dailySeries: [],
    features: [
      { featureKey: 'local-rag-chatbot', featureName: 'Local RAG + chatbot', totalUsd: 765, sessionCount: 5, lastActive: '2026-06-27', daily: [] },
    ],
    sessions: [],
    recentCommits: [],
    anomalies: [],
    branchGraph: null,
    ...overrides,
  };
}

describe('renderProject skeleton', () => {
  test('renders five sections in order: hero, velocity, features, active-work, worth-reconciling', () => {
    const html = renderProject(baseVm());
    const order = ['hero', 'velocity', 'features', 'active-work', 'worth-reconciling'];
    let last = -1;
    for (const s of order) {
      const idx = html.indexOf(`data-section="${s}"`);
      assert.ok(idx > last, `section ${s} should appear (found idx=${idx}, last=${last})`);
      last = idx;
    }
  });

  test('hero shows repo label, name, total, delta, session/feature counts, most-active feature', () => {
    const html = renderProject(baseVm());
    assert.match(html, /REPO:LOSCHENBD\/ARCHI/);
    assert.match(html, />archi</);
    assert.match(html, /\$2,?203/);
    assert.match(html, /▲649% vs prior/);
    assert.match(html, /17 sessions/);
    assert.match(html, /18 features/);
    assert.match(html, /Local RAG \+ chatbot/);
  });

  test('hero shows "(new project)" delta line when priorUsd is 0', () => {
    const html = renderProject(baseVm({ priorUsd: 0, deltaPct: 100 }));
    assert.match(html, /\(new project\)/);
  });

  test('hero omits most-active line when features is empty', () => {
    const html = renderProject(baseVm({ features: [] }));
    assert.doesNotMatch(html, /most active:/i);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test 2>&1 | grep -E "renderProject skeleton|not ok" | head -10`
Expected: FAIL — data-section attributes not present in current render output.

- [ ] **Step 3: Rewrite `src/dashboard/render/project.ts`**

Replace the entire file with:

```ts
import type { ProjectDetailVM } from '../data/project.js';
import { escapeHtml } from './shell.js';
import { resolveProjectColors } from '../lib/feature-colors.js';

export function renderProject(vm: ProjectDetailVM): string {
  const color = resolveProjectColors([vm.projectKey])[vm.projectKey]!;
  return `
<div class="project-page single-col" data-project-key="${escapeHtml(vm.projectKey)}" data-project-color="${escapeHtml(color)}">
  ${renderHero(vm)}
  <section class="card" data-section="velocity"></section>
  <section class="card" data-section="features"></section>
  <section class="card" data-section="active-work"></section>
  <section class="card" data-section="worth-reconciling"></section>
</div>
  `;
}

function renderHero(vm: ProjectDetailVM): string {
  const label = renderRepoLabel(vm.projectKey);
  const deltaLine = renderDeltaLine(vm);
  const mostActive = vm.features.length > 0
    ? `<div class="hero-most-active">most active: <a href="/feature/${encodeURIComponent(vm.features[0]!.featureKey)}">${escapeHtml(vm.features[0]!.featureName || vm.features[0]!.featureKey)}</a> <span class="muted">($${vm.features[0]!.totalUsd.toFixed(0)})</span></div>`
    : '';
  return `
    <section class="card project-hero" data-section="hero">
      <div class="label">${label}</div>
      <div class="hero">${escapeHtml(vm.projectName)}</div>
      <div class="hero-amount">$${formatUsdCommas(vm.totalUsd)}</div>
      ${deltaLine}
      <div class="hero-meta">${vm.sessionCount} sessions · ${vm.featureCount} features</div>
      ${mostActive}
    </section>`;
}

function renderRepoLabel(projectKey: string): string {
  // Preserves the existing key namespace vocabulary — the label just
  // upper-cases it so it reads like a header tag.
  return escapeHtml(projectKey.toUpperCase());
}

function renderDeltaLine(vm: ProjectDetailVM): string {
  if (vm.priorUsd === 0 && vm.totalUsd > 0) {
    return `<div class="hero-delta up">(new project)</div>`;
  }
  const arrow = vm.deltaPct >= 0 ? '▲' : '▼';
  const cls = vm.deltaPct >= 0 ? 'up' : 'down';
  const diff = vm.totalUsd - vm.priorUsd;
  const diffStr = `$${formatUsdCommas(Math.abs(diff))} ${diff >= 0 ? 'more' : 'less'}`;
  return `<div class="hero-delta ${cls}">${arrow} ${Math.abs(vm.deltaPct)}% vs prior · <span class="muted">${diffStr}</span></div>`;
}

function formatUsdCommas(n: number): string {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test 2>&1 | tail -8`
Expected: all pass. The existing `tests/project-data.test.ts` tests still pass — we changed the render layer, not the data layer.

- [ ] **Step 5: Verify the page still loads**

```bash
npm run build 2>&1 | grep -E "error TS" | head -3
pkill -f "node dist/src/index.js dashboard" 2>/dev/null; sleep 1; node dist/src/index.js dashboard --no-open > /tmp/tt.log 2>&1 &
sleep 2
curl -s http://127.0.0.1:4920/project/repo:loschenbd/archi | head -c 400
```
Expected: HTTP 200; response contains `data-section="hero"`.

- [ ] **Step 6: Commit**

```bash
git add src/dashboard/render/project.ts tests/project-render.test.ts
git commit -m "$(cat <<'EOF'
feat(project-render): five-section skeleton + rewritten hero card

Replaces the ad-hoc card stack with a project-page container whose five
sections (hero, velocity, features, active-work, worth-reconciling)
render in a deterministic order — each carrying data-section="<slug>"
for tests. Hero shows repo label, name, total, dollar-delta plus
"(new project)" edge case, sessions/features counts, and a most-active
feature link. Other sections are empty stubs; subsequent tasks fill
them in.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Velocity section — chart + week callouts + peak day

**Files:**
- Modify: `src/dashboard/render/project.ts`
- Modify: `src/dashboard/static/dashboard.css`
- Test: `tests/project-render.test.ts`

**Interfaces:**
- Consumes: `renderVelocityChart` from Task 4, VM fields from Task 1 (`avgUsdPerDay`, `weekStats`, `peakDay`, `dailySeries`), the `data-project-color` on the container.
- Produces: the `<section data-section="velocity">` gains a header stat row (`$total · $avg/day · deltaPct vs prior 30d`), an inline SVG bar chart, and three callout rows (this week / last week / peak day). The section's inner HTML is filled in — no other structural changes.

- [ ] **Step 1: Write the failing tests**

Append to `tests/project-render.test.ts`:

```ts
describe('renderProject velocity section', () => {
  test('velocity section shows total, avg/day, and delta stat row', () => {
    const html = renderProject(baseVm());
    const seg = extractSection(html, 'velocity');
    assert.match(seg, /\$2,?203 total/);
    assert.match(seg, /\$73\/day avg/);
    assert.match(seg, /▲649% vs prior 30d/);
  });

  test('velocity section embeds an svg bar chart', () => {
    const vm = baseVm({
      dailySeries: [
        { date: '2026-06-14', total: 0, commits: 0, prs: 0 },
        { date: '2026-06-15', total: 412, commits: 0, prs: 0 },
        { date: '2026-06-16', total: 50, commits: 0, prs: 0 },
      ],
    });
    const seg = extractSection(renderProject(vm), 'velocity');
    assert.match(seg, /<svg\b[^>]*viewBox/);
    assert.match(seg, /<rect\b/);
  });

  test('week callouts render both totals and their delta arrows', () => {
    const seg = extractSection(renderProject(baseVm()), 'velocity');
    assert.match(seg, /This week/);
    assert.match(seg, /\$487/);
    assert.match(seg, /▼26% vs last week/);
    assert.match(seg, /Last week/);
    assert.match(seg, /\$661/);
    assert.match(seg, /▲58% vs prior week/);
  });

  test('peak day row shows date, amount, and the driving feature', () => {
    const seg = extractSection(renderProject(baseVm()), 'velocity');
    assert.match(seg, /Peak day/);
    assert.match(seg, /Jun 15/);
    assert.match(seg, /\$412/);
    assert.match(seg, /Local RAG \+ chatbot/);
  });

  test('peak day row omitted when peakDay is null', () => {
    const seg = extractSection(renderProject(baseVm({ peakDay: null })), 'velocity');
    assert.doesNotMatch(seg, /Peak day/);
  });
});

// helper — extract the `<section data-section="X">...</section>` slice.
function extractSection(html: string, name: string): string {
  const start = html.indexOf(`data-section="${name}"`);
  if (start === -1) return '';
  const openEnd = html.indexOf('>', start) + 1;
  const close = html.indexOf('</section>', openEnd);
  return html.slice(openEnd, close);
}
```

Note: `extractSection` should be declared at the bottom of the file, outside all `describe` blocks, so both existing and new tests can use it.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test 2>&1 | grep -E "velocity section|not ok" | head -10`
Expected: FAIL — section body is empty.

- [ ] **Step 3: Extend `renderProject` and add `renderVelocity`**

In `src/dashboard/render/project.ts`:

1. Add the import at top:
```ts
import { renderVelocityChart } from './velocity.js';
```

2. Replace the empty velocity stub in the returned HTML:
```ts
  <section class="card" data-section="velocity"></section>
```
with:
```ts
  ${renderVelocity(vm, color)}
```

3. Add the new function at the bottom of the file:

```ts
function renderVelocity(vm: ProjectDetailVM, color: string): string {
  const chart = renderVelocityChart({
    days: vm.dailySeries.map((d) => ({ date: d.date, total: d.total })),
    color,
    peakDate: vm.peakDay?.date ?? null,
  });
  const ws = vm.weekStats;
  const statLine = `$${formatUsdCommas(vm.totalUsd)} total · $${Math.round(vm.avgUsdPerDay)}/day avg · ${vm.deltaPct >= 0 ? '▲' : '▼'}${Math.abs(vm.deltaPct)}% vs prior ${vm.dailySeries.length}d`;
  const arrow = (n: number) => (n >= 0 ? '▲' : '▼');
  const abs = (n: number) => Math.abs(n);
  const peak = vm.peakDay
    ? `<div class="velocity-row"><span class="k">Peak day</span><span class="v">${formatMonDay(vm.peakDay.date)} · $${formatUsdCommas(vm.peakDay.totalUsd)} <span class="muted">(Feature: <a href="/feature/${encodeURIComponent(vm.peakDay.featureKey)}">${escapeHtml(vm.peakDay.featureName || vm.peakDay.featureKey)}</a>)</span></span></div>`
    : '';
  return `
    <section class="card chart-card" data-section="velocity">
      <div class="label">Velocity · last ${vm.dailySeries.length} days</div>
      <div class="velocity-stat">${statLine}</div>
      <div class="velocity-chart">${chart}</div>
      <div class="velocity-rows">
        <div class="velocity-row"><span class="k">This week</span><span class="v">$${formatUsdCommas(ws.thisWeekUsd)}  <span class="muted">${arrow(ws.thisVsLastPct)}${abs(ws.thisVsLastPct)}% vs last week</span></span></div>
        <div class="velocity-row"><span class="k">Last week</span><span class="v">$${formatUsdCommas(ws.lastWeekUsd)}  <span class="muted">${arrow(ws.lastVsPriorPct)}${abs(ws.lastVsPriorPct)}% vs prior week</span></span></div>
        ${peak}
      </div>
    </section>`;
}

function formatMonDay(iso: string): string {
  const [_, m, dRaw] = iso.split('-').map(Number);
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${MONTHS[(m ?? 1) - 1]} ${dRaw ?? 1}`;
}
```

- [ ] **Step 4: Add CSS for the velocity section**

Append to `src/dashboard/static/dashboard.css`:

```css
/* --- project detail: velocity section --- */
.project-page .velocity-stat {
  font-family: var(--font-sans);
  font-size: 13px;
  color: #4a3a24;
  margin: 2px 0 8px;
}
.project-page .velocity-chart svg {
  width: 100%;
  height: auto;
  display: block;
}
.project-page .velocity-rows {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.project-page .velocity-row {
  display: flex;
  gap: 12px;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.project-page .velocity-row .k {
  min-width: 90px;
  color: #6b563d;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  font-size: 10px;
  padding-top: 1px;
}
.project-page .velocity-row .v { flex: 1; }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test 2>&1 | tail -8`
Expected: all pass.

- [ ] **Step 6: Manual visual check**

```bash
npm run build 2>&1 | grep -E "error TS" | head -3
pkill -f "node dist/src/index.js dashboard" 2>/dev/null; sleep 1; node dist/src/index.js dashboard --no-open > /tmp/tt.log 2>&1 &
sleep 2
```
Then load `http://127.0.0.1:4920/project/repo:loschenbd/archi` in a browser and confirm the velocity section shows: header stat, bar chart, three callout rows. The chart bars should be in archi's project hue with the peak day slightly darker.

- [ ] **Step 7: Commit**

```bash
git add src/dashboard/render/project.ts src/dashboard/static/dashboard.css tests/project-render.test.ts
git commit -m "$(cat <<'EOF'
feat(project-render): velocity section (bars, week callouts, peak day)

Replaces the client-rendered trail-elevation chart with a server-side
SVG velocity bar chart, colored in the project's own hue. Rolling week
callouts + peak-day row give the reader the "trending up or down"
answer without doing arithmetic on the chart.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Features section — two-line rows with sparkline + lastActive

**Files:**
- Modify: `src/dashboard/render/project.ts`
- Modify: `src/dashboard/static/dashboard.css`
- Test: `tests/project-render.test.ts`

**Interfaces:**
- Consumes: `renderSparkline` from Task 3, `shadeForFeature` + `resolveProjectColors` from `src/dashboard/lib/feature-colors.js`, VM fields from Task 2 (`features[].lastActive`, `features[].daily`).
- Produces: the `<section data-section="features">` gains a `FEATURES · N` header and a list of two-line feature rows. Each row is a clickable link to `/feature/<key>`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/project-render.test.ts`:

```ts
describe('renderProject features section', () => {
  function fullVm() {
    return baseVm({
      totalUsd: 1000,
      features: [
        { featureKey: 'local-rag-chatbot', featureName: 'Local RAG + chatbot', totalUsd: 765, sessionCount: 5, lastActive: '2026-06-27', daily: [{date:'2026-06-20', totalUsd:0},{date:'2026-06-21', totalUsd:200},{date:'2026-06-27', totalUsd:565}] },
        { featureKey: 'archi-homepage-redesign', featureName: 'Archi homepage redesign', totalUsd: 235, sessionCount: 3, lastActive: '2026-06-21', daily: [{date:'2026-06-20', totalUsd:100},{date:'2026-06-21', totalUsd:135}] },
      ],
    });
  }

  test('features section header includes the count', () => {
    const seg = extractSection(renderProject(fullVm()), 'features');
    assert.match(seg, /FEATURES/i);
    assert.match(seg, /· 2/);
  });

  test('each row shows rank, name, sessions, lastActive, amount, share', () => {
    const seg = extractSection(renderProject(fullVm()), 'features');
    assert.match(seg, /Local RAG \+ chatbot/);
    assert.match(seg, />5 sess</);   // sessions count
    assert.match(seg, /Jun 27/);      // lastActive formatted as Mon D
    assert.match(seg, /\$765/);
    assert.match(seg, /77%/);         // 765 / 1000
    assert.match(seg, /Archi homepage redesign/);
    assert.match(seg, />3 sess</);
    assert.match(seg, /Jun 21/);
    assert.match(seg, /\$235/);
    assert.match(seg, /24%/);         // 235 / 1000
  });

  test('row is a link to /feature/<key>', () => {
    const seg = extractSection(renderProject(fullVm()), 'features');
    assert.match(seg, /href="\/feature\/local-rag-chatbot"/);
  });

  test('sparkline svg is embedded per row', () => {
    const seg = extractSection(renderProject(fullVm()), 'features');
    const svgs = (seg.match(/<svg\b/g) ?? []).length;
    assert.equal(svgs, 2);
  });

  test('empty features → muted note, no rows', () => {
    const seg = extractSection(renderProject(baseVm({ features: [] })), 'features');
    assert.match(seg, /No features in window/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test 2>&1 | grep -E "features section|not ok" | head -10`
Expected: FAIL.

- [ ] **Step 3: Implement `renderFeatures`**

In `src/dashboard/render/project.ts`:

1. Update the imports at top:
```ts
import { resolveProjectColors, shadeForFeature } from '../lib/feature-colors.js';
import { renderSparkline } from './sparkline.js';
```

2. Replace the empty features stub:
```ts
  <section class="card" data-section="features"></section>
```
with:
```ts
  ${renderFeatures(vm, color)}
```

3. Add:

```ts
function renderFeatures(vm: ProjectDetailVM, color: string): string {
  if (vm.features.length === 0) {
    return `
    <section class="card" data-section="features">
      <div class="label">Features</div>
      <div class="muted">No features in window.</div>
    </section>`;
  }
  const denom = vm.totalUsd > 0 ? vm.totalUsd : 1;
  const rows = vm.features.map((f, i) => {
    const share = Math.round((f.totalUsd / denom) * 100);
    const shade = shadeForFeature(color, f.featureKey);
    const spark = renderSparkline({
      points: f.daily,
      color: shade,
      width: 96,
      height: 18,
      ariaLabel: `${f.featureKey} 30d`,
    });
    const rawName = f.featureName || f.featureKey;
    const displayName = rawName.length > 40 ? rawName.slice(0, 39) + '…' : rawName;
    return `
      <a class="pfeat-row" href="/feature/${encodeURIComponent(f.featureKey)}" title="${escapeHtml(rawName)}">
        <span class="pfeat-rank">${i + 1}</span>
        <span class="pfeat-name">${escapeHtml(displayName)}</span>
        <span class="pfeat-amt">$${formatUsdCommas(f.totalUsd)} · ${share}%</span>
        <span class="pfeat-meta"><span class="pfeat-sess">${f.sessionCount} sess</span> · <span class="pfeat-last">last ${formatMonDay(f.lastActive)}</span></span>
        <span class="pfeat-spark">${spark}</span>
      </a>`;
  }).join('');
  return `
    <section class="card" data-section="features">
      <div class="label">Features · ${vm.features.length}</div>
      <div class="pfeat-list">${rows}</div>
    </section>`;
}
```

- [ ] **Step 4: Add CSS for the two-line feature row**

Append to `src/dashboard/static/dashboard.css`:

```css
/* --- project detail: features list --- */
.project-page .pfeat-list { display: flex; flex-direction: column; gap: 6px; }
.project-page .pfeat-row {
  display: grid;
  grid-template-columns: 24px 1fr auto;
  grid-template-areas:
    "rank name amt"
    ".    meta spark";
  gap: 2px 8px;
  padding: 8px 10px;
  border-radius: 4px;
  text-decoration: none;
  color: inherit;
}
.project-page .pfeat-row:hover { background: rgba(139,111,71,0.06); }
.project-page .pfeat-rank {
  grid-area: rank;
  color: #6b563d;
  font-variant-numeric: tabular-nums;
  font-size: 12px;
  padding-top: 2px;
}
.project-page .pfeat-name {
  grid-area: name;
  font-weight: 600;
  color: #4a3a24;
}
.project-page .pfeat-amt {
  grid-area: amt;
  font-variant-numeric: tabular-nums;
  color: #4a3a24;
}
.project-page .pfeat-meta {
  grid-area: meta;
  color: #6b563d;
  font-size: 12px;
}
.project-page .pfeat-spark {
  grid-area: spark;
  display: inline-block;
  line-height: 0;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test 2>&1 | tail -8`
Expected: all pass.

- [ ] **Step 6: Manual visual check**

Rebuild, restart dashboard, load `/project/repo:loschenbd/archi` — features list should show two lines per feature with a small sparkline in the project's hue.

- [ ] **Step 7: Commit**

```bash
git add src/dashboard/render/project.ts src/dashboard/static/dashboard.css tests/project-render.test.ts
git commit -m "$(cat <<'EOF'
feat(project-render): features section with sparkline + last-active

Two-line rows: rank + name + amount on the top line, "N sess · last Jun D"
+ shaded sparkline on the second. Sparkline color is
shadeForFeature(projectColor, featureKey) so a feature reads the same
colour on the overview burn-paths and here.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Active work section — compact branch graph + summary + inline commits

**Files:**
- Modify: `src/dashboard/render/project.ts`
- Modify: `src/dashboard/static/dashboard.css`
- Test: `tests/project-render.test.ts`

**Interfaces:**
- Consumes: `vm.branchGraph` (existing shape from `data/branches.ts`), `vm.recentCommits`, existing client-side `renderBranchGraph()` in `dashboard.js` which reads a `#branch-graph-data` JSON blob and mounts into `#branch-graph`.
- Produces: `<section data-section="active-work">` renders in this order — branch summary counts + names, the branch-graph mount + its JSON payload, and inline commit rows. The mount div height shrinks from `120px` to `120–140px` (unchanged — the visual crop is CSS-only). The old "Recent commits" separate card is REMOVED from the render output.

- [ ] **Step 1: Write the failing tests**

Append to `tests/project-render.test.ts`:

```ts
describe('renderProject active-work section', () => {
  const branchGraph = {
    days: 30,
    totalBranches: 3,
    totalUsd: 12,
    // Minimal shape — the renderer just carries it through as JSON.
    branches: [
      { name: 'onboarding-wizard', state: 'merged', mergedAt: '2026-06-09', totalUsd: 0, sessions: 0 },
      { name: 'coherence-pass', state: 'stale', mergedAt: null, totalUsd: 0, sessions: 0 },
      { name: 'worktree-local-semantic-search', state: 'open', mergedAt: null, totalUsd: 12, sessions: 0 },
    ],
  } as any;

  test('branch summary shows open / merged / stale counts with names', () => {
    const seg = extractSection(renderProject(baseVm({ branchGraph })), 'active-work');
    assert.match(seg, /Open\s*1/);
    assert.match(seg, /worktree-local-semantic-search/);
    assert.match(seg, /Merged\s*1/);
    assert.match(seg, /onboarding-wizard/);
    assert.match(seg, /Stale\s*1/);
    assert.match(seg, /coherence-pass/);
  });

  test('branch graph mount + JSON payload are embedded', () => {
    const seg = extractSection(renderProject(baseVm({ branchGraph })), 'active-work');
    assert.match(seg, /id="branch-graph"/);
    assert.match(seg, /id="branch-graph-data"/);
  });

  test('recent commits render inline (not in a separate card)', () => {
    const seg = extractSection(renderProject(baseVm({
      branchGraph,
      recentCommits: [
        { sha: 'a2c6cad1000000', subject: 'fix: nodes grow by radius', repo: 'loschenbd/archi', authoredAt: '2026-06-09T00:00:00Z' },
      ],
    })), 'active-work');
    assert.match(seg, /a2c6cad1/);
    assert.match(seg, /fix: nodes grow by radius/);
  });

  test('empty state: no branches AND no commits → gentle placeholder', () => {
    const seg = extractSection(renderProject(baseVm({ branchGraph: null, recentCommits: [] })), 'active-work');
    assert.match(seg, /No branches touched archi in this window/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test 2>&1 | grep -E "active-work|not ok" | head -10`
Expected: FAIL.

- [ ] **Step 3: Implement `renderActiveWork`**

In `src/dashboard/render/project.ts`, replace:
```ts
  <section class="card" data-section="active-work"></section>
```
with:
```ts
  ${renderActiveWork(vm)}
```

Add:

```ts
function renderActiveWork(vm: ProjectDetailVM): string {
  const hasBranches = vm.branchGraph && vm.branchGraph.branches && vm.branchGraph.branches.length > 0;
  const hasCommits = vm.recentCommits.length > 0;
  if (!hasBranches && !hasCommits) {
    return `
    <section class="card" data-section="active-work">
      <div class="label">Active work · last 30d</div>
      <div class="muted">No branches touched ${escapeHtml(vm.projectName)} in this window.</div>
    </section>`;
  }
  const summary = hasBranches ? renderBranchSummary(vm.branchGraph!) : '';
  const graph = hasBranches
    ? `<div id="branch-graph" data-branch-graph style="width:100%;min-height:120px;max-height:140px;overflow:hidden"></div>
       <script type="application/json" id="branch-graph-data">${jsonForScriptTag(vm.branchGraph)}</script>`
    : '';
  const totalBranchUsd = hasBranches ? vm.branchGraph!.totalUsd : 0;
  const commits = hasCommits
    ? `<div class="commits-inline">
         <div class="label subheader">Recent commits</div>
         ${vm.recentCommits.map((c) => {
           const shaShort = c.sha.slice(0, 8);
           const url = c.repo ? `https://github.com/${c.repo}/commit/${c.sha}` : null;
           const sha = url
             ? `<a class="sha" href="${escapeHtml(url)}" target="_blank" rel="noopener">${shaShort}</a>`
             : `<span class="sha">${shaShort}</span>`;
           return `<div class="commit-row">${sha} <span class="subject">${escapeHtml(c.subject)}</span></div>`;
         }).join('')}
       </div>`
    : '';
  return `
    <section class="card chart-card" data-section="active-work">
      <div class="label">Active work · last ${vm.branchGraph?.days ?? 30}d <span class="amt-tag">$${totalBranchUsd.toFixed(0)}</span></div>
      ${graph}
      ${summary}
      ${commits}
    </section>`;
}

function renderBranchSummary(bg: NonNullable<ProjectDetailVM['branchGraph']>): string {
  type BranchLike = { name: string; state?: string; totalUsd?: number };
  const branches = (bg.branches ?? []) as BranchLike[];
  const bucket = (state: string) => branches.filter((b) => b.state === state);
  const rowFor = (label: string, state: string) => {
    const items = bucket(state);
    if (items.length === 0) return '';
    const inline = items.map((b) => {
      const usd = (b.totalUsd ?? 0) > 0 ? ` <span class="muted">$${(b.totalUsd ?? 0).toFixed(0)}</span>` : '';
      return `<span class="bsum-name">${escapeHtml(b.name)}${usd}</span>`;
    }).join(' · ');
    return `<div class="bsum-row"><span class="bsum-k">${label}</span><span class="bsum-n">${items.length}</span><span class="bsum-v">${inline}</span></div>`;
  };
  return `<div class="branch-summary">
    ${rowFor('Open',   'open')}
    ${rowFor('Merged', 'merged')}
    ${rowFor('Stale',  'stale')}
  </div>`;
}
```

- [ ] **Step 4: Add CSS**

Append to `src/dashboard/static/dashboard.css`:

```css
/* --- project detail: active work --- */
.project-page section[data-section="active-work"] .amt-tag {
  float: right;
  font-family: var(--font-sans);
  font-variant-numeric: tabular-nums;
  color: #6b563d;
}
.project-page .branch-summary {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.project-page .bsum-row {
  display: grid;
  grid-template-columns: 70px 30px 1fr;
  font-size: 12px;
  align-items: baseline;
}
.project-page .bsum-k {
  color: #6b563d;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  font-size: 10px;
}
.project-page .bsum-n { font-variant-numeric: tabular-nums; font-weight: 600; color: #4a3a24; }
.project-page .bsum-v .bsum-name { display: inline; }
.project-page .commits-inline { margin-top: 14px; }
.project-page .commits-inline .subheader { margin-bottom: 4px; }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test 2>&1 | tail -8`
Expected: all pass.

- [ ] **Step 6: Manual visual check**

Rebuild, restart, load the archi project page. Confirm:
- Branch graph is visible but no taller than ~140 px.
- Open / Merged / Stale summary rows show correct counts and names.
- Recent commits appear inline in the same section, no separate card.

- [ ] **Step 7: Commit**

```bash
git add src/dashboard/render/project.ts src/dashboard/static/dashboard.css tests/project-render.test.ts
git commit -m "$(cat <<'EOF'
feat(project-render): active-work section with compact graph + inline commits

Merges the old branch-graph card and the recent-commits card into a
single "Active work" section. Adds an Open / Merged / Stale summary
below the graph so state is scannable without parsing the graph itself.
Graph CSS caps its height at 140 px so it stops dominating the fold.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Worth reconciling section — project-scoped unattributed + anomalies with cause

**Files:**
- Modify: `src/dashboard/data/project.ts`
- Modify: `src/dashboard/render/project.ts`
- Modify: `src/dashboard/static/dashboard.css`
- Modify: `src/dashboard/static/dashboard.js`
- Test: `tests/project-data.test.ts`
- Test: `tests/project-render.test.ts`

**Interfaces:**
- Consumes: existing `GET /api/infer-mainline/stream` SSE endpoint (shared with the overview CTA).
- Produces: `ProjectDetailVM` gains
  ```ts
  unattributed: {
    totalUsd: number;
    sparkline: Array<{ date: string; usd: number }>;
    topFeatures: Array<{ featureKey: string; featureName: string; usd: number }>;
  } | null;
  ```
  The `<section data-section="worth-reconciling">` renders as one of three states:
  1. Nothing to reconcile (unattributed=0 AND anomalies empty) → the whole section collapses to a single `<div class="reconciled-note">All clear on <name>.</div>` (not a card).
  2. Unattributed present and/or anomalies present → a card with sub-blocks.
  3. Unattributed present but section still renders the anomalies (or empty-state for anomalies).

- [ ] **Step 1: Write the failing tests for the VM extension**

Append to `tests/project-data.test.ts`:

```ts
  test('unattributed block aggregates uncategorized-mainline for this project', () => {
    const db = makeDb();
    const day = (n: number) => (db.prepare(`SELECT date('now','-${n} days','localtime') AS d`).get() as { d: string }).d;
    insertRollup(db, { date: day(1), featureKey: 'uncategorized-mainline', featureName: 'Uncategorized mainline', repo: 'loschenbd/archi', cost: 40, sessionIds: 'sX', sessions: 1 });
    insertRollup(db, { date: day(2), featureKey: 'uncategorized-mainline', featureName: 'Uncategorized mainline', repo: 'loschenbd/archi', cost: 60, sessionIds: 'sY', sessions: 1 });
    insertRollup(db, { date: day(1), featureKey: 'good-feat', featureName: 'Good', repo: 'loschenbd/archi', cost: 20, sessionIds: 'sZ', sessions: 1 });
    const vm = buildProjectDetail(db, { projectKey: 'repo:loschenbd/archi', days: 7 })!;
    assert.ok(vm.unattributed);
    assert.equal(vm.unattributed!.totalUsd, 100);
    assert.equal(vm.unattributed!.sparkline.length, 7);
  });

  test('unattributed is null when the project has no uncategorized-mainline spend', () => {
    const db = makeDb();
    const day = (n: number) => (db.prepare(`SELECT date('now','-${n} days','localtime') AS d`).get() as { d: string }).d;
    insertRollup(db, { date: day(1), featureKey: 'clean', featureName: 'Clean', repo: 'loschenbd/archi', cost: 20, sessionIds: 's1', sessions: 1 });
    const vm = buildProjectDetail(db, { projectKey: 'repo:loschenbd/archi', days: 7 })!;
    assert.equal(vm.unattributed, null);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test 2>&1 | grep -E "unattributed|not ok" | head -5`
Expected: FAIL — `vm.unattributed` is undefined.

- [ ] **Step 3: Extend VM type + populate**

In `src/dashboard/data/project.ts`, add to the `ProjectDetailVM` type:

```ts
  unattributed: {
    totalUsd: number;
    sparkline: Array<{ date: string; usd: number }>;
    topFeatures: Array<{ featureKey: string; featureName: string; usd: number }>;
  } | null;
```

In `buildProjectDetail`, just before the `return { ... }`, insert:

```ts
  // Unattributed block: same 'uncategorized-mainline' key the overview
  // unattributed card uses, scoped to this project. Only rendered when
  // totalUsd > 0.
  const unattTotal = round2(
    (db
      .prepare(`SELECT COALESCE(SUM(total_cost_usd), 0) AS s FROM feature_rollups WHERE ${filterSql} AND feature_key = 'uncategorized-mainline' AND date >= ${startExpr}`)
      .get(filterParams) as { s: number }).s
  );
  const unattSparkline = unattTotal > 0
    ? dailySeries.map((d) => ({
        date: d.date,
        usd: round2((db
          .prepare(`SELECT COALESCE(SUM(total_cost_usd), 0) AS s FROM feature_rollups WHERE ${filterSql} AND feature_key = 'uncategorized-mainline' AND date = @day`)
          .get({ ...filterParams, day: d.date }) as { s: number }).s),
      }))
    : [];
  const unattributed = unattTotal > 0
    ? { totalUsd: unattTotal, sparkline: unattSparkline, topFeatures: [] as Array<{ featureKey: string; featureName: string; usd: number }> }
    : null;
```

Add `unattributed` to the return object:

```ts
    unattributed,
```

- [ ] **Step 4: Verify VM tests pass, add render tests**

```bash
npm test 2>&1 | tail -5
```
Expected: all pass.

Then append to `tests/project-render.test.ts`:

```ts
describe('renderProject worth-reconciling section', () => {
  test('collapses to "All clear on <name>." when unattributed is null AND anomalies empty', () => {
    const html = renderProject(baseVm({ unattributed: null, anomalies: [] }));
    assert.match(html, /All clear on archi\./);
    // The section container should NOT be present.
    assert.doesNotMatch(html, /data-section="worth-reconciling"/);
  });

  test('renders unattributed subblock when unattributed is non-null', () => {
    const vm = baseVm({
      unattributed: {
        totalUsd: 155,
        sparkline: [{ date: '2026-06-01', usd: 40 }, { date: '2026-06-02', usd: 115 }],
        topFeatures: [],
      },
    });
    const seg = extractSection(renderProject(vm), 'worth-reconciling');
    assert.match(seg, /Unattributed on archi/);
    assert.match(seg, /\$155/);
    assert.match(seg, /<svg\b/);
    assert.match(seg, /Run <code>tokentrail infer-mainline<\/code>/);
  });

  test('renders unattributed positive empty state when null', () => {
    const vm = baseVm({
      unattributed: null,
      anomalies: [
        { id: 1, kind: 'spike_day', date: '2026-06-15', featureKey: 'local-rag-chatbot', sessionId: '075fff73', amount: 412, reason: '4.2× the prior week', cause: { kind: 'session', ref: '075fff73', label: 'brainstorm copy' } } as any,
      ],
    });
    const seg = extractSection(renderProject(vm), 'worth-reconciling');
    assert.match(seg, /all sessions attributed/);
  });

  test('renders anomaly rows with cause line', () => {
    const vm = baseVm({
      anomalies: [
        { id: 1, kind: 'spike_day', date: '2026-06-15', featureKey: 'local-rag-chatbot', sessionId: '075fff73abc', amount: 412, reason: '4.2× the prior week', cause: { kind: 'session', ref: '075fff73abc', label: 'brainstorm copy' } } as any,
      ],
    });
    const seg = extractSection(renderProject(vm), 'worth-reconciling');
    assert.match(seg, /4\.2× the prior week/);
    assert.match(seg, /brainstorm copy/);
    assert.match(seg, /href="\/session\/075fff73abc"/);
  });
});
```

- [ ] **Step 5: Implement `renderWorthReconciling`**

In `src/dashboard/render/project.ts`:

1. Replace:
```ts
  <section class="card" data-section="worth-reconciling"></section>
```
with:
```ts
  ${renderWorthReconciling(vm)}
```

2. Add:

```ts
function renderWorthReconciling(vm: ProjectDetailVM): string {
  const hasAnoms = vm.anomalies.length > 0;
  const hasUnatt = vm.unattributed !== null;
  if (!hasUnatt && !hasAnoms) {
    return `<div class="reconciled-note">All clear on ${escapeHtml(vm.projectName)}.</div>`;
  }
  const unattBlock = hasUnatt
    ? renderUnattSubblock(vm, vm.unattributed!)
    : renderUnattEmpty(vm);
  const anomBlock = hasAnoms
    ? renderAnomalyRows(vm.anomalies)
    : `<div class="muted">No anomalies flagged in this window.</div>`;
  return `
    <section class="card" data-section="worth-reconciling">
      <div class="label">Worth reconciling</div>
      <div class="wr-block wr-unatt">
        <div class="wr-sub-label">Unattributed on ${escapeHtml(vm.projectName)}</div>
        ${unattBlock}
      </div>
      <div class="wr-block wr-anoms">
        <div class="wr-sub-label">Anomalies <span class="muted">${vm.anomalies.length} active</span></div>
        ${anomBlock}
      </div>
    </section>`;
}

function renderUnattEmpty(_vm: ProjectDetailVM): string {
  return `
    <div class="wr-unatt-empty">
      <span class="wr-check">✓</span> $0 <span class="muted">· all sessions attributed</span>
    </div>`;
}

function renderUnattSubblock(vm: ProjectDetailVM, u: NonNullable<ProjectDetailVM['unattributed']>): string {
  // Sparkline uses a muted grey (matches overview unattributed card), NOT
  // the project's hue — visually distinguishes "reconcile" from "spend".
  const svg = renderSparkline({
    points: u.sparkline.map((p) => ({ date: p.date, totalUsd: p.usd })),
    color: '#6b7280',
    width: 220,
    height: 40,
    ariaLabel: 'Unattributed sparkline',
  });
  return `
    <div class="wr-unatt-hero">$${u.totalUsd.toFixed(0)} <span class="muted">of ${escapeHtml(vm.projectName)}</span></div>
    <div class="wr-unatt-spark">${svg}</div>
    <button class="unatt-cta" type="button" data-project-cta>Run <code>tokentrail infer-mainline</code> →</button>
    <div class="unatt-cta-status" role="status" aria-live="polite" hidden></div>`;
}

function renderAnomalyRows(items: ProjectDetailVM['anomalies']): string {
  return items.map((a) => {
    const causeLine = a.cause
      ? (a.cause.kind === 'session'
          ? `<a class="wr-anom-cause" href="/session/${encodeURIComponent(a.cause.ref)}">${escapeHtml(a.cause.label)}</a>`
          : `<span class="wr-anom-cause muted">${escapeHtml(a.cause.label)}</span>`)
      : '';
    return `
      <div class="wr-anom">
        <div class="wr-anom-head"><span class="wr-anom-date">${escapeHtml(a.date)}</span> $${a.amount.toFixed(0)} — ${escapeHtml(a.reason)}</div>
        ${causeLine ? `<div class="wr-anom-cause-row">${causeLine}</div>` : ''}
      </div>`;
  }).join('');
}
```

- [ ] **Step 6: Wire the client CTA to the SSE endpoint**

The overview's unattributed CTA behavior lives in `renderUnattributedCard()` inside `src/dashboard/static/dashboard.js`. Extract the click handler so the project page can reuse it.

In `src/dashboard/static/dashboard.js`, near the top of the IIFE (after `esc`, `fmtUsd`, etc. helpers), add:

```js
  function wireInferMainlineCta(btn, status) {
    if (!btn || !status) return;
    const original = btn.innerHTML;
    btn.addEventListener('click', () => {
      btn.disabled = true;
      btn.textContent = 'Running…';
      status.hidden = false;
      status.innerHTML = 'Starting…';
      const evt = new EventSource('/api/infer-mainline/stream');
      let lastCurrent = 0;
      let lastTotal = 0;
      evt.addEventListener('start', (e) => {
        const d = JSON.parse(e.data);
        status.innerHTML = `Retrying ${d.retriedSessions || 0} stuck sessions…`;
      });
      evt.addEventListener('progress', (e) => {
        const p = JSON.parse(e.data);
        lastCurrent = p.current; lastTotal = p.total;
        const t = (p.title || '(untitled)').slice(0, 60);
        const verb = p.action === 'skip' ? 'skipping' : p.action === 'llm' ? 'LLM' : 'rules';
        status.innerHTML = `Session <b>${p.current}/${p.total}</b> · ${verb}<br><span class="muted">${t}</span>`;
      });
      evt.addEventListener('rollup', () => { status.innerHTML = `Re-rolling up ${lastTotal || ''} sessions…`; });
      evt.addEventListener('done', (e) => {
        const d = JSON.parse(e.data);
        const s = d.summary || {};
        status.innerHTML = `Retried ${d.retriedSessions || 0}, relabeled ${s.sessionsRelabeled || 0} sessions (${s.eventsRelabeled || 0} events). Reloading…`;
        evt.close();
        setTimeout(() => location.reload(), 800);
      });
      evt.addEventListener('error', (e) => {
        try {
          const d = e.data ? JSON.parse(e.data) : null;
          if (d && d.message) status.textContent = 'Error: ' + d.message;
          else if (lastCurrent > 0) status.textContent = `Connection dropped at session ${lastCurrent}/${lastTotal}. Reload and try again.`;
        } catch { /* ignore */ }
        evt.close();
        btn.disabled = false;
        btn.innerHTML = original;
      });
    });
  }
```

Then find the existing block inside `renderUnattributedCard()` that reads `const btn = card.querySelector('.unatt-cta')` and REPLACE the click handler wiring with a single call:

```js
    const btn = card.querySelector('.unatt-cta');
    const status = card.querySelector('.unatt-cta-status');
    wireInferMainlineCta(btn, status);
```

Then, near the `document.addEventListener('DOMContentLoaded', ...)` block, add a project-page wire:

```js
  function wireProjectUnattCta() {
    const btn = document.querySelector('.project-page [data-project-cta]');
    if (!btn) return;
    const status = btn.parentElement?.querySelector('.unatt-cta-status');
    wireInferMainlineCta(btn, status);
  }
```

Add `wireProjectUnattCta();` to the DOMContentLoaded handler.

- [ ] **Step 7: Add CSS for the new blocks**

Append to `src/dashboard/static/dashboard.css`:

```css
/* --- project detail: worth reconciling --- */
.project-page .reconciled-note {
  margin: 12px 0 0;
  padding: 8px 12px;
  color: #4b7a4b;
  font-size: 13px;
}
.project-page .wr-block { margin-top: 12px; }
.project-page .wr-block:first-of-type { margin-top: 4px; }
.project-page .wr-sub-label {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: #6b563d;
  margin-bottom: 4px;
}
.project-page .wr-unatt-hero {
  font-family: var(--font-serif);
  font-size: 22px;
  font-weight: 600;
}
.project-page .wr-unatt-empty { color: #4b7a4b; font-size: 14px; }
.project-page .wr-unatt-empty .wr-check { color: #4b7a4b; font-weight: 700; }
.project-page .wr-unatt-spark svg { width: 100%; height: 40px; }
.project-page .wr-anom { padding: 6px 0; }
.project-page .wr-anom-head { font-size: 13px; }
.project-page .wr-anom-date { color: #6b563d; margin-right: 8px; }
.project-page .wr-anom-cause-row { font-size: 12px; padding-top: 2px; }
.project-page .wr-anom-cause { color: #4a3a24; }
```

- [ ] **Step 8: Verify tests pass**

Run: `npm test 2>&1 | tail -6`
Expected: all pass.

- [ ] **Step 9: Manual end-to-end check**

Rebuild and restart the dashboard. Load the archi project page (or any project with anomalies / unattributed). Verify:
- If clean, the section is a single `All clear on archi.` line, not a card.
- If unattributed nonzero, the section renders the sub-block with hero $, sparkline, CTA button + status area.
- Clicking the CTA opens the SSE stream and updates the status line live (same behavior as the overview button).
- Anomaly cause line renders and links to `/session/<id>` when a session is referenced.

- [ ] **Step 10: Commit**

```bash
git add src/dashboard/data/project.ts src/dashboard/render/project.ts src/dashboard/static/dashboard.css src/dashboard/static/dashboard.js tests/project-data.test.ts tests/project-render.test.ts
git commit -m "$(cat <<'EOF'
feat(project-render): worth-reconciling section + shared CTA wiring

Project-scoped unattributed sub-block with sparkline + the same
Run tokentrail infer-mainline → CTA the overview ships. Anomalies get
a cause line pointing at the session or feature that drove them.

Empty-state collapse: when unattributed is null AND anomalies is empty
the whole section is a single "All clear on <name>." line, not a card.

Extracted the CTA event-source wiring into wireInferMainlineCta() so
the project page and the overview card share one implementation.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Kill the stale client-mounted trail-elevation for the project page

**Files:**
- Modify: `src/dashboard/static/dashboard.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: `renderTrailElevation()` short-circuits when the project page's `#trail-elevation` node is absent (which after Task 5 it always is). No behavior change on the feature page (which still mounts it).

- [ ] **Step 1: Verify the current state**

After Tasks 5-9, the project page no longer renders `#trail-elevation`. Confirm:

```bash
grep -n "trail-elevation" src/dashboard/render/project.ts
```
Expected: empty (no matches).

- [ ] **Step 2: Add an existence guard**

Open `src/dashboard/static/dashboard.js`. Find `function renderTrailElevation()` near line 281. The first line inside is already `const node = document.getElementById('trail-elevation');` — this is fine on its own. But confirm that if `node` is null the function returns early:

```js
  function renderTrailElevation() {
    const node = document.getElementById('trail-elevation');
    const dataNode = document.getElementById('trail-elevation-data');
    if (!node || !dataNode) return;
    // ...
  }
```

If the early return is already there, no change needed. Otherwise add it.

- [ ] **Step 3: Manual check**

Load the archi project page and open the DevTools console. Confirm no `Cannot read properties of null` errors from `renderTrailElevation`. Load a feature page (e.g. `/feature/local-rag-chatbot`) and confirm the trail-elevation still renders there.

- [ ] **Step 4: Commit (if any change needed)**

If Step 2 required a change:

```bash
git add src/dashboard/static/dashboard.js
git commit -m "$(cat <<'EOF'
chore(dashboard): early-return renderTrailElevation when mount absent

Project page no longer mounts #trail-elevation after the redesign.
Feature page still does. Guard the client-side entry so its removal
from the project page doesn't throw.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

If no change was needed, skip the commit and note the fact in the progress ledger.

---

## Task 11: Full-page Playwright smoke check + cleanup

**Files:**
- No source changes expected. Purely a verification pass.

- [ ] **Step 1: Build clean, restart dashboard**

```bash
npm run build 2>&1 | grep -E "error TS" | head -3
pkill -f "node dist/src/index.js dashboard" 2>/dev/null; sleep 1; node dist/src/index.js dashboard --no-open > /tmp/tt.log 2>&1 &
sleep 2
```

- [ ] **Step 2: Confirm the page loads with the new sections**

```bash
curl -s http://127.0.0.1:4920/project/repo:loschenbd/archi | grep -c 'data-section='
```
Expected: 5 (hero, velocity, features, active-work, worth-reconciling) OR 4 if the project is fully clean (worth-reconciling collapses to a note).

- [ ] **Step 3: Confirm all tests still green**

```bash
npm test 2>&1 | tail -5
```
Expected: `# fail 0`.

- [ ] **Step 4: Grep for accidental leftovers**

```bash
grep -n "trail-elevation-data" src/dashboard/render/project.ts
```
Expected: empty.

```bash
grep -rn "renderTrailElevation" src/ --include='*.ts' --include='*.js'
```
Expected: only the definition in `dashboard.js` and the call in the DOMContentLoaded handler (still needed by the feature page).

- [ ] **Step 5: Final commit if there's anything to sweep**

If any cleanup happened here, commit it. Otherwise this task is a verification-only gate and produces no commit — record `Task 11: complete (no changes)` in the progress ledger.

---

## Rollout notes

- No feature flag. Ship as a single PR when all tasks complete.
- No DB migration.
- Rollback: reverting the PR restores the previous render / VM / CSS. No data migration to unwind.
