# Tokentrail Visualization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a local Fastify dashboard for visualizing Tokentrail data and extend the Notion sync with anomaly callouts plus a weekly digest page.

**Architecture:** Anomalies are computed at rollup time and stored in a new `anomalies` SQLite table. A new `tokentrail dashboard` command starts a one-shot Fastify server on `127.0.0.1` that server-renders three routes (Overview, Feature Detail, Worth-a-look) reading directly from SQLite via the existing `getDb()` singleton. The existing `tokentrail sync` is extended to populate two new Notion columns (`Anomaly`, `Anomaly reason`) and to upsert a weekly digest page in the same Notion database.

**Tech Stack:** TypeScript, Fastify, uPlot (vendored), better-sqlite3, commander, @notionhq/client, `node:test` for unit tests.

**Spec:** `docs/superpowers/specs/2026-06-15-tokentrail-visualization-design.md`

---

## File Structure Overview

### New files

```
config/
  anomaly.ts                       # thresholds: spike_day_min, multiplier, etc.

src/
  commands/
    dashboard.ts                   # `tokentrail dashboard` commander entry
    anomaly.ts                     # `tokentrail anomaly dismiss <id>`
  services/
    anomalies.ts                   # computeAnomalies(db) — writes to anomalies table
  dashboard/
    server.ts                      # Fastify app + route registration
    tokens.ts                      # design tokens (colors, type, spacing)
    render/
      shell.ts                     # HTML envelope (head, header, footer)
      overview.ts                  # `/` page template
      feature.ts                   # `/feature/<key>` page template
      worth-a-look.ts              # `/worth-a-look` page template
    data/
      overview.ts                  # view-model for `/`
      feature.ts                   # view-model for `/feature/<key>`
      worth-a-look.ts              # view-model for `/worth-a-look`
    static/
      dashboard.css                # hand-written CSS using tokens
      dashboard.js                 # client-side interaction
      uPlot.iife.min.js            # vendored ~40KB chart lib
      uPlot.min.css                # vendored chart styles

tests/
  anomalies.test.ts                # spike_day, burning_feature, hot_session rules
  dashboard-data.test.ts           # data/overview, data/feature, data/worth-a-look
  notion-digest.test.ts            # weekly digest body builder
```

### Modified files

```
src/db/schema.ts                   # add `anomalies` CREATE TABLE
src/commands/rollup.ts             # call computeAnomalies() after rollup write
src/commands/sync.ts               # populate Anomaly + Anomaly reason; upsert digest
src/services/notion.ts             # add NOTION_PROPS.anomaly{,Reason,type}; weekly digest body
src/index.ts                       # register `dashboard` + `anomaly` commands
package.json                       # add fastify + open + node-test scripts
tsconfig.json                      # add `tests/` to includes
```

### What we deliberately do NOT touch

- `src/lib/attribution.ts` — feature attribution stays as-is.
- Existing migrations on `usage_events`, `sessions`, `feature_rollups`, `session_*` — additions only.
- The Notion teamspace setup (already done).

---

## Task 1: Test runner setup

**Why first:** Every later task assumes `npm test` works. The codebase has no test framework today.

**Files:**
- Modify: `package.json`
- Modify: `tsconfig.json`
- Create: `tests/smoke.test.ts`

### Steps

- [ ] **Step 1: Add test script and types to package.json**

Edit `package.json`. Add to `"scripts"`:

```json
"test": "node --import tsx --test tests/**/*.test.ts",
"test:watch": "node --import tsx --test --watch tests/**/*.test.ts"
```

- [ ] **Step 2: Include tests/ in tsconfig**

Edit `tsconfig.json`. Confirm `include` covers `tests/**/*.ts`. If `include` doesn't exist, add:

```json
"include": ["src/**/*.ts", "config/**/*.ts", "tests/**/*.ts"]
```

If `rootDir` is set to `./src`, change it to `.` so the test files don't trip the rootDir check (this was already done earlier for `config/` per CLAUDE.md notes).

- [ ] **Step 3: Write a smoke test that proves the runner works**

Create `tests/smoke.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('test runner is wired', () => {
  assert.equal(1 + 1, 2);
});
```

- [ ] **Step 4: Run the test**

Run: `npm test`
Expected: green output, "1 tests passed".

- [ ] **Step 5: Commit**

```bash
git add package.json tsconfig.json tests/smoke.test.ts
git commit -m "test: add node:test runner via tsx loader"
```

---

## Task 2: Anomaly threshold config

**Files:**
- Create: `config/anomaly.ts`

### Steps

- [ ] **Step 1: Write the config file**

Create `config/anomaly.ts`:

```typescript
// Anomaly detection thresholds. Tunable without touching detection logic.
// Multipliers are ratios over the relevant baseline (trailing median / prior
// 7-day total). Floors are absolute USD; nothing under the floor is flagged
// no matter the multiplier, so $4 → $9 doesn't become an "anomaly".

export const ANOMALY = {
  spikeDay: {
    multiplier: 2.0,    // day total ≥ 2× trailing 7-day median
    floorUsd: 20,       // and ≥ $20 absolute
    windowDays: 7,      // size of the trailing median window
  },
  burningFeature: {
    multiplier: 1.5,    // 7-day total ≥ 1.5× prior 7-day total
    floorUsd: 50,
  },
  hotSession: {
    multiplier: 3.0,    // session ≥ 3× trailing 30-day median session cost
    floorUsd: 25,
    windowDays: 30,
  },
} as const;

export type AnomalyKind = 'spike_day' | 'burning_feature' | 'hot_session';

// Used for tie-breaking when multiple anomalies match a rollup row and we
// need to pick one reason string for Notion's `Anomaly reason` column.
export const ANOMALY_KIND_PRIORITY: Record<AnomalyKind, number> = {
  spike_day: 3,
  burning_feature: 2,
  hot_session: 1,
};
```

- [ ] **Step 2: Commit**

```bash
git add config/anomaly.ts
git commit -m "config: anomaly detection thresholds"
```

---

## Task 3: anomalies table schema

**Files:**
- Modify: `src/db/schema.ts`

### Steps

- [ ] **Step 1: Add anomalies CREATE TABLE to SCHEMA_STATEMENTS**

Edit `src/db/schema.ts`. Append to the `SCHEMA_STATEMENTS` array (before the closing `]`):

```typescript
  // Anomalies are derived from feature_rollups + usage_events at rollup time.
  // Recomputed from scratch each rollup run except for rows with a non-null
  // dismissed_at, which are preserved.
  `CREATE TABLE IF NOT EXISTS anomalies (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    kind            TEXT NOT NULL,
    date            TEXT NOT NULL,
    feature_key     TEXT,
    session_id      TEXT,
    amount          REAL NOT NULL,
    baseline        REAL NOT NULL,
    multiplier      REAL NOT NULL,
    reason          TEXT NOT NULL,
    dismissed_at    TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(kind, date, feature_key, session_id)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_anomalies_date ON anomalies (date)`,
  `CREATE INDEX IF NOT EXISTS idx_anomalies_active ON anomalies (dismissed_at)`,
```

The `UNIQUE(kind, date, feature_key, session_id)` lets recompute use `INSERT … ON CONFLICT DO UPDATE` while preserving `dismissed_at` and `id`.

- [ ] **Step 2: Manually verify migration runs**

Run: `npm run tokentrail -- ingest`  (or any command that calls `getDb()`)
Expected: no error. Then verify table exists:

```bash
sqlite3 data/tracker.db ".schema anomalies"
```
Expected: prints the CREATE TABLE statement.

- [ ] **Step 3: Commit**

```bash
git add src/db/schema.ts
git commit -m "db: anomalies table for derived flags"
```

---

## Task 4: Anomaly compute service (TDD)

**Files:**
- Create: `src/services/anomalies.ts`
- Create: `tests/anomalies.test.ts`

### Steps

- [ ] **Step 1: Write failing tests for the three anomaly kinds**

Create `tests/anomalies.test.ts`:

```typescript
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { detectAnomalies, type AnomalyInput } from '../src/services/anomalies.js';

describe('spike_day', () => {
  test('flags day ≥ 2× trailing 7-day median when ≥ $20', () => {
    const dailyTotals = [
      { date: '2026-06-01', total: 30 },
      { date: '2026-06-02', total: 30 },
      { date: '2026-06-03', total: 30 },
      { date: '2026-06-04', total: 30 },
      { date: '2026-06-05', total: 30 },
      { date: '2026-06-06', total: 30 },
      { date: '2026-06-07', total: 30 },
      { date: '2026-06-08', total: 100 },  // 100 / 30 = 3.33× → flag
    ];
    const out = detectAnomalies({ dailyTotals, featureWeekly: [], sessions: [], labeledWorkUnitBranches: new Set() } satisfies AnomalyInput);
    const spike = out.find((a) => a.kind === 'spike_day' && a.date === '2026-06-08');
    assert.ok(spike, 'expected spike_day on 2026-06-08');
    assert.equal(spike!.amount, 100);
    assert.equal(spike!.baseline, 30);
    assert.ok(spike!.multiplier >= 3.3 && spike!.multiplier <= 3.4);
  });

  test('does not flag when below $20 floor', () => {
    const dailyTotals = [
      { date: '2026-06-01', total: 5 },
      { date: '2026-06-02', total: 5 },
      { date: '2026-06-03', total: 5 },
      { date: '2026-06-04', total: 5 },
      { date: '2026-06-05', total: 5 },
      { date: '2026-06-06', total: 5 },
      { date: '2026-06-07', total: 5 },
      { date: '2026-06-08', total: 19 },  // 19 < $20 floor
    ];
    const out = detectAnomalies({ dailyTotals, featureWeekly: [], sessions: [], labeledWorkUnitBranches: new Set() } satisfies AnomalyInput);
    assert.equal(out.filter((a) => a.kind === 'spike_day').length, 0);
  });

  test('does not flag when multiplier below 2×', () => {
    const dailyTotals = [
      { date: '2026-06-01', total: 30 },
      { date: '2026-06-02', total: 30 },
      { date: '2026-06-03', total: 30 },
      { date: '2026-06-04', total: 30 },
      { date: '2026-06-05', total: 30 },
      { date: '2026-06-06', total: 30 },
      { date: '2026-06-07', total: 30 },
      { date: '2026-06-08', total: 50 },  // 50 / 30 = 1.67× → no
    ];
    const out = detectAnomalies({ dailyTotals, featureWeekly: [], sessions: [], labeledWorkUnitBranches: new Set() } satisfies AnomalyInput);
    assert.equal(out.filter((a) => a.kind === 'spike_day').length, 0);
  });
});

describe('burning_feature', () => {
  test('flags feature whose this-week ≥ 1.5× prior-week and ≥ $50', () => {
    const featureWeekly = [
      { featureKey: 'rag', priorWeek: 100, thisWeek: 200 },  // 2× and ≥ $50 → flag
    ];
    const out = detectAnomalies({ dailyTotals: [], featureWeekly, sessions: [], labeledWorkUnitBranches: new Set() } satisfies AnomalyInput);
    const burn = out.find((a) => a.kind === 'burning_feature' && a.feature_key === 'rag');
    assert.ok(burn);
    assert.equal(burn!.amount, 200);
    assert.equal(burn!.baseline, 100);
  });

  test('does not flag when below $50 floor', () => {
    const featureWeekly = [
      { featureKey: 'tiny', priorWeek: 5, thisWeek: 40 },  // ratio fine, floor not met
    ];
    const out = detectAnomalies({ dailyTotals: [], featureWeekly, sessions: [], labeledWorkUnitBranches: new Set() } satisfies AnomalyInput);
    assert.equal(out.filter((a) => a.kind === 'burning_feature').length, 0);
  });

  test('handles prior-week of zero without dividing by zero', () => {
    const featureWeekly = [
      { featureKey: 'new', priorWeek: 0, thisWeek: 100 },  // new feature
    ];
    const out = detectAnomalies({ dailyTotals: [], featureWeekly, sessions: [], labeledWorkUnitBranches: new Set() } satisfies AnomalyInput);
    const burn = out.find((a) => a.kind === 'burning_feature' && a.feature_key === 'new');
    assert.ok(burn, 'new feature with zero prior week should flag');
    assert.equal(burn!.baseline, 0);
    assert.equal(burn!.multiplier, Number.POSITIVE_INFINITY);
  });
});

describe('hot_session', () => {
  const baseSessions = Array.from({ length: 30 }, (_, i) => ({
    sessionId: `s${i}`,
    date: '2026-06-08',
    cost: 5,
    branch: null as string | null,
    hasOverride: false,
  }));

  test('flags session ≥ $25 and ≥ 3× 30-day median', () => {
    const sessions = [
      ...baseSessions,
      { sessionId: 'hot', date: '2026-06-08', cost: 50, branch: null, hasOverride: false },
    ];
    const out = detectAnomalies({ dailyTotals: [], featureWeekly: [], sessions, labeledWorkUnitBranches: new Set() } satisfies AnomalyInput);
    const hot = out.find((a) => a.kind === 'hot_session' && a.session_id === 'hot');
    assert.ok(hot);
  });

  test('suppresses when session has feature_override', () => {
    const sessions = [
      ...baseSessions,
      { sessionId: 'hot', date: '2026-06-08', cost: 50, branch: null, hasOverride: true },
    ];
    const out = detectAnomalies({ dailyTotals: [], featureWeekly: [], sessions, labeledWorkUnitBranches: new Set() } satisfies AnomalyInput);
    assert.equal(out.filter((a) => a.kind === 'hot_session').length, 0);
  });

  test('suppresses when session branch matches a labeled work unit', () => {
    const sessions = [
      ...baseSessions,
      { sessionId: 'hot', date: '2026-06-08', cost: 50, branch: 'feat/rag', hasOverride: false },
    ];
    const out = detectAnomalies({
      dailyTotals: [],
      featureWeekly: [],
      sessions,
      labeledWorkUnitBranches: new Set(['feat/rag']),
    } satisfies AnomalyInput);
    assert.equal(out.filter((a) => a.kind === 'hot_session').length, 0);
  });

  test('does not flag when below $25 floor', () => {
    const sessions = [
      ...baseSessions,
      { sessionId: 'modest', date: '2026-06-08', cost: 20, branch: null, hasOverride: false },
    ];
    const out = detectAnomalies({ dailyTotals: [], featureWeekly: [], sessions, labeledWorkUnitBranches: new Set() } satisfies AnomalyInput);
    assert.equal(out.filter((a) => a.kind === 'hot_session').length, 0);
  });
});

describe('reason text format', () => {
  test('spike_day reason mentions amount and multiplier', () => {
    const dailyTotals = [
      ...Array.from({ length: 7 }, (_, i) => ({ date: `2026-06-0${i + 1}`, total: 30 })),
      { date: '2026-06-08', total: 100 },
    ];
    const out = detectAnomalies({ dailyTotals, featureWeekly: [], sessions: [], labeledWorkUnitBranches: new Set() } satisfies AnomalyInput);
    const reason = out.find((a) => a.kind === 'spike_day')!.reason;
    assert.match(reason, /\$100/);
    assert.match(reason, /3\.3×/);
  });
});
```

- [ ] **Step 2: Run tests, verify they fail with import error**

Run: `npm test -- --test-name-pattern='spike_day'`
Expected: FAIL with "Cannot find module '../src/services/anomalies.js'".

- [ ] **Step 3: Implement detectAnomalies**

Create `src/services/anomalies.ts`:

```typescript
import { ANOMALY, ANOMALY_KIND_PRIORITY, type AnomalyKind } from '../../config/anomaly.js';

export type DailyTotal = { date: string; total: number };
export type FeatureWeekly = { featureKey: string; priorWeek: number; thisWeek: number };
export type SessionRow = {
  sessionId: string;
  date: string;
  cost: number;
  branch: string | null;
  hasOverride: boolean;
};

export type AnomalyInput = {
  dailyTotals: DailyTotal[];           // chronological, one row per date
  featureWeekly: FeatureWeekly[];      // one row per active feature
  sessions: SessionRow[];              // 30-day window
  labeledWorkUnitBranches: Set<string>;
};

export type DetectedAnomaly = {
  kind: AnomalyKind;
  date: string;
  feature_key: string | null;
  session_id: string | null;
  amount: number;
  baseline: number;
  multiplier: number;
  reason: string;
};

export function detectAnomalies(input: AnomalyInput): DetectedAnomaly[] {
  const out: DetectedAnomaly[] = [];
  out.push(...detectSpikeDays(input.dailyTotals));
  out.push(...detectBurningFeatures(input.featureWeekly));
  out.push(...detectHotSessions(input.sessions, input.labeledWorkUnitBranches));
  return out;
}

function detectSpikeDays(daily: DailyTotal[]): DetectedAnomaly[] {
  const { multiplier: minMult, floorUsd, windowDays } = ANOMALY.spikeDay;
  const sorted = [...daily].sort((a, b) => a.date.localeCompare(b.date));
  const out: DetectedAnomaly[] = [];
  for (let i = windowDays; i < sorted.length; i++) {
    const day = sorted[i];
    if (day.total < floorUsd) continue;
    const window = sorted.slice(i - windowDays, i).map((d) => d.total);
    const baseline = median(window);
    if (baseline <= 0) continue;
    const mult = day.total / baseline;
    if (mult < minMult) continue;
    out.push({
      kind: 'spike_day',
      date: day.date,
      feature_key: null,
      session_id: null,
      amount: day.total,
      baseline,
      multiplier: mult,
      reason: `$${Math.round(day.total)} — ${mult.toFixed(1)}× the prior week's typical day.`,
    });
  }
  return out;
}

function detectBurningFeatures(rows: FeatureWeekly[]): DetectedAnomaly[] {
  const { multiplier: minMult, floorUsd } = ANOMALY.burningFeature;
  const out: DetectedAnomaly[] = [];
  for (const r of rows) {
    if (r.thisWeek < floorUsd) continue;
    const mult = r.priorWeek === 0 ? Number.POSITIVE_INFINITY : r.thisWeek / r.priorWeek;
    if (mult < minMult) continue;
    out.push({
      kind: 'burning_feature',
      date: isoTodayUtc(),
      feature_key: r.featureKey,
      session_id: null,
      amount: r.thisWeek,
      baseline: r.priorWeek,
      multiplier: mult,
      reason: r.priorWeek === 0
        ? `${r.featureKey} — $${Math.round(r.thisWeek)} this week (new this period).`
        : `${r.featureKey} — $${Math.round(r.thisWeek)} this week, up from $${Math.round(r.priorWeek)}.`,
    });
  }
  return out;
}

function detectHotSessions(
  sessions: SessionRow[],
  labeledBranches: Set<string>
): DetectedAnomaly[] {
  const { multiplier: minMult, floorUsd } = ANOMALY.hotSession;
  const costs = sessions.map((s) => s.cost).filter((c) => c > 0);
  const baseline = median(costs);
  if (baseline <= 0) return [];
  const out: DetectedAnomaly[] = [];
  for (const s of sessions) {
    if (s.cost < floorUsd) continue;
    const mult = s.cost / baseline;
    if (mult < minMult) continue;
    // Suppression: skip if user has explicitly labeled this work.
    if (s.hasOverride) continue;
    if (s.branch && labeledBranches.has(s.branch)) continue;
    const idShort = s.sessionId.slice(0, 8);
    out.push({
      kind: 'hot_session',
      date: s.date,
      feature_key: null,
      session_id: s.sessionId,
      amount: s.cost,
      baseline,
      multiplier: mult,
      reason: `\`${idShort}…\` · $${Math.round(s.cost)} in one session.`,
    });
  }
  return out;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function isoTodayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

// Tie-breaker used by Notion sync to pick a single reason per rollup row.
export function chooseTopAnomaly(
  candidates: DetectedAnomaly[]
): DetectedAnomaly | null {
  if (candidates.length === 0) return null;
  return [...candidates].sort((a, b) => {
    if (b.multiplier !== a.multiplier) return b.multiplier - a.multiplier;
    return ANOMALY_KIND_PRIORITY[b.kind] - ANOMALY_KIND_PRIORITY[a.kind];
  })[0];
}
```

- [ ] **Step 4: Run tests, verify all pass**

Run: `npm test`
Expected: all anomaly tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/services/anomalies.ts tests/anomalies.test.ts
git commit -m "anomalies: pure detection logic + unit tests"
```

---

## Task 5: Wire anomaly compute into rollup

**Files:**
- Create: `src/services/anomalies-db.ts`
- Modify: `src/commands/rollup.ts`

### Steps

- [ ] **Step 1: Create the DB integration layer**

Create `src/services/anomalies-db.ts`:

```typescript
import type DatabaseType from 'better-sqlite3';
import { detectAnomalies, type AnomalyInput } from './anomalies.js';

// Pull the inputs detectAnomalies needs from feature_rollups + sessions, run
// detection, and upsert into the anomalies table. Active rows (dismissed_at
// IS NULL) for the same UNIQUE key get overwritten; dismissed rows are left
// untouched.
export function computeAndPersistAnomalies(db: DatabaseType.Database): {
  active: number;
  preserved: number;
} {
  const input = buildAnomalyInput(db);
  const detected = detectAnomalies(input);

  // Wipe active rows; preserve dismissed ones (which keep their id).
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM anomalies WHERE dismissed_at IS NULL`).run();
    const upsert = db.prepare(`
      INSERT INTO anomalies (kind, date, feature_key, session_id, amount, baseline, multiplier, reason)
      VALUES (@kind, @date, @feature_key, @session_id, @amount, @baseline, @multiplier, @reason)
      ON CONFLICT(kind, date, feature_key, session_id) DO UPDATE SET
        amount     = excluded.amount,
        baseline   = excluded.baseline,
        multiplier = excluded.multiplier,
        reason     = excluded.reason
      WHERE anomalies.dismissed_at IS NULL
    `);
    for (const a of detected) {
      upsert.run({
        kind: a.kind,
        date: a.date,
        feature_key: a.feature_key,
        session_id: a.session_id,
        amount: a.amount,
        baseline: a.baseline,
        multiplier: Number.isFinite(a.multiplier) ? a.multiplier : 9999,
        reason: a.reason,
      });
    }
  });
  tx();

  const active = (db.prepare(`SELECT COUNT(*) AS n FROM anomalies WHERE dismissed_at IS NULL`).get() as { n: number }).n;
  const preserved = (db.prepare(`SELECT COUNT(*) AS n FROM anomalies WHERE dismissed_at IS NOT NULL`).get() as { n: number }).n;
  return { active, preserved };
}

function buildAnomalyInput(db: DatabaseType.Database): AnomalyInput {
  // Daily totals: sum cost across all rollups per date.
  const dailyTotals = db
    .prepare(`SELECT date, SUM(total_cost_usd) AS total FROM feature_rollups GROUP BY date ORDER BY date`)
    .all() as Array<{ date: string; total: number }>;

  // Per-feature weekly: this-week (last 7 days) vs prior-week (8-14 days ago).
  const featureWeekly = db
    .prepare(`
      WITH bounds AS (
        SELECT date('now', '-13 days') AS prior_start,
               date('now', '-7 days')  AS prior_end,
               date('now', '-6 days')  AS this_start,
               date('now')             AS this_end
      )
      SELECT
        feature_key                                                                  AS featureKey,
        COALESCE(SUM(CASE WHEN date >= (SELECT prior_start FROM bounds) AND date <  (SELECT this_start FROM bounds) THEN total_cost_usd ELSE 0 END), 0) AS priorWeek,
        COALESCE(SUM(CASE WHEN date >= (SELECT this_start  FROM bounds) AND date <= (SELECT this_end   FROM bounds) THEN total_cost_usd ELSE 0 END), 0) AS thisWeek
      FROM feature_rollups
      GROUP BY feature_key
      HAVING thisWeek > 0 OR priorWeek > 0
    `)
    .all() as Array<{ featureKey: string; priorWeek: number; thisWeek: number }>;

  // Sessions: trailing 30 days, with cost + branch + override flag.
  const sessions = db
    .prepare(`
      SELECT
        s.session_id                                AS sessionId,
        date(s.first_seen_at)                       AS date,
        COALESCE(SUM(e.estimated_cost_usd), 0)      AS cost,
        e.branch                                    AS branch,
        CASE WHEN s.feature_override IS NOT NULL THEN 1 ELSE 0 END AS hasOverride
      FROM sessions s
      LEFT JOIN usage_events e ON e.session_id = s.session_id
      WHERE date(s.first_seen_at) >= date('now', '-30 days')
      GROUP BY s.session_id
    `)
    .all() as Array<{
      sessionId: string;
      date: string;
      cost: number;
      branch: string | null;
      hasOverride: 0 | 1;
    }>;

  // Labeled work-unit branches: any work_unit that came from a manual label
  // (i.e. feature_key matches a sessions.feature_override).
  const labeledRows = db
    .prepare(`
      SELECT DISTINCT branch
      FROM work_units
      WHERE feature_key IN (SELECT DISTINCT feature_override FROM sessions WHERE feature_override IS NOT NULL)
        AND branch IS NOT NULL
    `)
    .all() as Array<{ branch: string }>;
  const labeledWorkUnitBranches = new Set(labeledRows.map((r) => r.branch));

  return {
    dailyTotals,
    featureWeekly,
    sessions: sessions.map((s) => ({
      sessionId: s.sessionId,
      date: s.date,
      cost: s.cost,
      branch: s.branch,
      hasOverride: s.hasOverride === 1,
    })),
    labeledWorkUnitBranches,
  };
}
```

- [ ] **Step 2: Call it from rollup**

Edit `src/commands/rollup.ts`. Add import at the top:

```typescript
import { computeAndPersistAnomalies } from '../services/anomalies-db.js';
```

After the existing verification `console.log` near the end (the one that says `Rollup written: …`), add:

```typescript
  const anomalyResult = computeAndPersistAnomalies(db);
  console.log(
    `Anomalies: ${anomalyResult.active} active` +
      (anomalyResult.preserved > 0 ? `, ${anomalyResult.preserved} dismissed preserved` : '') +
      '.'
  );
```

- [ ] **Step 3: Manually verify**

Run: `npm run tokentrail -- rollup`
Expected: existing rollup output, then a new line like `Anomalies: 4 active.`

Run: `sqlite3 data/tracker.db "SELECT kind, date, feature_key, session_id, ROUND(amount,2), ROUND(multiplier,2), reason FROM anomalies WHERE dismissed_at IS NULL LIMIT 20"`
Expected: a handful of rows across all three kinds with sensible reasons.

- [ ] **Step 4: Re-run rollup, verify it's idempotent**

Run: `npm run tokentrail -- rollup` twice in a row.
Expected: second run shows the same `Anomalies: N active` count; no row count growth.

- [ ] **Step 5: Commit**

```bash
git add src/services/anomalies-db.ts src/commands/rollup.ts
git commit -m "rollup: compute and persist anomalies at end of run"
```

---

## Task 6: `tokentrail anomaly dismiss` CLI command

**Files:**
- Create: `src/commands/anomaly.ts`
- Modify: `src/index.ts`

### Steps

- [ ] **Step 1: Implement the dismiss command**

Create `src/commands/anomaly.ts`:

```typescript
import { getDb } from '../db/db.js';

export function dismissAnomaly(id: number): void {
  const db = getDb();
  const result = db
    .prepare(`UPDATE anomalies SET dismissed_at = datetime('now') WHERE id = ? AND dismissed_at IS NULL`)
    .run(id);
  if (result.changes === 0) {
    console.error(`No active anomaly with id ${id}.`);
    process.exitCode = 1;
    return;
  }
  console.log(`Dismissed anomaly ${id}.`);
}

export function listAnomalies(): void {
  const db = getDb();
  const rows = db
    .prepare(`
      SELECT id, kind, date, feature_key, session_id, amount, multiplier, reason
      FROM anomalies
      WHERE dismissed_at IS NULL
      ORDER BY date DESC, multiplier DESC
    `)
    .all() as Array<{
      id: number;
      kind: string;
      date: string;
      feature_key: string | null;
      session_id: string | null;
      amount: number;
      multiplier: number;
      reason: string;
    }>;
  if (rows.length === 0) {
    console.log('No active anomalies.');
    return;
  }
  for (const r of rows) {
    console.log(`#${r.id}  [${r.kind}]  ${r.date}  ${r.reason}`);
  }
}
```

- [ ] **Step 2: Register the command**

Edit `src/index.ts`. After the existing `enrich` command block, add:

```typescript
program
  .command('anomaly')
  .description('List or dismiss anomalies.')
  .argument('[action]', '"list" (default) or "dismiss".')
  .argument('[id]', 'Anomaly id when dismissing.')
  .action(async (action: string | undefined, id: string | undefined) => {
    const { dismissAnomaly, listAnomalies } = await import('./commands/anomaly.js');
    if (!action || action === 'list') {
      listAnomalies();
      return;
    }
    if (action === 'dismiss') {
      if (!id) {
        console.error('Usage: tokentrail anomaly dismiss <id>');
        process.exitCode = 1;
        return;
      }
      dismissAnomaly(Number.parseInt(id, 10));
      return;
    }
    console.error(`Unknown anomaly action: ${action}`);
    process.exitCode = 1;
  });
```

- [ ] **Step 3: Manually verify**

Run: `npm run tokentrail -- anomaly`
Expected: list of active anomalies, one per line.

Run: `npm run tokentrail -- anomaly dismiss <some id from above>`
Expected: `Dismissed anomaly N.`

Run: `npm run tokentrail -- anomaly list`
Expected: the dismissed id is no longer in the output.

Run: `npm run tokentrail -- rollup`
Expected: trailing line shows `… , 1 dismissed preserved.`

- [ ] **Step 4: Commit**

```bash
git add src/commands/anomaly.ts src/index.ts
git commit -m "anomaly: list and dismiss CLI"
```

---

## Task 7: Add Fastify dependency

**Files:**
- Modify: `package.json`

### Steps

- [ ] **Step 1: Install fastify and `open`**

Run: `npm install fastify@^4 open@^10`
Expected: deps added; lockfile updated.

- [ ] **Step 2: Verify import works**

Run a one-off:

```bash
npx tsx -e "import('fastify').then((m) => console.log(typeof m.default))"
```

Expected: `function`.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "deps: fastify + open for the dashboard"
```

---

## Task 8: Design tokens module

**Files:**
- Create: `src/dashboard/tokens.ts`

### Steps

- [ ] **Step 1: Write the tokens module**

Create `src/dashboard/tokens.ts`:

```typescript
// Single source of truth for the cartographer theme. Imported by both
// the CSS generator and any rendering code that needs an inline color.

export const TOKENS = {
  color: {
    parchmentTop:    '#f8f3e7',
    parchmentBottom: '#f0e5d0',
    ink:             '#3d2f1f',
    inkMuted:        '#6b563d',
    inkSubtle:       '#8b6f47',
    rule:            '#8b6f47',
    accentGreen:     '#5d7a3e',
    accentBar:       '#8b6f47',
    cardBg:          'rgba(255,255,255,0.5)',
    cardBorder:      '#c9b48d',
  },
  font: {
    serif:  'Georgia, "Times New Roman", serif',
    sans:   '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
    mono:   'ui-monospace, "SF Mono", Menlo, monospace',
  },
  size: {
    hero:   '32px',
    h1:     '24px',
    h2:     '18px',
    body:   '14px',
    small:  '11px',
    label:  '10px',
  },
  space: {
    s: '8px',
    m: '16px',
    l: '24px',
    xl: '32px',
  },
} as const;

// Emits the tokens as :root custom properties. Called from the CSS endpoint.
export function tokensCss(): string {
  return `:root {
  --color-parchment-top: ${TOKENS.color.parchmentTop};
  --color-parchment-bottom: ${TOKENS.color.parchmentBottom};
  --color-ink: ${TOKENS.color.ink};
  --color-ink-muted: ${TOKENS.color.inkMuted};
  --color-ink-subtle: ${TOKENS.color.inkSubtle};
  --color-rule: ${TOKENS.color.rule};
  --color-accent-green: ${TOKENS.color.accentGreen};
  --color-accent-bar: ${TOKENS.color.accentBar};
  --color-card-bg: ${TOKENS.color.cardBg};
  --color-card-border: ${TOKENS.color.cardBorder};
  --font-serif: ${TOKENS.font.serif};
  --font-sans: ${TOKENS.font.sans};
  --font-mono: ${TOKENS.font.mono};
  --size-hero: ${TOKENS.size.hero};
  --size-h1: ${TOKENS.size.h1};
  --size-h2: ${TOKENS.size.h2};
  --size-body: ${TOKENS.size.body};
  --size-small: ${TOKENS.size.small};
  --size-label: ${TOKENS.size.label};
  --space-s: ${TOKENS.space.s};
  --space-m: ${TOKENS.space.m};
  --space-l: ${TOKENS.space.l};
  --space-xl: ${TOKENS.space.xl};
}`;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/dashboard/tokens.ts
git commit -m "dashboard: design tokens module"
```

---

## Task 9: HTML shell

**Files:**
- Create: `src/dashboard/render/shell.ts`

### Steps

- [ ] **Step 1: Write the shell**

Create `src/dashboard/render/shell.ts`:

```typescript
export type ShellOptions = {
  title: string;
  activeTab?: 'overview' | 'feature' | 'worth-a-look';
  days: number;          // current time-window selection
  showBack?: boolean;
};

export function renderShell(opts: ShellOptions, body: string): string {
  const dayOptions = [7, 30, 90, 365];
  const range = dayOptions
    .map((d) => `<option value="${d}"${d === opts.days ? ' selected' : ''}>${d === 365 ? 'all' : `${d}d`}</option>`)
    .join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(opts.title)}</title>
<link rel="stylesheet" href="/static/uPlot.min.css">
<link rel="stylesheet" href="/static/dashboard.css">
</head>
<body>
<header class="header">
  <div class="header-left">
    ${opts.showBack ? '<a class="back" href="/">← Trail</a>' : ''}
    <span class="brand">Tokentrail</span>
    <span class="brand-tag">· the trail so far</span>
  </div>
  <div class="header-right">
    <form method="get" class="range-form">
      <label class="label" for="days">Window</label>
      <select id="days" name="days" onchange="this.form.submit()">${range}</select>
    </form>
  </div>
</header>
<main>${body}</main>
<script src="/static/uPlot.iife.min.js"></script>
<script src="/static/dashboard.js"></script>
</body>
</html>`;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
```

- [ ] **Step 2: Commit**

```bash
git add src/dashboard/render/shell.ts
git commit -m "dashboard: HTML shell template"
```

---

## Task 10: Overview data layer (TDD)

**Files:**
- Create: `src/dashboard/data/overview.ts`
- Create: `tests/dashboard-data.test.ts`

### Steps

- [ ] **Step 1: Write failing tests for the data shaping**

Create `tests/dashboard-data.test.ts`:

```typescript
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type DatabaseType from 'better-sqlite3';
import { SCHEMA_STATEMENTS } from '../src/db/schema.js';
import { buildOverview } from '../src/dashboard/data/overview.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof DatabaseType;

function makeDb(): DatabaseType.Database {
  const db = new Database(':memory:');
  for (const stmt of SCHEMA_STATEMENTS) db.exec(stmt);
  return db;
}

describe('buildOverview', () => {
  test('returns zeroed view-model when DB is empty', () => {
    const db = makeDb();
    const vm = buildOverview(db, { days: 30 });
    assert.equal(vm.totalUsd, 0);
    assert.equal(vm.topFeatures.length, 0);
    assert.equal(vm.dailySeries.length, 0);
    assert.equal(vm.recentCommits.length, 0);
    assert.equal(vm.anomalies.length, 0);
  });

  test('computes total + delta vs prior period of same length', () => {
    const db = makeDb();
    // 4 days inside window @ $10 each = $40; 4 days outside (15-18 days ago) @ $5 = $20.
    seedRollups(db, [
      { date: daysAgo(1), cost: 10 },
      { date: daysAgo(2), cost: 10 },
      { date: daysAgo(3), cost: 10 },
      { date: daysAgo(4), cost: 10 },
      { date: daysAgo(16), cost: 5 },
      { date: daysAgo(17), cost: 5 },
      { date: daysAgo(18), cost: 5 },
      { date: daysAgo(19), cost: 5 },
    ]);
    const vm = buildOverview(db, { days: 14 });
    assert.equal(vm.totalUsd, 40);
    assert.equal(vm.priorUsd, 20);
    assert.equal(vm.deltaPct, 100);
  });

  test('groups top features by total cost descending', () => {
    const db = makeDb();
    seedRollups(db, [
      { date: daysAgo(1), cost: 50, feature_key: 'rag', feature_name: 'Local RAG' },
      { date: daysAgo(2), cost: 80, feature_key: 'archi', feature_name: 'Archi homepage' },
      { date: daysAgo(3), cost: 10, feature_key: 'rag', feature_name: 'Local RAG' },
    ]);
    const vm = buildOverview(db, { days: 30 });
    assert.equal(vm.topFeatures[0].featureKey, 'archi');
    assert.equal(vm.topFeatures[0].totalUsd, 80);
    assert.equal(vm.topFeatures[1].featureKey, 'rag');
    assert.equal(vm.topFeatures[1].totalUsd, 60);
  });

  test('dailySeries returns one entry per day in window, zero-filled', () => {
    const db = makeDb();
    seedRollups(db, [
      { date: daysAgo(1), cost: 10 },
      { date: daysAgo(3), cost: 20 },
    ]);
    const vm = buildOverview(db, { days: 7 });
    assert.equal(vm.dailySeries.length, 7);
    const totals = vm.dailySeries.map((d) => d.total);
    assert.ok(totals.includes(10));
    assert.ok(totals.includes(20));
    assert.equal(totals.filter((t) => t === 0).length, 5);
  });
});

function daysAgo(n: number): string {
  // Note: this helper uses 'now' so tests have a fixed reference, computed
  // via SQLite, NOT JS Date. Tests use SQLite's date() too via seedRollups
  // so both sides agree.
  return `__${n}__`;  // placeholder; resolved in seedRollups via date('now','-N days')
}

function seedRollups(
  db: DatabaseType.Database,
  rows: Array<{ date: string; cost: number; feature_key?: string; feature_name?: string }>
): void {
  const insert = db.prepare(`
    INSERT INTO feature_rollups (id, date, feature_key, feature_name, total_cost_usd, sessions_count)
    VALUES (@id, date('now', @offset), @key, @name, @cost, 1)
  `);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const offsetMatch = /^__(\d+)__$/.exec(r.date);
    const offset = offsetMatch ? `-${offsetMatch[1]} days` : '+0 days';
    insert.run({
      id: `t-${i}`,
      offset,
      key: r.feature_key ?? `feat-${i}`,
      name: r.feature_name ?? `Feature ${i}`,
      cost: r.cost,
    });
  }
}
```

- [ ] **Step 2: Run tests, verify they fail with module-not-found**

Run: `npm test`
Expected: FAIL on `buildOverview` import.

- [ ] **Step 3: Implement `buildOverview`**

Create `src/dashboard/data/overview.ts`:

```typescript
import type DatabaseType from 'better-sqlite3';

export type OverviewVM = {
  windowDays: number;
  totalUsd: number;
  priorUsd: number;
  deltaPct: number;
  weekUsd: number;
  weekSessions: number;
  topFeatures: Array<{ featureKey: string; featureName: string; totalUsd: number }>;
  dailySeries: Array<{ date: string; total: number }>;
  anomalies: Array<{
    id: number;
    kind: string;
    date: string;
    featureKey: string | null;
    sessionId: string | null;
    amount: number;
    reason: string;
  }>;
  recentCommits: Array<{ sha: string; subject: string; repo: string | null; authoredAt: string | null }>;
};

export function buildOverview(
  db: DatabaseType.Database,
  opts: { days: number }
): OverviewVM {
  const days = Math.max(1, opts.days);
  const startExpr = `date('now', '-${days - 1} days')`;
  const priorStartExpr = `date('now', '-${days * 2 - 1} days')`;
  const priorEndExpr = `date('now', '-${days} days')`;

  const totalRow = db
    .prepare(`SELECT COALESCE(SUM(total_cost_usd), 0) AS total FROM feature_rollups WHERE date >= ${startExpr}`)
    .get() as { total: number };
  const priorRow = db
    .prepare(`SELECT COALESCE(SUM(total_cost_usd), 0) AS total FROM feature_rollups WHERE date >= ${priorStartExpr} AND date <= ${priorEndExpr}`)
    .get() as { total: number };
  const weekRow = db
    .prepare(`SELECT COALESCE(SUM(total_cost_usd), 0) AS total, COALESCE(SUM(sessions_count), 0) AS sessions FROM feature_rollups WHERE date >= date('now', '-6 days')`)
    .get() as { total: number; sessions: number };

  const topFeatures = db
    .prepare(`
      SELECT feature_key AS featureKey,
             MAX(feature_name) AS featureName,
             ROUND(SUM(total_cost_usd), 2) AS totalUsd
      FROM feature_rollups
      WHERE date >= ${startExpr}
      GROUP BY feature_key
      ORDER BY totalUsd DESC
      LIMIT 10
    `)
    .all() as OverviewVM['topFeatures'];

  // Daily series — one row per day in window, zero-filled.
  const observed = db
    .prepare(`SELECT date, SUM(total_cost_usd) AS total FROM feature_rollups WHERE date >= ${startExpr} GROUP BY date`)
    .all() as Array<{ date: string; total: number }>;
  const observedMap = new Map(observed.map((r) => [r.date, r.total]));
  const dailySeries: OverviewVM['dailySeries'] = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = db.prepare(`SELECT date('now', '-${i} days') AS d`).get() as { d: string };
    dailySeries.push({ date: date.d, total: observedMap.get(date.d) ?? 0 });
  }

  const anomalies = db
    .prepare(`
      SELECT id, kind, date, feature_key AS featureKey, session_id AS sessionId,
             ROUND(amount, 2) AS amount, reason
      FROM anomalies
      WHERE dismissed_at IS NULL AND date >= ${startExpr}
      ORDER BY multiplier DESC, date DESC
      LIMIT 5
    `)
    .all() as OverviewVM['anomalies'];

  const recentCommits = db
    .prepare(`
      SELECT commit_sha AS sha, subject, repo, authored_at AS authoredAt
      FROM session_commits
      WHERE authored_at IS NOT NULL
      ORDER BY authored_at DESC
      LIMIT 10
    `)
    .all() as OverviewVM['recentCommits'];

  const total = round2(totalRow.total);
  const prior = round2(priorRow.total);
  const deltaPct = prior > 0 ? Math.round(((total - prior) / prior) * 100) : (total > 0 ? 100 : 0);

  return {
    windowDays: days,
    totalUsd: total,
    priorUsd: prior,
    deltaPct,
    weekUsd: round2(weekRow.total),
    weekSessions: weekRow.sessions,
    topFeatures,
    dailySeries,
    anomalies,
    recentCommits,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
```

- [ ] **Step 4: Run tests, verify all pass**

Run: `npm test`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/data/overview.ts tests/dashboard-data.test.ts
git commit -m "dashboard: overview view-model + tests"
```

---

## Task 11: Overview render

**Files:**
- Create: `src/dashboard/render/overview.ts`

### Steps

- [ ] **Step 1: Implement the renderer**

Create `src/dashboard/render/overview.ts`:

```typescript
import type { OverviewVM } from '../data/overview.js';
import { escapeHtml } from './shell.js';

export function renderOverview(vm: OverviewVM): string {
  return `
<div class="layout">
  <section class="main-col">
    <div class="card chart-card">
      <div class="label">Trend · last ${vm.windowDays} days</div>
      <div id="trend-chart" style="width:100%;height:280px"></div>
      <script type="application/json" id="trend-data">${escapeHtml(JSON.stringify(vm.dailySeries))}</script>
    </div>

    <div class="card">
      <div class="label">Top burn paths</div>
      ${renderTopFeatures(vm.topFeatures)}
    </div>
  </section>

  <aside class="side-col">
    <div class="card hero-card">
      <div class="label">Trail so far</div>
      <div class="hero">$${vm.totalUsd.toFixed(0)}</div>
      <div class="delta ${vm.deltaPct >= 0 ? 'up' : 'down'}">${vm.deltaPct >= 0 ? '▲' : '▼'} ${Math.abs(vm.deltaPct)}% vs prior</div>
    </div>

    <div class="card">
      <div class="label">This week</div>
      <div class="kicker">$${vm.weekUsd.toFixed(0)}</div>
      <div class="muted">${vm.weekSessions} sessions</div>
    </div>

    <div class="card">
      <div class="label">Worth a look</div>
      ${vm.anomalies.length === 0 ? '<div class="muted">No anomalies in window.</div>' : renderAnomalies(vm.anomalies)}
      ${vm.anomalies.length > 0 ? '<div class="footer-link"><a href="/worth-a-look">See all →</a></div>' : ''}
    </div>

    <div class="card">
      <div class="label">Recent commits</div>
      ${renderCommits(vm.recentCommits)}
    </div>
  </aside>
</div>
  `;
}

function renderTopFeatures(items: OverviewVM['topFeatures']): string {
  if (items.length === 0) return '<div class="muted">No feature activity yet.</div>';
  const max = items[0].totalUsd || 1;
  const roman = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
  return items
    .map((f, i) => {
      const pct = Math.round((f.totalUsd / max) * 100);
      const href = `/feature/${encodeURIComponent(f.featureKey)}`;
      return `
        <a class="feature-row" href="${href}">
          <span class="mile">${roman[i] ?? ''}</span>
          <span class="name">${escapeHtml(f.featureName || f.featureKey)}</span>
          <span class="amt">$${f.totalUsd.toFixed(0)}</span>
        </a>
        <div class="bar"><span style="width:${pct}%"></span></div>
      `;
    })
    .join('');
}

function renderAnomalies(items: OverviewVM['anomalies']): string {
  return items
    .slice(0, 5)
    .map((a) => `<div class="anomaly-row"><span class="anomaly-date">${escapeHtml(a.date)}</span><span class="anomaly-reason">${escapeHtml(a.reason)}</span></div>`)
    .join('');
}

function renderCommits(items: OverviewVM['recentCommits']): string {
  if (items.length === 0) return '<div class="muted">No commits captured yet.</div>';
  return items
    .map((c) => {
      const shaShort = c.sha.slice(0, 8);
      const url = c.repo ? `https://github.com/${c.repo}/commit/${c.sha}` : null;
      const sha = url
        ? `<a class="sha" href="${url}" target="_blank" rel="noopener">${shaShort}</a>`
        : `<span class="sha">${shaShort}</span>`;
      return `<div class="commit-row">${sha} <span class="subject">${escapeHtml(c.subject)}</span></div>`;
    })
    .join('');
}
```

- [ ] **Step 2: Commit**

```bash
git add src/dashboard/render/overview.ts
git commit -m "dashboard: overview renderer"
```

---

## Task 12: Static assets — CSS and JS

**Files:**
- Create: `src/dashboard/static/dashboard.css`
- Create: `src/dashboard/static/dashboard.js`

### Steps

- [ ] **Step 1: Write the CSS**

Create `src/dashboard/static/dashboard.css`:

```css
/* Cartographer theme — uses tokens injected via /static/tokens.css */
@import url('/static/tokens.css');

* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  font-family: var(--font-sans);
  font-size: var(--size-body);
  color: var(--color-ink);
  background: linear-gradient(135deg, var(--color-parchment-top) 0%, var(--color-parchment-bottom) 100%);
  min-height: 100vh;
}
body::before {
  content: "";
  position: fixed; inset: 0;
  background-image: radial-gradient(circle at 1px 1px, rgba(61,47,31,0.06) 1px, transparent 0);
  background-size: 12px 12px;
  pointer-events: none;
  z-index: -1;
}

.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: var(--space-m) var(--space-l);
  border-bottom: 1px dashed var(--color-rule);
  position: sticky; top: 0;
  background: linear-gradient(135deg, var(--color-parchment-top) 0%, var(--color-parchment-bottom) 100%);
  z-index: 10;
}
.brand { font-family: var(--font-serif); font-size: var(--size-h1); font-weight: 600; }
.brand-tag { color: var(--color-ink-muted); font-style: italic; margin-left: var(--space-s); }
.header-left { display: flex; align-items: baseline; gap: var(--space-s); }
.back { color: var(--color-ink-muted); text-decoration: none; margin-right: var(--space-m); }
.back:hover { color: var(--color-ink); }
.range-form { display: flex; gap: var(--space-s); align-items: center; }
.range-form select {
  font-family: var(--font-sans);
  background: var(--color-card-bg);
  border: 1px solid var(--color-card-border);
  padding: 4px 8px;
  border-radius: 4px;
}

main { max-width: 1280px; margin: 0 auto; padding: var(--space-l); }

.layout { display: grid; grid-template-columns: 2fr 1fr; gap: var(--space-l); }
.main-col, .side-col { display: flex; flex-direction: column; gap: var(--space-l); }
@media (max-width: 900px) { .layout { grid-template-columns: 1fr; } }

.card {
  background: var(--color-card-bg);
  border: 1px solid var(--color-card-border);
  border-radius: 8px;
  padding: var(--space-m);
}

.label {
  font-family: var(--font-serif);
  font-size: var(--size-label);
  text-transform: uppercase;
  letter-spacing: 2px;
  color: var(--color-ink-muted);
  margin-bottom: var(--space-s);
}
.hero { font-family: var(--font-serif); font-size: var(--size-hero); font-weight: 600; }
.kicker { font-family: var(--font-serif); font-size: var(--size-h1); font-weight: 600; }
.muted { color: var(--color-ink-muted); font-size: var(--size-small); }
.delta { font-size: var(--size-small); }
.delta.up { color: var(--color-accent-green); }
.delta.down { color: #a04030; }

.feature-row {
  display: grid;
  grid-template-columns: 24px 1fr auto;
  gap: var(--space-s);
  padding: 4px 0;
  text-decoration: none;
  color: var(--color-ink);
  font-family: var(--font-serif);
  font-weight: 500;
}
.feature-row:hover { background: rgba(255,255,255,0.4); }
.feature-row .mile {
  color: var(--color-ink-subtle);
  font-family: var(--font-serif);
  font-size: var(--size-small);
}
.feature-row .name { font-family: var(--font-serif); }
.feature-row .amt { font-variant-numeric: tabular-nums; font-weight: 600; color: var(--color-ink); }
.bar {
  height: 4px;
  background: rgba(139, 111, 71, 0.15);
  border-radius: 2px;
  margin-left: 24px;
  margin-bottom: 4px;
}
.bar span {
  display: block;
  height: 100%;
  background: var(--color-accent-bar);
  border-radius: 2px;
  opacity: 0.7;
}

.anomaly-row {
  display: flex;
  justify-content: space-between;
  gap: var(--space-s);
  font-size: var(--size-small);
  padding: 4px 0;
}
.anomaly-date { color: var(--color-ink-muted); font-variant-numeric: tabular-nums; }
.anomaly-reason { text-align: right; color: var(--color-ink); }

.commit-row { font-size: var(--size-small); padding: 3px 0; }
.commit-row .sha { font-family: var(--font-mono); color: var(--color-ink-subtle); margin-right: var(--space-s); }
.commit-row .sha:hover { color: var(--color-ink); }
.commit-row .subject { color: var(--color-ink); }

.footer-link { margin-top: var(--space-s); text-align: right; }
.footer-link a { color: var(--color-ink-muted); font-size: var(--size-small); text-decoration: none; }
.footer-link a:hover { color: var(--color-ink); }

/* uPlot color overrides */
.u-legend { font-family: var(--font-sans); font-size: var(--size-small); color: var(--color-ink-muted); }
```

- [ ] **Step 2: Write the client JS**

Create `src/dashboard/static/dashboard.js`:

```javascript
(function () {
  function renderTrend() {
    const node = document.getElementById('trend-chart');
    const dataNode = document.getElementById('trend-data');
    if (!node || !dataNode || typeof uPlot === 'undefined') return;
    let series;
    try { series = JSON.parse(dataNode.textContent || '[]'); } catch (e) { return; }
    if (!Array.isArray(series) || series.length === 0) {
      node.innerHTML = '<div class="muted" style="padding:24px;text-align:center">No data in window.</div>';
      return;
    }
    const xs = series.map((d) => new Date(d.date + 'T00:00:00').getTime() / 1000);
    const ys = series.map((d) => d.total);
    const opts = {
      width: node.clientWidth,
      height: 280,
      scales: { x: { time: true } },
      series: [
        {},
        {
          label: 'Daily $',
          stroke: '#8b6f47',
          fill: 'rgba(139,111,71,0.2)',
          width: 2,
        },
      ],
      axes: [
        { stroke: '#6b563d', grid: { stroke: 'rgba(139,111,71,0.15)' } },
        { stroke: '#6b563d', grid: { stroke: 'rgba(139,111,71,0.15)' }, values: (_self, ticks) => ticks.map((t) => '$' + Math.round(t)) },
      ],
    };
    // eslint-disable-next-line no-undef, no-new
    new uPlot(opts, [xs, ys], node);
  }

  function setupRowExpanders() {
    document.querySelectorAll('[data-expand-target]').forEach((row) => {
      row.addEventListener('click', (e) => {
        if ((e.target instanceof HTMLAnchorElement)) return;
        const targetId = row.getAttribute('data-expand-target');
        if (!targetId) return;
        const target = document.getElementById(targetId);
        if (target) target.classList.toggle('open');
      });
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    renderTrend();
    setupRowExpanders();
  });
})();
```

- [ ] **Step 3: Commit**

```bash
git add src/dashboard/static/dashboard.css src/dashboard/static/dashboard.js
git commit -m "dashboard: static CSS and client JS"
```

---

## Task 13: Vendor uPlot

**Files:**
- Create: `src/dashboard/static/uPlot.iife.min.js`
- Create: `src/dashboard/static/uPlot.min.css`

### Steps

- [ ] **Step 1: Add uPlot as a dev dep, copy the dist files**

Run:

```bash
npm install --save-dev uplot@^1.6
mkdir -p src/dashboard/static
cp node_modules/uplot/dist/uPlot.iife.min.js src/dashboard/static/uPlot.iife.min.js
cp node_modules/uplot/dist/uPlot.min.css src/dashboard/static/uPlot.min.css
```

- [ ] **Step 2: Verify files exist and are non-empty**

Run:

```bash
ls -la src/dashboard/static/uPlot.*
```

Expected: two files, each > 5KB.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json src/dashboard/static/uPlot.iife.min.js src/dashboard/static/uPlot.min.css
git commit -m "dashboard: vendor uPlot 1.6"
```

---

## Task 14: Fastify server + Overview route

**Files:**
- Create: `src/dashboard/server.ts`
- Create: `src/commands/dashboard.ts`
- Modify: `src/index.ts`

### Steps

- [ ] **Step 1: Implement the server**

Create `src/dashboard/server.ts`:

```typescript
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import { getDb } from '../db/db.js';
import { buildOverview } from './data/overview.js';
import { renderOverview } from './render/overview.js';
import { renderShell } from './render/shell.js';
import { tokensCss } from './tokens.js';

const STATIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'static');

export type ServerOptions = { defaultDays: number };

export function buildServer(opts: ServerOptions): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get('/', async (req, reply) => {
    const days = parseDays(req.query, opts.defaultDays);
    const vm = buildOverview(getDb(), { days });
    const body = renderOverview(vm);
    reply.type('text/html; charset=utf-8');
    return renderShell({ title: 'Tokentrail · Overview', activeTab: 'overview', days }, body);
  });

  // Static asset serving — small bespoke handler instead of @fastify/static
  // to keep dep count low. Only allows files whose basename matches a
  // whitelist (no path traversal).
  const STATIC_ALLOW = new Set([
    'dashboard.css',
    'dashboard.js',
    'uPlot.iife.min.js',
    'uPlot.min.css',
  ]);

  app.get('/static/tokens.css', async (_req, reply) => {
    reply.type('text/css; charset=utf-8');
    return tokensCss();
  });

  app.get('/static/:name', async (req, reply) => {
    const name = (req.params as { name: string }).name;
    if (!STATIC_ALLOW.has(name)) return reply.code(404).send('not found');
    const data = await readFile(join(STATIC_DIR, name));
    if (name.endsWith('.css')) reply.type('text/css; charset=utf-8');
    else if (name.endsWith('.js')) reply.type('application/javascript; charset=utf-8');
    return data;
  });

  return app;
}

function parseDays(query: unknown, fallback: number): number {
  if (typeof query !== 'object' || query === null) return fallback;
  const raw = (query as Record<string, unknown>).days;
  if (typeof raw !== 'string') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0 || n > 730) return fallback;
  return n;
}
```

- [ ] **Step 2: Implement the command**

Create `src/commands/dashboard.ts`:

```typescript
import open from 'open';
import { buildServer } from '../dashboard/server.js';

export type DashboardOptions = {
  port: number;
  open: boolean;
  days: number;
};

export async function runDashboard(opts: DashboardOptions): Promise<void> {
  const app = buildServer({ defaultDays: opts.days });
  await app.listen({ port: opts.port, host: '127.0.0.1' });
  const url = `http://127.0.0.1:${opts.port}`;
  console.log(`Tokentrail dashboard at ${url}  (Ctrl-C to stop)`);
  if (opts.open) {
    open(url).catch(() => { /* user can still copy URL */ });
  }
  // Keep the event loop alive on SIGINT
  process.on('SIGINT', () => {
    app.close().finally(() => process.exit(0));
  });
}
```

- [ ] **Step 3: Register the command**

Edit `src/index.ts`. After the `enrich` registration (or wherever consistent), add:

```typescript
program
  .command('dashboard')
  .description('Open the local Tokentrail dashboard in your browser.')
  .option('--port <n>', 'Port to bind (default 4920)', '4920')
  .option('--no-open', "Don't launch the browser automatically.")
  .option('--days <n>', 'Default time window in days (default 30)', '30')
  .action(async (opts: { port?: string; open?: boolean; days?: string }) => {
    const { runDashboard } = await import('./commands/dashboard.js');
    await runDashboard({
      port: Number.parseInt(opts.port ?? '4920', 10),
      open: opts.open !== false,
      days: Number.parseInt(opts.days ?? '30', 10),
    });
  });
```

- [ ] **Step 4: Smoke test**

Run: `npm run tokentrail -- dashboard --port 4920 --no-open`
Expected: prints URL, server stays running.

In another terminal:

```bash
curl -s http://127.0.0.1:4920 | head -30
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:4920/static/dashboard.css
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:4920/static/uPlot.iife.min.js
```

Expected: HTML starts with `<!doctype html>`; both static requests return `200`.

Stop the server with Ctrl-C. Open the URL in a browser and verify the page renders with hero stat, trend chart, top features list, and sidebar.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/server.ts src/commands/dashboard.ts src/index.ts
git commit -m "dashboard: Fastify server + overview route + CLI"
```

---

## Task 15: Feature Detail — data + render + route

**Files:**
- Create: `src/dashboard/data/feature.ts`
- Create: `src/dashboard/render/feature.ts`
- Modify: `src/dashboard/server.ts`
- Modify: `tests/dashboard-data.test.ts`

### Steps

- [ ] **Step 1: Extend the test file with feature-detail tests**

Add to `tests/dashboard-data.test.ts`:

```typescript
import { buildFeatureDetail } from '../src/dashboard/data/feature.js';

describe('buildFeatureDetail', () => {
  test('returns null when feature has no rollups', () => {
    const db = makeDb();
    const vm = buildFeatureDetail(db, { featureKey: 'missing', days: 30 });
    assert.equal(vm, null);
  });

  test('aggregates rollups, sessions, commits, PRs for a feature', () => {
    const db = makeDb();
    db.exec(`
      INSERT INTO feature_rollups (id, date, feature_key, feature_name, total_cost_usd, sessions_count, session_ids, branches)
      VALUES ('r1', date('now','-1 days'), 'rag', 'Local RAG', 100, 1, 's1', 'feat/rag');
      INSERT INTO sessions (session_id, title, project_dir, first_seen_at, last_seen_at)
      VALUES ('s1', 'Build the RAG', '/repo/rag', date('now','-1 days'), date('now','-1 days'));
      INSERT INTO usage_events (id, session_id, timestamp, model, estimated_cost_usd)
      VALUES ('e1', 's1', datetime('now','-1 days'), 'opus', 100);
      INSERT INTO session_commits (session_id, commit_sha, subject, authored_at, repo)
      VALUES ('s1', 'abcdef0', 'Add retriever', datetime('now','-1 days'), 'me/rag');
      INSERT INTO session_prs (session_id, repo, pr_number, pr_title, pr_url, pr_state, head_branch)
      VALUES ('s1', 'me/rag', 7, 'Add retriever', 'https://github.com/me/rag/pull/7', 'open', 'feat/rag');
    `);
    const vm = buildFeatureDetail(db, { featureKey: 'rag', days: 30 });
    assert.ok(vm);
    assert.equal(vm!.featureKey, 'rag');
    assert.equal(vm!.totalUsd, 100);
    assert.equal(vm!.sessions.length, 1);
    assert.equal(vm!.sessions[0].commits.length, 1);
    assert.equal(vm!.sessions[0].prs.length, 1);
    assert.equal(vm!.sessions[0].prs[0].prNumber, 7);
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npm test`
Expected: FAIL on `buildFeatureDetail` import.

- [ ] **Step 3: Implement `buildFeatureDetail`**

Create `src/dashboard/data/feature.ts`:

```typescript
import type DatabaseType from 'better-sqlite3';

export type FeatureDetailVM = {
  featureKey: string;
  featureName: string;
  totalUsd: number;
  deltaPct: number;
  sessionCount: number;
  branches: string[];
  dailySeries: Array<{ date: string; total: number }>;
  sessions: Array<{
    sessionId: string;
    title: string | null;
    date: string | null;
    cost: number;
    commits: Array<{ sha: string; subject: string; repo: string | null }>;
    prs: Array<{ repo: string; prNumber: number; title: string; url: string; state: string }>;
  }>;
};

export function buildFeatureDetail(
  db: DatabaseType.Database,
  opts: { featureKey: string; days: number }
): FeatureDetailVM | null {
  const days = Math.max(1, opts.days);
  const startExpr = `date('now', '-${days - 1} days')`;
  const priorStartExpr = `date('now', '-${days * 2 - 1} days')`;
  const priorEndExpr = `date('now', '-${days} days')`;

  const head = db
    .prepare(`
      SELECT MAX(feature_name) AS featureName,
             COALESCE(SUM(total_cost_usd), 0) AS totalUsd,
             COALESCE(SUM(sessions_count), 0) AS sessionCount,
             GROUP_CONCAT(DISTINCT branches) AS branches,
             GROUP_CONCAT(DISTINCT session_ids) AS sessionIds
      FROM feature_rollups
      WHERE feature_key = @key AND date >= ${startExpr}
    `)
    .get({ key: opts.featureKey }) as {
      featureName: string | null;
      totalUsd: number;
      sessionCount: number;
      branches: string | null;
      sessionIds: string | null;
    };
  if (head.totalUsd === 0 && !head.featureName) return null;

  const prior = (db
    .prepare(`SELECT COALESCE(SUM(total_cost_usd), 0) AS total FROM feature_rollups WHERE feature_key = @key AND date >= ${priorStartExpr} AND date <= ${priorEndExpr}`)
    .get({ key: opts.featureKey }) as { total: number }).total;
  const deltaPct = prior > 0 ? Math.round(((head.totalUsd - prior) / prior) * 100) : (head.totalUsd > 0 ? 100 : 0);

  const dailySeries = db
    .prepare(`SELECT date, SUM(total_cost_usd) AS total FROM feature_rollups WHERE feature_key = @key AND date >= ${startExpr} GROUP BY date ORDER BY date`)
    .all({ key: opts.featureKey }) as Array<{ date: string; total: number }>;

  const branches = (head.branches ?? '')
    .split(',')
    .map((b) => b.trim())
    .filter((b) => b.length > 0);
  const uniqueBranches = [...new Set(branches)].sort();

  // Sessions with cost.
  const sessionIds = uniqueSessionIds(head.sessionIds);
  const sessionRows = sessionIds.length === 0
    ? []
    : db
      .prepare(`
        SELECT s.session_id AS sessionId,
               s.title       AS title,
               date(s.first_seen_at) AS date,
               COALESCE((SELECT SUM(e.estimated_cost_usd) FROM usage_events e WHERE e.session_id = s.session_id), 0) AS cost
        FROM sessions s
        WHERE s.session_id IN (SELECT value FROM json_each(?))
        ORDER BY cost DESC
      `)
      .all(JSON.stringify(sessionIds)) as Array<{
        sessionId: string;
        title: string | null;
        date: string | null;
        cost: number;
      }>;

  const commitStmt = db.prepare(`SELECT commit_sha AS sha, subject, repo FROM session_commits WHERE session_id = ? ORDER BY authored_at`);
  const prStmt = db.prepare(`SELECT repo, pr_number AS prNumber, pr_title AS title, pr_url AS url, pr_state AS state FROM session_prs WHERE session_id = ? ORDER BY repo, pr_number`);

  const sessions = sessionRows.map((s) => ({
    sessionId: s.sessionId,
    title: s.title,
    date: s.date,
    cost: round2(s.cost),
    commits: commitStmt.all(s.sessionId) as FeatureDetailVM['sessions'][number]['commits'],
    prs: prStmt.all(s.sessionId) as FeatureDetailVM['sessions'][number]['prs'],
  }));

  return {
    featureKey: opts.featureKey,
    featureName: head.featureName ?? opts.featureKey,
    totalUsd: round2(head.totalUsd),
    deltaPct,
    sessionCount: head.sessionCount,
    branches: uniqueBranches,
    dailySeries,
    sessions,
  };
}

function uniqueSessionIds(csvOrNull: string | null): string[] {
  if (!csvOrNull) return [];
  const set = new Set<string>();
  for (const chunk of csvOrNull.split(',')) {
    const s = chunk.trim();
    if (s) set.add(s);
  }
  return [...set];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
```

- [ ] **Step 4: Implement the renderer**

Create `src/dashboard/render/feature.ts`:

```typescript
import type { FeatureDetailVM } from '../data/feature.js';
import { escapeHtml } from './shell.js';

export function renderFeature(vm: FeatureDetailVM): string {
  return `
<div class="single-col">
  <div class="card">
    <div class="label">${escapeHtml(vm.featureKey)} · ${vm.sessionCount} sessions · ${vm.branches.join(', ') || 'no branches'}</div>
    <div class="hero">${escapeHtml(vm.featureName)}</div>
    <div class="kicker">$${vm.totalUsd.toFixed(0)}</div>
    <div class="delta ${vm.deltaPct >= 0 ? 'up' : 'down'}">${vm.deltaPct >= 0 ? '▲' : '▼'} ${Math.abs(vm.deltaPct)}% vs prior</div>
  </div>

  <div class="card chart-card">
    <div class="label">Lifecycle</div>
    <div id="trend-chart" style="width:100%;height:240px"></div>
    <script type="application/json" id="trend-data">${escapeHtml(JSON.stringify(vm.dailySeries))}</script>
  </div>

  <div class="card">
    <div class="label">Sessions</div>
    ${vm.sessions.length === 0 ? '<div class="muted">No sessions in window.</div>' : renderSessions(vm.sessions)}
  </div>
</div>
  `;
}

function renderSessions(items: FeatureDetailVM['sessions']): string {
  return items
    .map((s, i) => {
      const idShort = s.sessionId.slice(0, 8);
      const detailsId = `session-${i}-details`;
      return `
        <div class="session-row" data-expand-target="${detailsId}">
          <span class="amt">$${s.cost.toFixed(0)}</span>
          <span class="muted">${escapeHtml(s.date ?? '')}</span>
          <span class="sha">${idShort}</span>
          <span class="subject">${escapeHtml((s.title ?? '(no title)').slice(0, 120))}</span>
          <span class="muted">${s.commits.length} commits · ${s.prs.length} PRs</span>
        </div>
        <div class="session-details" id="${detailsId}">
          ${renderCommitsBlock(s.commits)}
          ${renderPrsBlock(s.prs)}
        </div>
      `;
    })
    .join('');
}

function renderCommitsBlock(commits: FeatureDetailVM['sessions'][number]['commits']): string {
  if (commits.length === 0) return '';
  return `<div class="sub-label">Commits</div>` + commits
    .slice(0, 5)
    .map((c) => {
      const shaShort = c.sha.slice(0, 8);
      const url = c.repo ? `https://github.com/${c.repo}/commit/${c.sha}` : null;
      const sha = url ? `<a class="sha" href="${url}" target="_blank" rel="noopener">${shaShort}</a>` : `<span class="sha">${shaShort}</span>`;
      return `<div class="commit-row">${sha} <span class="subject">${escapeHtml(c.subject)}</span></div>`;
    })
    .join('');
}

function renderPrsBlock(prs: FeatureDetailVM['sessions'][number]['prs']): string {
  if (prs.length === 0) return '';
  return `<div class="sub-label">Pull Requests</div>` + prs
    .map(
      (p) => `<div class="pr-row"><a href="${escapeHtml(p.url)}" target="_blank" rel="noopener">${escapeHtml(p.repo)}#${p.prNumber}</a> <span class="muted">[${escapeHtml(p.state)}]</span> <span class="subject">${escapeHtml(p.title)}</span></div>`
    )
    .join('');
}
```

- [ ] **Step 5: Add CSS for session row expand**

Append to `src/dashboard/static/dashboard.css`:

```css
.single-col { max-width: 960px; margin: 0 auto; display: flex; flex-direction: column; gap: var(--space-l); }
.session-row {
  display: grid;
  grid-template-columns: 56px 96px 80px 1fr auto;
  gap: var(--space-s);
  padding: 6px 4px;
  cursor: pointer;
  border-bottom: 1px dashed rgba(139,111,71,0.2);
  font-size: var(--size-body);
}
.session-row:hover { background: rgba(255,255,255,0.4); }
.session-details {
  display: none;
  padding: var(--space-s) var(--space-m) var(--space-m) var(--space-m);
  background: rgba(255,255,255,0.3);
  border-bottom: 1px dashed rgba(139,111,71,0.2);
}
.session-details.open { display: block; }
.sub-label {
  font-family: var(--font-serif);
  font-size: var(--size-label);
  text-transform: uppercase;
  letter-spacing: 1.5px;
  color: var(--color-ink-muted);
  margin-top: var(--space-s);
  margin-bottom: 4px;
}
.pr-row { font-size: var(--size-small); padding: 3px 0; }
```

- [ ] **Step 6: Wire the route**

Edit `src/dashboard/server.ts`. Add imports:

```typescript
import { buildFeatureDetail } from './data/feature.js';
import { renderFeature } from './render/feature.js';
```

Add the route inside `buildServer`, after the `'/'` route:

```typescript
  app.get<{ Params: { key: string } }>('/feature/:key', async (req, reply) => {
    const days = parseDays(req.query, opts.defaultDays);
    const vm = buildFeatureDetail(getDb(), { featureKey: req.params.key, days });
    if (!vm) {
      reply.code(404).type('text/html; charset=utf-8');
      return renderShell({ title: 'Feature not found', days, showBack: true }, '<div class="card"><div class="hero">Not found</div></div>');
    }
    const body = renderFeature(vm);
    reply.type('text/html; charset=utf-8');
    return renderShell({ title: `${vm.featureName} · Tokentrail`, activeTab: 'feature', days, showBack: true }, body);
  });
```

- [ ] **Step 7: Run tests, verify all pass**

Run: `npm test`
Expected: green across smoke + anomalies + dashboard-data.

- [ ] **Step 8: Smoke test in browser**

Run: `npm run tokentrail -- dashboard --no-open`
Visit `/` then click a top-feature link. Confirm the Feature Detail page renders with hero, lifecycle chart, and sessions table. Click a session row to expand commits/PRs.

- [ ] **Step 9: Commit**

```bash
git add src/dashboard/data/feature.ts src/dashboard/render/feature.ts src/dashboard/server.ts src/dashboard/static/dashboard.css tests/dashboard-data.test.ts
git commit -m "dashboard: feature detail page"
```

---

## Task 16: Worth-a-look route

**Files:**
- Create: `src/dashboard/data/worth-a-look.ts`
- Create: `src/dashboard/render/worth-a-look.ts`
- Modify: `src/dashboard/server.ts`

### Steps

- [ ] **Step 1: Implement view-model**

Create `src/dashboard/data/worth-a-look.ts`:

```typescript
import type DatabaseType from 'better-sqlite3';

export type WorthALookVM = {
  items: Array<{
    id: number;
    kind: string;
    date: string;
    featureKey: string | null;
    sessionId: string | null;
    amount: number;
    reason: string;
    multiplier: number;
  }>;
};

export function buildWorthALook(db: DatabaseType.Database): WorthALookVM {
  const items = db
    .prepare(`
      SELECT id, kind, date,
             feature_key AS featureKey,
             session_id  AS sessionId,
             ROUND(amount, 2)     AS amount,
             ROUND(multiplier, 2) AS multiplier,
             reason
      FROM anomalies
      WHERE dismissed_at IS NULL
      ORDER BY date DESC, multiplier DESC
    `)
    .all() as WorthALookVM['items'];
  return { items };
}
```

- [ ] **Step 2: Implement render**

Create `src/dashboard/render/worth-a-look.ts`:

```typescript
import type { WorthALookVM } from '../data/worth-a-look.js';
import { escapeHtml } from './shell.js';

export function renderWorthALook(vm: WorthALookVM): string {
  if (vm.items.length === 0) {
    return `<div class="single-col"><div class="card"><div class="hero">All quiet on the trail.</div><div class="muted">Nothing flagged as worth a look.</div></div></div>`;
  }
  const rows = vm.items
    .map((a) => {
      const href = a.featureKey
        ? `/feature/${encodeURIComponent(a.featureKey)}`
        : null;
      const label = href
        ? `<a href="${href}">${escapeHtml(a.featureKey ?? '')}</a>`
        : (a.sessionId ? `<span class="sha">${escapeHtml(a.sessionId.slice(0, 8))}…</span>` : '');
      return `
        <div class="anomaly-row anomaly-full">
          <span class="anomaly-date">${escapeHtml(a.date)}</span>
          <span class="anomaly-kind">${escapeHtml(a.kind)}</span>
          <span class="anomaly-target">${label}</span>
          <span class="anomaly-reason">${escapeHtml(a.reason)}</span>
        </div>
      `;
    })
    .join('');
  return `
<div class="single-col">
  <div class="card">
    <div class="label">Worth a look · ${vm.items.length} active</div>
    ${rows}
    <div class="muted" style="margin-top:16px">Dismiss via CLI: <code>tokentrail anomaly dismiss &lt;id&gt;</code></div>
  </div>
</div>
  `;
}
```

- [ ] **Step 3: Add minimal styling**

Append to `src/dashboard/static/dashboard.css`:

```css
.anomaly-full {
  display: grid;
  grid-template-columns: 100px 110px 1fr 2fr;
  gap: var(--space-s);
  padding: 6px 4px;
  border-bottom: 1px dashed rgba(139,111,71,0.2);
  font-size: var(--size-body);
}
.anomaly-kind { color: var(--color-ink-muted); font-family: var(--font-mono); font-size: var(--size-small); }
```

- [ ] **Step 4: Add the route**

Edit `src/dashboard/server.ts`. Add imports:

```typescript
import { buildWorthALook } from './data/worth-a-look.js';
import { renderWorthALook } from './render/worth-a-look.js';
```

Add route inside `buildServer`:

```typescript
  app.get('/worth-a-look', async (_req, reply) => {
    const vm = buildWorthALook(getDb());
    reply.type('text/html; charset=utf-8');
    return renderShell({ title: 'Worth a look · Tokentrail', activeTab: 'worth-a-look', days: opts.defaultDays, showBack: true }, renderWorthALook(vm));
  });
```

- [ ] **Step 5: Smoke test**

Run: `npm run tokentrail -- dashboard --no-open`
Visit `/worth-a-look`. Confirm the list renders or the "All quiet" empty state shows.

- [ ] **Step 6: Commit**

```bash
git add src/dashboard/data/worth-a-look.ts src/dashboard/render/worth-a-look.ts src/dashboard/server.ts src/dashboard/static/dashboard.css
git commit -m "dashboard: worth-a-look anomaly list page"
```

---

## Task 17: Notion — add Type / Anomaly columns

**Files:**
- Modify: `src/services/notion.ts`

### Steps

- [ ] **Step 1: Extend NOTION_PROPS and the payload type**

Edit `src/services/notion.ts`. Change `NOTION_PROPS`:

```typescript
export const NOTION_PROPS = {
  name: 'Name',
  date: 'Date',
  featureKey: 'Feature Key',
  featureName: 'Feature Name',
  repo: 'Repo',
  branches: 'Branches',
  totalCostUsd: 'Total Cost USD',
  totalInputTokens: 'Total Input Tokens',
  totalOutputTokens: 'Total Output Tokens',
  sessions: 'Sessions',
  syncedAt: 'Synced At',
  commits: 'Commits',
  type: 'Type',                   // NEW — 'Rollup' | 'Digest'
  anomaly: 'Anomaly',             // NEW — checkbox
  anomalyReason: 'Anomaly reason' // NEW — rich_text
} as const;
```

Change `RollupPagePayload`:

```typescript
export type RollupPagePayload = {
  date: string;
  featureKey: string;
  featureName: string;
  repo: string | null;
  branches: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  sessions: number;
  commitSummary: string | null;
  isAnomaly: boolean;             // NEW
  anomalyReason: string | null;   // NEW
  type: 'Rollup' | 'Digest';      // NEW
};
```

Inside `buildProperties`, after the existing `[NOTION_PROPS.commits]` entry, add:

```typescript
    [NOTION_PROPS.type]: { select: { name: p.type } },
    [NOTION_PROPS.anomaly]: { checkbox: p.isAnomaly },
    [NOTION_PROPS.anomalyReason]: {
      rich_text: [{ type: 'text', text: { content: p.anomalyReason ?? '' } }],
    },
```

- [ ] **Step 2: Tell the user the manual one-time Notion schema step**

Add a comment block at the top of `buildProperties` (above the function):

```typescript
// One-time Notion schema setup (manual or via the notion-update-data-source
// MCP tool — see docs/superpowers/specs/2026-06-15-tokentrail-visualization-design.md):
//
//   ALTER COLUMN "Type"           SET SELECT WITH OPTIONS "Rollup", "Digest"
//   ALTER COLUMN "Anomaly"        SET CHECKBOX
//   ALTER COLUMN "Anomaly reason" SET RICH_TEXT
//
// Sync will silently fail (warn + continue) until these columns exist.
```

- [ ] **Step 3: Manually add the columns to the Notion database**

Either through the Notion UI or via the MCP tool, add these three columns to the Tokentrail database. Capture the data-source command if using MCP.

- [ ] **Step 4: Verify schema by running existing sync once**

Run: `npm run tokentrail -- sync --days 1`
Expected: no warnings about missing properties. Spot-check a Notion page to confirm Type=Rollup, Anomaly=unchecked, Anomaly reason=empty.

- [ ] **Step 5: Commit**

```bash
git add src/services/notion.ts
git commit -m "notion: add Type / Anomaly / Anomaly reason properties"
```

---

## Task 18: Sync — populate anomaly columns and inject dashboard URL

**Files:**
- Modify: `src/commands/sync.ts`
- Modify: `src/services/notion.ts`

### Steps

- [ ] **Step 1: Update `buildRollupBody` to accept a dashboard URL prefix**

Edit `src/services/notion.ts`. Change the function signature and prepend a paragraph block when a URL is given:

```typescript
export function buildRollupBody(ctx: RollupBodyContext, opts?: { dashboardUrl?: string }): NotionBlock[] {
  const blocks: NotionBlock[] = [];

  if (opts?.dashboardUrl) {
    blocks.push({
      object: 'block',
      type: 'paragraph',
      paragraph: {
        rich_text: [
          { type: 'text', text: { content: 'View on dashboard →', link: { url: opts.dashboardUrl } } },
        ],
      },
    });
  }

  // (existing Sessions / PRs / Commits sections follow)
  // …
}
```

(Keep the rest of `buildRollupBody` unchanged.)

- [ ] **Step 2: Extend sync to fetch anomalies and pick the top one per rollup**

Edit `src/commands/sync.ts`. Add the import at the top:

```typescript
import { chooseTopAnomaly, type DetectedAnomaly } from '../services/anomalies.js';
```

After the existing `prsForRollup` prepare, add an anomaly lookup:

```typescript
  const anomaliesForRollup = db.prepare(`
    SELECT kind, date, feature_key, session_id, amount, baseline, multiplier, reason
    FROM anomalies
    WHERE dismissed_at IS NULL
      AND ((feature_key = @feature_key AND date = @date)
        OR (date = @date AND feature_key IS NULL))
  `);
```

Inside the per-row loop, before `payload` is built, look up the anomaly:

```typescript
    const rowAnomalies = anomaliesForRollup.all({
      feature_key: r.feature_key,
      date: r.date,
    }) as Array<{
      kind: 'spike_day' | 'burning_feature' | 'hot_session';
      date: string;
      feature_key: string | null;
      session_id: string | null;
      amount: number;
      baseline: number;
      multiplier: number;
      reason: string;
    }>;
    const top = chooseTopAnomaly(
      rowAnomalies.map((a) => ({
        kind: a.kind,
        date: a.date,
        feature_key: a.feature_key,
        session_id: a.session_id,
        amount: a.amount,
        baseline: a.baseline,
        multiplier: a.multiplier,
        reason: a.reason,
      })) as DetectedAnomaly[]
    );
```

Update the `payload` construction to include the new fields:

```typescript
    const payload: RollupPagePayload = {
      date: r.date,
      featureKey: r.feature_key,
      featureName: r.feature_name,
      repo: r.repo,
      branches: r.branches ?? '',
      totalInputTokens: r.total_input_tokens,
      totalOutputTokens: r.total_output_tokens,
      totalCostUsd: r.total_cost_usd,
      sessions: r.sessions_count,
      commitSummary: r.commit_summary,
      isAnomaly: top !== null,
      anomalyReason: top?.reason ?? null,
      type: 'Rollup',
    };
```

Update the `buildRollupBody` call to inject the dashboard URL:

```typescript
    const dashboardUrl = `http://127.0.0.1:4920/feature/${encodeURIComponent(r.feature_key)}?days=30`;
    const children = body ? buildRollupBody(body, { dashboardUrl }) : [];
```

- [ ] **Step 3: Manually verify**

Run: `npm run tokentrail -- rollup` (recomputes anomalies)
Run: `npm run tokentrail -- sync --days 7 --force`
Expected: completes without warnings. Open a Notion rollup page — confirm:
  - "View on dashboard →" link at the top of the body
  - `Type = Rollup`
  - `Anomaly` is checked for rollups that have a matching anomaly
  - `Anomaly reason` is populated for those rows

- [ ] **Step 4: Commit**

```bash
git add src/commands/sync.ts src/services/notion.ts
git commit -m "sync: surface anomalies as Notion columns + dashboard link in body"
```

---

## Task 19: Notion weekly digest (TDD)

**Files:**
- Create: `src/services/notion-digest.ts`
- Create: `tests/notion-digest.test.ts`
- Modify: `src/commands/sync.ts`
- Modify: `src/services/notion.ts`

### Steps

- [ ] **Step 1: Write failing tests for the digest body builder**

Create `tests/notion-digest.test.ts`:

```typescript
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildDigestBody, type DigestContext } from '../src/services/notion-digest.js';

describe('buildDigestBody', () => {
  test('renders all five sections when ctx is populated', () => {
    const ctx: DigestContext = {
      weekStart: '2026-06-08',
      weekTotalUsd: 1234,
      priorWeekTotalUsd: 1100,
      topFeatures: [
        { featureKey: 'rag', featureName: 'Local RAG', costUsd: 600, sessions: 4 },
      ],
      anomalies: [
        { kind: 'spike_day', date: '2026-06-09', reason: '$400 — 4× …' },
      ],
      recentCommits: [
        { sha: 'abcdef0', subject: 'Add retriever', repo: 'me/rag' },
      ],
      openPrs: [
        { repo: 'me/rag', prNumber: 7, title: 'Add retriever', url: 'https://github.com/me/rag/pull/7', state: 'open' },
      ],
    };
    const blocks = buildDigestBody(ctx);
    const headingTexts = blocks
      .filter((b: any) => b.type === 'heading_2')
      .map((b: any) => b.heading_2.rich_text[0].text.content);
    assert.deepEqual(headingTexts, [
      'The trail so far',
      'Top burn paths',
      'Worth a look',
      'Recent commits',
      'Open PRs',
    ]);
  });

  test('skips empty sections gracefully', () => {
    const ctx: DigestContext = {
      weekStart: '2026-06-08',
      weekTotalUsd: 0,
      priorWeekTotalUsd: 0,
      topFeatures: [],
      anomalies: [],
      recentCommits: [],
      openPrs: [],
    };
    const blocks = buildDigestBody(ctx);
    const headingTexts = blocks
      .filter((b: any) => b.type === 'heading_2')
      .map((b: any) => b.heading_2.rich_text[0].text.content);
    // "Trail so far" always renders even at $0 — it's the headline.
    assert.deepEqual(headingTexts, ['The trail so far']);
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npm test`
Expected: FAIL on the import.

- [ ] **Step 3: Implement the digest body builder**

Create `src/services/notion-digest.ts`:

```typescript
import type { NotionBlock } from './notion.js';

export type DigestContext = {
  weekStart: string;             // YYYY-MM-DD (Monday)
  weekTotalUsd: number;
  priorWeekTotalUsd: number;
  topFeatures: Array<{ featureKey: string; featureName: string; costUsd: number; sessions: number }>;
  anomalies: Array<{ kind: string; date: string; reason: string }>;
  recentCommits: Array<{ sha: string; subject: string; repo: string | null }>;
  openPrs: Array<{ repo: string; prNumber: number; title: string; url: string; state: string }>;
};

export function buildDigestBody(ctx: DigestContext): NotionBlock[] {
  const blocks: NotionBlock[] = [];

  blocks.push(heading('The trail so far'));
  const delta = ctx.priorWeekTotalUsd > 0
    ? Math.round(((ctx.weekTotalUsd - ctx.priorWeekTotalUsd) / ctx.priorWeekTotalUsd) * 100)
    : 0;
  blocks.push(paragraph([
    plain(`$${ctx.weekTotalUsd.toFixed(0)} this week`),
    plain(ctx.priorWeekTotalUsd > 0
      ? `  ·  ${delta >= 0 ? '+' : ''}${delta}% vs prior week ($${ctx.priorWeekTotalUsd.toFixed(0)})`
      : '  ·  no prior-week baseline'),
  ]));

  if (ctx.topFeatures.length > 0) {
    blocks.push(heading('Top burn paths'));
    for (const f of ctx.topFeatures) {
      blocks.push(bullet([
        plain(`$${f.costUsd.toFixed(0)} — ${f.featureName} (${f.sessions} sessions)`),
      ]));
    }
  }

  if (ctx.anomalies.length > 0) {
    blocks.push(heading('Worth a look'));
    for (const a of ctx.anomalies) {
      blocks.push(bullet([plain(`${a.date} — ${a.reason}`)]));
    }
  }

  if (ctx.recentCommits.length > 0) {
    blocks.push(heading('Recent commits'));
    for (const c of ctx.recentCommits.slice(0, 10)) {
      const shaShort = c.sha.slice(0, 8);
      const url = c.repo ? `https://github.com/${c.repo}/commit/${c.sha}` : null;
      const runs: NotionBlock[] = url
        ? [link(shaShort, url), plain(`  ${c.subject}`)]
        : [plain(`${shaShort}  ${c.subject}`)];
      blocks.push(bullet(runs));
    }
  }

  if (ctx.openPrs.length > 0) {
    blocks.push(heading('Open PRs'));
    for (const p of ctx.openPrs) {
      blocks.push(bullet([
        plain(`[${p.state}] `),
        link(`${p.repo}#${p.prNumber}`, p.url),
        plain(`  ${p.title}`),
      ]));
    }
  }

  return blocks;
}

function heading(text: string): NotionBlock {
  return { object: 'block', type: 'heading_2', heading_2: { rich_text: [plain(text)] } };
}
function bullet(rich: NotionBlock[]): NotionBlock {
  return { object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: rich } };
}
function paragraph(rich: NotionBlock[]): NotionBlock {
  return { object: 'block', type: 'paragraph', paragraph: { rich_text: rich } };
}
function plain(content: string): NotionBlock {
  return { type: 'text', text: { content } };
}
function link(content: string, url: string): NotionBlock {
  return { type: 'text', text: { content, link: { url } } };
}
```

- [ ] **Step 4: Run tests, verify all pass**

Run: `npm test`
Expected: green.

- [ ] **Step 5: Add a digest upsert helper to NotionService**

Edit `src/services/notion.ts`. Inside the `NotionService` class, after `rebuildPageBody`, add:

```typescript
  async findDigestPage(weekStart: string): Promise<string | null> {
    try {
      const res = await this.client.databases.query({
        database_id: this.databaseId,
        page_size: 1,
        filter: {
          and: [
            { property: NOTION_PROPS.type, select: { equals: 'Digest' } },
            { property: NOTION_PROPS.date, date: { equals: weekStart } },
          ],
        },
      });
      const page = res.results[0];
      return page?.id ?? null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`  notion: digest lookup failed for ${weekStart}: ${msg}`);
      return null;
    }
  }

  async upsertDigestPage(
    weekStart: string,
    weekTotalUsd: number,
    body: NotionBlock[]
  ): Promise<string | null> {
    try {
      const existing = await this.findDigestPage(weekStart);
      const props: Record<string, unknown> = {
        [NOTION_PROPS.name]: { title: [{ type: 'text', text: { content: `Week of ${weekStart}` } }] },
        [NOTION_PROPS.date]: { date: { start: weekStart } },
        [NOTION_PROPS.type]: { select: { name: 'Digest' } },
        [NOTION_PROPS.totalCostUsd]: { number: weekTotalUsd },
        [NOTION_PROPS.syncedAt]: { date: { start: new Date().toISOString() } },
      };
      if (existing) {
        await this.client.pages.update({ page_id: existing, properties: props as never });
        await this.rebuildPageBody(existing, body);
        return existing;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res = await this.client.pages.create({
        parent: { database_id: this.databaseId },
        properties: props as never,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        children: body as any,
      });
      return res.id;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`  notion: digest upsert failed for ${weekStart}: ${msg}`);
      return null;
    }
  }
```

- [ ] **Step 6: Add a digest assembly helper in sync.ts**

Edit `src/commands/sync.ts`. Add the import:

```typescript
import { buildDigestBody, type DigestContext } from '../services/notion-digest.js';
```

At the end of `runSync` (before the final `console.log`), call:

```typescript
  const digestResult = await syncWeeklyDigest(db, notion);
  if (digestResult) {
    console.log(`Weekly digest synced for week of ${digestResult.weekStart}.`);
  }
```

Add the helper outside the main function:

```typescript
async function syncWeeklyDigest(
  db: ReturnType<typeof getDb>,
  notion: NotionService
): Promise<{ weekStart: string } | null> {
  // Monday of the current week (ISO day-of-week 1 = Monday).
  const weekStart = (db
    .prepare(`SELECT date('now', 'weekday 0', '-6 days') AS d`)
    .get() as { d: string }).d;
  const weekEnd = (db.prepare(`SELECT date(?, '+6 days') AS d`).get(weekStart) as { d: string }).d;
  const priorStart = (db.prepare(`SELECT date(?, '-7 days') AS d`).get(weekStart) as { d: string }).d;
  const priorEnd = (db.prepare(`SELECT date(?, '-1 days') AS d`).get(weekStart) as { d: string }).d;

  const weekTotal = (db
    .prepare(`SELECT COALESCE(SUM(total_cost_usd), 0) AS t FROM feature_rollups WHERE date >= ? AND date <= ?`)
    .get(weekStart, weekEnd) as { t: number }).t;
  const priorTotal = (db
    .prepare(`SELECT COALESCE(SUM(total_cost_usd), 0) AS t FROM feature_rollups WHERE date >= ? AND date <= ?`)
    .get(priorStart, priorEnd) as { t: number }).t;

  const topFeatures = db
    .prepare(`
      SELECT feature_key AS featureKey,
             MAX(feature_name) AS featureName,
             ROUND(SUM(total_cost_usd), 2) AS costUsd,
             SUM(sessions_count) AS sessions
      FROM feature_rollups
      WHERE date >= ? AND date <= ?
      GROUP BY feature_key
      ORDER BY costUsd DESC
      LIMIT 5
    `)
    .all(weekStart, weekEnd) as DigestContext['topFeatures'];

  const anomalies = db
    .prepare(`SELECT kind, date, reason FROM anomalies WHERE dismissed_at IS NULL AND date >= ? AND date <= ? ORDER BY multiplier DESC`)
    .all(weekStart, weekEnd) as DigestContext['anomalies'];

  const recentCommits = db
    .prepare(`SELECT commit_sha AS sha, subject, repo FROM session_commits WHERE authored_at IS NOT NULL ORDER BY authored_at DESC LIMIT 10`)
    .all() as DigestContext['recentCommits'];

  const openPrs = db
    .prepare(`SELECT DISTINCT repo, pr_number AS prNumber, pr_title AS title, pr_url AS url, pr_state AS state FROM session_prs WHERE pr_state = 'open' ORDER BY repo, pr_number LIMIT 20`)
    .all() as DigestContext['openPrs'];

  const body = buildDigestBody({
    weekStart,
    weekTotalUsd: weekTotal,
    priorWeekTotalUsd: priorTotal,
    topFeatures,
    anomalies,
    recentCommits,
    openPrs,
  });
  const pageId = await notion.upsertDigestPage(weekStart, weekTotal, body);
  return pageId ? { weekStart } : null;
}
```

Add `NotionService` to the imports at the top of `sync.ts` if not already imported (it is — keep one named import line).

- [ ] **Step 7: Manually verify**

Run: `npm run tokentrail -- sync --days 1 --force`
Expected: trailing line `Weekly digest synced for week of YYYY-MM-DD.`

Open Notion. Confirm a page titled `Week of YYYY-MM-DD` exists with `Type = Digest` and body sections in the expected order.

Re-run: `npm run tokentrail -- sync --days 1 --force`
Expected: the same digest page is updated, not duplicated.

- [ ] **Step 8: Commit**

```bash
git add src/services/notion-digest.ts src/services/notion.ts src/commands/sync.ts tests/notion-digest.test.ts
git commit -m "notion: weekly digest page (idempotent upsert)"
```

---

## Task 20: README touch-up + manual verification pass

**Files:**
- Modify: `README.md` (if it exists)
- Smoke-test the entire flow end-to-end

### Steps

- [ ] **Step 1: Read the existing README**

Run: `ls README.md && wc -l README.md`
If it exists, read it. If not, skip the README edits in this task.

- [ ] **Step 2: Add a "Dashboard" section to the README (if README exists)**

Append (or insert near other command docs):

```markdown
## Dashboard

  npm run tokentrail -- dashboard

Starts a local Fastify server on `127.0.0.1:4920` and opens your browser to
the Tokentrail overview. Flags:

  --port <n>     bind to a different port (default 4920)
  --no-open      print the URL but don't auto-launch the browser
  --days <n>     initial time window (default 30)

The dashboard is read-only. Labeling, anomaly dismissal, and sync stay on the
CLI. Stop it with Ctrl-C.

### Anomalies

Anomalies are recomputed at the end of every `tokentrail rollup` and surfaced
both in the dashboard sidebar/`worth-a-look` page and in Notion (`Anomaly` /
`Anomaly reason` columns + the weekly digest page). Dismiss one with:

  tokentrail anomaly dismiss <id>

Dismissed anomalies survive future rollup runs.
```

- [ ] **Step 3: Full end-to-end manual verification**

Run, in order:

```bash
npm run build
npm test
npm run tokentrail -- ingest
npm run tokentrail -- rollup
npm run tokentrail -- sync --days 7 --force
npm run tokentrail -- anomaly
npm run tokentrail -- dashboard --no-open
```

Expected:
- `npm run build`: clean. No TypeScript errors.
- `npm test`: green.
- `ingest`: usual output.
- `rollup`: usual rollup line + new `Anomalies: N active.` line.
- `sync`: usual output + `Weekly digest synced for week of YYYY-MM-DD.`
- `anomaly`: prints active anomalies (or "No active anomalies.")
- `dashboard`: prints URL; visit Overview, click a top feature, expand a session, visit `/worth-a-look`.

- [ ] **Step 4: Commit (only if README changed)**

```bash
git add README.md
git commit -m "docs: dashboard + anomaly usage"
```

---

## Self-Review Checklist (run after writing this plan)

**Spec coverage:**

- [x] Section 1 (Architecture/stack): Tasks 7 (Fastify dep), 8 (tokens), 9 (shell), 12 (CSS/JS), 13 (uPlot), 14 (server).
- [x] Section 2 (Pages): Task 10–11 (Overview), 15 (Feature Detail), 16 (Worth-a-look). Session Detail explicitly skipped (per spec).
- [x] Section 3 (Anomalies): Tasks 2 (config), 3 (table), 4 (compute), 5 (wire to rollup), 6 (dismissal CLI).
- [x] Section 4 (Notion): Tasks 17 (columns), 18 (populate + dashboard URL), 19 (weekly digest).
- [x] Implementation order from spec preserved: anomalies first (steps 1-2), dashboard (3-5), Notion (6), polish woven into each task.

**Type consistency:**

- `DetectedAnomaly` defined in `src/services/anomalies.ts`, re-used by `anomalies-db.ts` and `sync.ts` via the same named import.
- `RollupPagePayload` extended consistently across `notion.ts` and `sync.ts`.
- `NotionBlock` re-exported from `notion.ts` and imported by `notion-digest.ts`.
- `chooseTopAnomaly` defined once in `anomalies.ts`, used once in `sync.ts`.

**No placeholders:** every code block is complete. SQL queries are actual queries, not pseudo-code.

---

**Plan complete and saved to `docs/superpowers/plans/2026-06-15-tokentrail-visualization.md`.**

Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
