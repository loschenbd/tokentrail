# Today Page Repair + Timeline-First Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the Today page's overlapping burn-paths rows (markup drift) and enrich the page with a burn-by-hour strip, sessions list, shipped-today card, and pace stat.

**Architecture:** Extract Overview's project-row markup into a shared renderer both pages call (bug fix + drift prevention). Extend `TodayVM` with hourly buckets, pace, sessions, and shipped data from SQLite. Render everything server-side — the hourly strip is CSS bars, no uPlot, no client JS.

**Tech Stack:** Node 20+, TypeScript, better-sqlite3, node:test via `node --import tsx --test`, server-rendered HTML strings, plain CSS.

**Spec:** `docs/superpowers/specs/2026-07-11-today-page-redesign-design.md`

## Global Constraints

- All costs are labeled estimated (constitution rule 3) — new figures use the existing convention; don't add new "estimated" badges where sibling cards have none.
- Fantasy flavor belongs in microcopy only (rule 8). The one flavor line in this plan: the shipped-card empty state.
- All new date/time SQL uses the `'localtime'` modifier, matching existing queries.
- Run tests with `npm test` (runs all) or `node --import tsx --test <file>` (single file).
- Never hardcode API keys; no new dependencies.

---

### Task 1: Shared project-row renderer (fixes the overlap bug)

**Files:**
- Create: `src/dashboard/render/project-rows.ts`
- Create: `tests/project-rows.test.ts`
- Modify: `src/dashboard/render/overview.ts:89-104` (replace `renderTopProjects` body)
- Modify: `src/dashboard/render/today.ts:55-71` (replace `renderTopProjects`)

**Interfaces:**
- Consumes: `OverviewVM['topProjects']` items — `{ key: string; name: string; totalUsd: number; pct: number; featureCount: number; color: string }` (already includes `color`; `TodayVM.topProjects` is the same type).
- Produces: `renderProjectRows(items, opts?)` from `render/project-rows.ts`:
  `(items: ProjectRowItem[], opts?: { staticFill?: boolean; emptyMessage?: string }) => string`. `staticFill: true` emits a solid single-color `subbar-segment` (Today has no trend-data JSON for JS hydration; Overview omits it and lets `dashboard.js` inject feature segments).

- [ ] **Step 1: Write the failing test**

Create `tests/project-rows.test.ts`:

```ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { renderProjectRows } from '../src/dashboard/render/project-rows.js';
import { renderToday } from '../src/dashboard/render/today.js';
import type { TodayVM } from '../src/dashboard/data/today.js';

const item = {
  key: 'research',
  name: 'Research',
  totalUsd: 17,
  pct: 60,
  featureCount: 2,
  color: '#8b6f47',
};

describe('renderProjectRows', () => {
  test('emits the CSS grid grammar: rank, swatch, name-col, amt-col, subbar', () => {
    const html = renderProjectRows([item]);
    for (const cls of ['rank', 'swatch', 'name-col', 'amt-col', 'subbar']) {
      assert.match(html, new RegExp(`class="${cls}`), `missing .${cls}`);
    }
    // The legacy Today classes must be gone — they overlap in the new grid.
    assert.doesNotMatch(html, /class="mile"/);
    assert.doesNotMatch(html, /class="amt"/);
  });

  test('staticFill emits a solid subbar segment; default emits none', () => {
    assert.match(renderProjectRows([item], { staticFill: true }), /subbar-segment/);
    assert.doesNotMatch(renderProjectRows([item]), /subbar-segment/);
  });

  test('escapes project names', () => {
    const html = renderProjectRows([{ ...item, name: '<script>x' }]);
    assert.doesNotMatch(html, /<script>x/);
  });
});

describe('renderToday project rows', () => {
  test('Today page uses the shared grammar (drift tripwire)', () => {
    const vm: TodayVM = {
      todayUsd: 28,
      yesterdayUsd: 25,
      deltaPct: 13,
      sessionsToday: 4,
      topProjects: [item],
      anomalies: [],
    };
    const html = renderToday(vm);
    for (const cls of ['rank', 'swatch', 'name-col', 'amt-col', 'subbar']) {
      assert.match(html, new RegExp(`class="${cls}`), `Today drifted: missing .${cls}`);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test tests/project-rows.test.ts`
Expected: FAIL — `Cannot find module '.../render/project-rows.js'`

- [ ] **Step 3: Create the shared renderer**

Create `src/dashboard/render/project-rows.ts`:

```ts
import { escapeHtml } from './shell.js';

export type ProjectRowItem = {
  key: string;
  name: string;
  totalUsd: number;
  pct: number;
  featureCount: number;
  color: string;
};

/**
 * Shared burn-paths row. Overview and Today MUST both render project rows
 * through this function: the .project-row CSS grid places children by the
 * exact classes below, and hand-rolled markup drifts (see the 2026-07-11
 * Today-page overlap bug).
 *
 * staticFill: Today has no trend-data JSON, so dashboard.js never injects
 * feature segments there — pass true to emit one solid segment instead.
 */
export function renderProjectRows(
  items: ProjectRowItem[],
  opts: { staticFill?: boolean; emptyMessage?: string } = {}
): string {
  if (items.length === 0) {
    return `<div class="muted">${escapeHtml(opts.emptyMessage ?? 'No project activity yet.')}</div>`;
  }
  return items
    .map((p, i) => {
      const color = escapeHtml(p.color);
      const fill = opts.staticFill
        ? `<div class="subbar-segment" style="background:${color};width:100%"></div>`
        : '';
      return `<div class="project-row" data-project-key="${escapeHtml(p.key)}" data-project-color="${color}">
          <div class="rank">${i + 1}</div>
          <span class="swatch" style="background:${color}"></span>
          <div class="name-col"><a href="/project/${encodeURIComponent(p.key)}">${escapeHtml(p.name)}</a> <span class="muted">· ${p.featureCount} features</span></div>
          <div class="amt-col">$${p.totalUsd.toFixed(0)} · ${p.pct.toFixed(0)}%</div>
          <div class="subbar" data-project-key="${escapeHtml(p.key)}" style="--pct:${p.pct}">${fill}</div>
        </div>`;
    })
    .join('');
}
```

- [ ] **Step 4: Point Overview at the shared renderer**

In `src/dashboard/render/overview.ts`: add the import and replace the whole local `renderTopProjects` (lines 89–104) with a thin wrapper so call sites don't change:

```ts
import { renderProjectRows } from './project-rows.js';

function renderTopProjects(items: OverviewVM['topProjects']): string {
  return renderProjectRows(items);
}
```

- [ ] **Step 5: Point Today at the shared renderer**

In `src/dashboard/render/today.ts`: add the same import; delete the local `renderTopProjects` (lines 55–71, the old `mile`/`name`/`amt` + `.bar` markup) and replace its call site inside `renderToday`:

```ts
import { renderProjectRows } from './project-rows.js';
```

```ts
      <div class="label">Today's burn paths</div>
      ${renderProjectRows(vm.topProjects, { staticFill: true, emptyMessage: 'No project activity today.' })}
```

- [ ] **Step 6: Run the new test, then the full suite**

Run: `node --import tsx --test tests/project-rows.test.ts` — Expected: PASS
Run: `npm test` — Expected: PASS (overview-render.test.ts still green; if it asserted the old markup, update those assertions to the shared grammar).

- [ ] **Step 7: Commit**

```bash
git add src/dashboard/render/project-rows.ts src/dashboard/render/overview.ts src/dashboard/render/today.ts tests/project-rows.test.ts
git commit -m "fix: share project-row renderer between Overview and Today

Today still emitted the pre-grid mile/name/amt markup, so its children
auto-placed into wrong .project-row grid cells and text overlapped.
Both pages now render rows through render/project-rows.ts, with a
render-test tripwire so the grammar can't drift again."
```

---

### Task 2: TodayVM — hourly buckets, pace, usual-day average

**Files:**
- Modify: `src/dashboard/data/today.ts`
- Create: `tests/today-data.test.ts`

**Interfaces:**
- Consumes: `usage_events (timestamp, estimated_cost_usd)`, `feature_rollups (date, total_cost_usd)`.
- Produces: `TodayVM` gains `hourly: { hour: number; usd: number }[]` (always 24 entries, hours 0–23, zero-filled), `paceUsd: number | null`, `usualDayUsd: number`. `buildTodayVM(db, opts?: { nowHour?: number })` — `nowHour` (0–23) injectable for tests, defaults to `new Date().getHours()`.

- [ ] **Step 1: Write the failing tests**

Create `tests/today-data.test.ts`:

```ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type DatabaseType from 'better-sqlite3';
import { runMigrations } from '../src/db/migrations.js';
import { buildTodayVM } from '../src/dashboard/data/today.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof DatabaseType;

function makeDb(): DatabaseType.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

let eventSeq = 0;
/** ISO-UTC timestamp for local-today at local hour h (sqlite 'localtime' converts back). */
function todayAtLocalHour(h: number): string {
  const d = new Date();
  d.setHours(h, 30, 0, 0);
  return d.toISOString();
}
function daysAgoAtLocalHour(n: number, h: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(h, 30, 0, 0);
  return d.toISOString();
}
function seedEvent(
  db: DatabaseType.Database,
  { ts, usd, sessionId = 's1' }: { ts: string; usd: number; sessionId?: string }
): void {
  db.prepare(
    `INSERT INTO usage_events (id, session_id, timestamp, model, estimated_cost_usd)
     VALUES (?, ?, ?, 'claude-fable-5', ?)`
  ).run(`e${++eventSeq}`, sessionId, ts, usd);
}

describe('buildTodayVM hourly + pace', () => {
  test('hourly is 24 zero-filled buckets summing today's events', () => {
    const db = makeDb();
    seedEvent(db, { ts: todayAtLocalHour(9), usd: 3 });
    seedEvent(db, { ts: todayAtLocalHour(9), usd: 2 });
    seedEvent(db, { ts: todayAtLocalHour(14), usd: 4 });
    const vm = buildTodayVM(db, { nowHour: 15 });
    assert.equal(vm.hourly.length, 24);
    assert.equal(vm.hourly[9]!.usd, 5);
    assert.equal(vm.hourly[14]!.usd, 4);
    assert.equal(vm.hourly[0]!.usd, 0);
    assert.equal(vm.hourly[9]!.hour, 9);
  });

  test('pace is null with fewer than 7 days of history', () => {
    const db = makeDb();
    seedEvent(db, { ts: todayAtLocalHour(9), usd: 5 });
    for (let n = 1; n <= 3; n++) seedEvent(db, { ts: daysAgoAtLocalHour(n, 9), usd: 10 });
    const vm = buildTodayVM(db, { nowHour: 10 });
    assert.equal(vm.paceUsd, null);
  });

  test('pace divides today by the historical share spent by nowHour', () => {
    const db = makeDb();
    // 8 history days: each day $10 at 09:xx and $10 at 18:xx → by hour 9 the
    // historical share is 50%, so today's $5 paces to $10.
    for (let n = 1; n <= 8; n++) {
      seedEvent(db, { ts: daysAgoAtLocalHour(n, 9), usd: 10 });
      seedEvent(db, { ts: daysAgoAtLocalHour(n, 18), usd: 10 });
    }
    seedEvent(db, { ts: todayAtLocalHour(9), usd: 5 });
    const vm = buildTodayVM(db, { nowHour: 9 });
    assert.equal(vm.paceUsd, 10);
  });

  test('usualDayUsd averages the last 30 days of rollups', () => {
    const db = makeDb();
    const ins = db.prepare(
      `INSERT INTO feature_rollups (date, feature_key, feature_name, total_cost_usd, sessions_count)
       VALUES (?, 'f', 'F', ?, 1)`
    );
    const day = (n: number) => {
      const d = new Date();
      d.setDate(d.getDate() - n);
      return d.toLocaleDateString('sv-SE'); // YYYY-MM-DD, local
    };
    ins.run(day(1), 20);
    ins.run(day(2), 30);
    const vm = buildTodayVM(db, { nowHour: 12 });
    assert.equal(vm.usualDayUsd, 25);
  });
});
```

Note: if `feature_rollups` has different required columns, check `src/db/schema.ts` and match the existing `seedRollups` helper in `tests/dashboard-data.test.ts` instead of the insert above.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import tsx --test tests/today-data.test.ts`
Expected: FAIL — `hourly`/`paceUsd`/`usualDayUsd` undefined (and `buildTodayVM` rejects the second argument type).

- [ ] **Step 3: Implement in `data/today.ts`**

Extend the type and builder:

```ts
export type TodayVM = {
  todayUsd: number;
  yesterdayUsd: number;
  deltaPct: number;
  sessionsToday: number;
  topProjects: OverviewVM['topProjects'];
  anomalies: OverviewVM['anomalies'];
  hourly: { hour: number; usd: number }[];
  paceUsd: number | null;
  usualDayUsd: number;
};

const PACE_MIN_HISTORY_DAYS = 7;

export function buildTodayVM(
  db: DatabaseType.Database,
  opts: { nowHour?: number } = {}
): TodayVM {
  const nowHour = opts.nowHour ?? new Date().getHours();
  // ...existing overview/yesterday/sessions queries unchanged...

  // 24 zero-filled hourly buckets for today.
  const hourly: { hour: number; usd: number }[] = Array.from({ length: 24 }, (_, hour) => ({ hour, usd: 0 }));
  const hourRows = db
    .prepare(
      `SELECT CAST(strftime('%H', timestamp, 'localtime') AS INTEGER) AS hour,
              SUM(estimated_cost_usd) AS usd
         FROM usage_events
        WHERE date(timestamp, 'localtime') = date('now', 'localtime')
        GROUP BY hour`
    )
    .all() as { hour: number; usd: number }[];
  for (const r of hourRows) hourly[r.hour]!.usd = round2(r.usd);

  // Usual day: average daily rollup total over the last 30 completed days.
  const usualRow = db
    .prepare(
      `SELECT COALESCE(SUM(total_cost_usd), 0) AS total, COUNT(DISTINCT date) AS days
         FROM feature_rollups
        WHERE date >= date('now', '-30 day', 'localtime')
          AND date < date('now', 'localtime')`
    )
    .get() as { total: number; days: number };
  const usualDayUsd = usualRow.days > 0 ? round2(usualRow.total / usualRow.days) : 0;

  // Pace: today ÷ (historical share of a day's spend that lands by nowHour).
  const paceRow = db
    .prepare(
      `WITH hist AS (
         SELECT date(timestamp, 'localtime') AS d,
                CAST(strftime('%H', timestamp, 'localtime') AS INTEGER) AS h,
                SUM(estimated_cost_usd) AS usd
           FROM usage_events
          WHERE date(timestamp, 'localtime') >= date('now', '-30 day', 'localtime')
            AND date(timestamp, 'localtime') < date('now', 'localtime')
          GROUP BY d, h
       )
       SELECT COALESCE(SUM(CASE WHEN h <= ? THEN usd END), 0) AS byNow,
              COALESCE(SUM(usd), 0) AS total,
              COUNT(DISTINCT d) AS days
         FROM hist`
    )
    .get(nowHour) as { byNow: number; total: number; days: number };
  const share = paceRow.total > 0 ? paceRow.byNow / paceRow.total : 0;
  const paceUsd =
    paceRow.days >= PACE_MIN_HISTORY_DAYS && share > 0 ? round2(todayUsd / share) : null;

  return {
    // ...existing fields...
    hourly,
    paceUsd,
    usualDayUsd,
  };
}
```

- [ ] **Step 3b: Make Today's project colors match Overview's**

`buildOverview({ db, days: 1 })` assigns rank-based colors from *today's*
ranking, but Overview ranks over its default window — the same project can
end up a different color on the two pages, which the spec forbids. In
`buildTodayVM`, after building the day-1 overview, re-map colors from the
30-day ranking:

```ts
const colorRef = buildOverview({ db, days: 30 }).projectColors;
const topProjects = overview.topProjects
  .slice(0, TOP_PROJECTS_LIMIT)
  .map((p) => ({ ...p, color: colorRef[p.key] ?? p.color }));
```

Use this `topProjects` in the returned VM. Add a test to
`tests/today-data.test.ts`:

```ts
  test('project colors match the 30-day overview palette', () => {
    const db = makeDb();
    seedEvent(db, { ts: todayAtLocalHour(9), usd: 5 });
    const vm = buildTodayVM(db, { nowHour: 10 });
    const ref = buildOverview({ db, days: 30 }).projectColors;
    for (const p of vm.topProjects) {
      assert.equal(p.color, ref[p.key]);
    }
  });
```

(Import `buildOverview` from `../src/dashboard/data/overview.js` in the
test file. Note: `seedEvent` rows carry no `project_dir`; if `topProjects`
comes out empty for bare events, seed `project_dir` in `seedEvent` — add
it to the INSERT with a `'/Users/b/Projects/demo'` default — so bucketing
produces a project.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --import tsx --test tests/today-data.test.ts` — Expected: PASS
Run: `npm test` — Expected: PASS. Task 1's render test constructs a `TodayVM` literal — add the three new fields there (`hourly: [], paceUsd: null, usualDayUsd: 0` is fine for that test).

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/data/today.ts tests/today-data.test.ts tests/project-rows.test.ts
git commit -m "feat: hourly burn buckets, pace, and usual-day average in TodayVM"
```

---

### Task 3: TodayVM — sessions list

**Files:**
- Modify: `src/dashboard/data/today.ts`
- Modify: `tests/today-data.test.ts` (add a describe block)

**Interfaces:**
- Consumes: `usage_events`, `sessions (session_id, title, project_dir)`.
- Produces: `TodayVM.sessions: TodaySession[]` where

```ts
export type TodaySession = {
  sessionId: string;
  title: string;            // never empty: title → inferred_feature_name → project_dir basename → 'Untitled session'
  projectName: string;      // project_dir basename, '' if unknown
  featureKey: string | null;
  startedAt: string;        // 'HH:MM' local
  endedAt: string;          // 'HH:MM' local
  usd: number;
};
```

`sessionsToday` becomes `sessions.length` (delete the old rollup-count query).

- [ ] **Step 1: Write the failing tests**

Append to `tests/today-data.test.ts` (extend `seedEvent` to accept the extra columns):

```ts
function seedSession(
  db: DatabaseType.Database,
  { id, title = null, projectDir = null }: { id: string; title?: string | null; projectDir?: string | null }
): void {
  db.prepare(`INSERT INTO sessions (session_id, title, project_dir) VALUES (?, ?, ?)`).run(id, title, projectDir);
}

describe('buildTodayVM sessions', () => {
  test('aggregates per-session cost, time range, chronological order', () => {
    const db = makeDb();
    seedSession(db, { id: 'a', title: 'deep research', projectDir: '/Users/b/Research' });
    seedSession(db, { id: 'b', title: 'cover letter', projectDir: '/Users/b/Projects/job-search' });
    seedEvent(db, { ts: todayAtLocalHour(10), usd: 2, sessionId: 'b' });
    seedEvent(db, { ts: todayAtLocalHour(9), usd: 3, sessionId: 'a' });
    seedEvent(db, { ts: todayAtLocalHour(11), usd: 4, sessionId: 'a' });
    const vm = buildTodayVM(db, { nowHour: 12 });
    assert.equal(vm.sessions.length, 2);
    assert.equal(vm.sessionsToday, 2);
    assert.equal(vm.sessions[0]!.sessionId, 'a'); // earliest first event first
    assert.equal(vm.sessions[0]!.usd, 7);
    assert.equal(vm.sessions[0]!.projectName, 'Research');
    assert.match(vm.sessions[0]!.startedAt, /^09:\d\d$/);
    assert.match(vm.sessions[0]!.endedAt, /^11:\d\d$/);
  });

  test('title falls back: title → feature name → project dir basename → Untitled', () => {
    const db = makeDb();
    seedSession(db, { id: 'x', title: null, projectDir: null });
    seedEvent(db, { ts: todayAtLocalHour(9), usd: 1, sessionId: 'x' });
    const vm = buildTodayVM(db, { nowHour: 10 });
    assert.equal(vm.sessions[0]!.title, 'Untitled session');
  });

  test('sessions with no events today are excluded', () => {
    const db = makeDb();
    seedSession(db, { id: 'old' });
    seedEvent(db, { ts: daysAgoAtLocalHour(2, 9), usd: 9, sessionId: 'old' });
    const vm = buildTodayVM(db, { nowHour: 10 });
    assert.equal(vm.sessions.length, 0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --import tsx --test tests/today-data.test.ts`
Expected: FAIL — `vm.sessions` undefined.

- [ ] **Step 3: Implement**

In `data/today.ts`:

```ts
const sessionRows = db
  .prepare(
    `SELECT ue.session_id AS sessionId,
            MIN(ue.timestamp) AS startTs,
            MAX(ue.timestamp) AS endTs,
            SUM(ue.estimated_cost_usd) AS usd,
            MAX(s.title) AS title,
            COALESCE(MAX(s.project_dir), MAX(ue.project_dir)) AS projectDir,
            MAX(ue.inferred_feature_name) AS featureName,
            MAX(COALESCE(s.feature_override, ue.inferred_feature_key)) AS featureKey
       FROM usage_events ue
       LEFT JOIN sessions s ON s.session_id = ue.session_id
      WHERE date(ue.timestamp, 'localtime') = date('now', 'localtime')
      GROUP BY ue.session_id
      ORDER BY MIN(ue.timestamp) ASC`
  )
  .all() as Array<{
    sessionId: string; startTs: string; endTs: string; usd: number;
    title: string | null; projectDir: string | null;
    featureName: string | null; featureKey: string | null;
  }>;

const sessions: TodaySession[] = sessionRows.map((r) => {
  const projectName = r.projectDir ? (r.projectDir.split('/').pop() ?? '') : '';
  return {
    sessionId: r.sessionId,
    title: r.title?.trim() || r.featureName?.trim() || projectName || 'Untitled session',
    projectName,
    featureKey: r.featureKey,
    startedAt: localHHMM(r.startTs),
    endedAt: localHHMM(r.endTs),
    usd: round2(r.usd),
  };
});

function localHHMM(ts: string): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
```

Set `sessionsToday: sessions.length` in the returned VM and delete the old `sessionsRow` rollup query. If `sessions.feature_override` doesn't exist in the schema, drop it from the COALESCE — check `src/db/schema.ts` first (it exists in the live DB).

- [ ] **Step 4: Run tests**

Run: `npm test` — Expected: PASS (the empty-state test in project-rows.test.ts needs `sessions: []` added to its VM literal).

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/data/today.ts tests/today-data.test.ts tests/project-rows.test.ts
git commit -m "feat: per-session list in TodayVM; session count derives from it"
```

---

### Task 4: TodayVM — shipped today

**Files:**
- Modify: `src/dashboard/data/today.ts`
- Modify: `tests/today-data.test.ts`

**Interfaces:**
- Consumes: `session_commits (session_id, commit_sha, subject, authored_at)`, `session_prs (session_id, repo, pr_number, pr_title, pr_state, merged_at)`.
- Produces: `TodayVM.shipped: { prCount: number; commitCount: number; items: ShippedItem[] }` where

```ts
export type ShippedItem = { kind: 'pr' | 'commit'; title: string; state?: string; at: string };
```

`items` = PRs first, then commits, each newest-first, capped at 5 total.

- [ ] **Step 1: Write the failing tests**

Append to `tests/today-data.test.ts`:

```ts
describe('buildTodayVM shipped', () => {
  function seedCommit(db: DatabaseType.Database, sessionId: string, sha: string, subject: string, at: string) {
    db.prepare(
      `INSERT INTO session_commits (session_id, commit_sha, subject, authored_at) VALUES (?, ?, ?, ?)`
    ).run(sessionId, sha, subject, at);
  }
  function seedPr(
    db: DatabaseType.Database, sessionId: string, n: number,
    { state = 'open', mergedAt = null }: { state?: string; mergedAt?: string | null } = {}
  ) {
    db.prepare(
      `INSERT INTO session_prs (session_id, repo, pr_number, pr_title, pr_state, merged_at)
       VALUES (?, 'o/r', ?, ?, ?, ?)`
    ).run(sessionId, n, `PR ${n}`, state, mergedAt);
  }

  test('counts today-authored commits and today-merged or open PRs on today-active sessions', () => {
    const db = makeDb();
    seedSession(db, { id: 's1' });
    seedEvent(db, { ts: todayAtLocalHour(9), usd: 1, sessionId: 's1' });
    seedCommit(db, 's1', 'sha1', 'fix: today page', todayAtLocalHour(10));
    seedCommit(db, 's1', 'sha2', 'old work', daysAgoAtLocalHour(3, 10)); // resumed-session rider: excluded
    seedPr(db, 's1', 12, { state: 'merged', mergedAt: todayAtLocalHour(11) });
    seedPr(db, 's1', 13, { state: 'open' });
    const vm = buildTodayVM(db, { nowHour: 12 });
    assert.equal(vm.shipped.commitCount, 1);
    assert.equal(vm.shipped.prCount, 2);
    assert.equal(vm.shipped.items[0]!.kind, 'pr');
    assert.ok(vm.shipped.items.some((i) => i.title === 'fix: today page'));
  });

  test('same commit attached to two sessions counts once', () => {
    const db = makeDb();
    seedSession(db, { id: 's1' });
    seedSession(db, { id: 's2' });
    seedEvent(db, { ts: todayAtLocalHour(9), usd: 1, sessionId: 's1' });
    seedEvent(db, { ts: todayAtLocalHour(10), usd: 1, sessionId: 's2' });
    seedCommit(db, 's1', 'shaX', 'shared commit', todayAtLocalHour(9));
    seedCommit(db, 's2', 'shaX', 'shared commit', todayAtLocalHour(9));
    const vm = buildTodayVM(db, { nowHour: 12 });
    assert.equal(vm.shipped.commitCount, 1);
  });

  test('empty when nothing shipped', () => {
    const db = makeDb();
    seedSession(db, { id: 's1' });
    seedEvent(db, { ts: todayAtLocalHour(9), usd: 1, sessionId: 's1' });
    const vm = buildTodayVM(db, { nowHour: 10 });
    assert.equal(vm.shipped.prCount, 0);
    assert.equal(vm.shipped.commitCount, 0);
    assert.equal(vm.shipped.items.length, 0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --import tsx --test tests/today-data.test.ts`
Expected: FAIL — `vm.shipped` undefined.

- [ ] **Step 3: Implement**

In `data/today.ts` (uses a CTE for today's session ids; dedupe in SQL):

```ts
const commitRows = db
  .prepare(
    `WITH today_sessions AS (
       SELECT DISTINCT session_id FROM usage_events
        WHERE date(timestamp, 'localtime') = date('now', 'localtime')
     )
     SELECT sc.commit_sha AS sha, MAX(sc.subject) AS subject, MAX(sc.authored_at) AS at
       FROM session_commits sc
       JOIN today_sessions ts ON ts.session_id = sc.session_id
      WHERE date(sc.authored_at, 'localtime') = date('now', 'localtime')
      GROUP BY sc.commit_sha
      ORDER BY at DESC`
  )
  .all() as { sha: string; subject: string | null; at: string }[];

const prRows = db
  .prepare(
    `WITH today_sessions AS (
       SELECT DISTINCT session_id FROM usage_events
        WHERE date(timestamp, 'localtime') = date('now', 'localtime')
     )
     SELECT sp.repo AS repo, sp.pr_number AS n, MAX(sp.pr_title) AS title,
            MAX(sp.pr_state) AS state, MAX(sp.merged_at) AS mergedAt
       FROM session_prs sp
       JOIN today_sessions ts ON ts.session_id = sp.session_id
      WHERE date(sp.merged_at, 'localtime') = date('now', 'localtime')
         OR sp.pr_state = 'open'
      GROUP BY sp.repo, sp.pr_number
      ORDER BY COALESCE(mergedAt, '9999') DESC`
  )
  .all() as { repo: string; n: number; title: string | null; state: string | null; mergedAt: string | null }[];

const shipped = {
  prCount: prRows.length,
  commitCount: commitRows.length,
  items: [
    ...prRows.map((p) => ({
      kind: 'pr' as const,
      title: p.title ?? `PR #${p.n}`,
      state: p.state ?? undefined,
      at: p.mergedAt ?? '',
    })),
    ...commitRows.map((c) => ({ kind: 'commit' as const, title: c.subject ?? c.sha.slice(0, 8), at: c.at })),
  ].slice(0, 5),
};
```

- [ ] **Step 4: Run tests**

Run: `npm test` — Expected: PASS (add `shipped: { prCount: 0, commitCount: 0, items: [] }` to the VM literal in project-rows.test.ts).

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/data/today.ts tests/today-data.test.ts tests/project-rows.test.ts
git commit -m "feat: shipped-today counts and items in TodayVM"
```

---

### Task 5: Render the new page — strip, sessions card, shipped card, CSS

**Files:**
- Modify: `src/dashboard/render/today.ts`
- Modify: `src/dashboard/static/dashboard.css` (append a `/* --- Today page --- */` block)
- Modify: `tests/project-rows.test.ts` (extend the renderToday test)

**Interfaces:**
- Consumes: full `TodayVM` from Tasks 2–4.
- Produces: final page markup. New CSS classes: `.strip`, `.strip-head`, `.strip-stat`, `.hour-bars`, `.hour-bar`, `.hour-labels`, `.session-row`, `.session-time`, `.session-title`, `.session-amt`, `.pr-row`.

- [ ] **Step 1: Extend the render test (failing first)**

In `tests/project-rows.test.ts`, extend the Today describe block (grow the VM literal with realistic data):

```ts
  test('renders strip, sessions, and shipped modules', () => {
    const vm: TodayVM = {
      todayUsd: 28, yesterdayUsd: 25, deltaPct: 13, sessionsToday: 2,
      topProjects: [item], anomalies: [],
      hourly: Array.from({ length: 24 }, (_, hour) => ({ hour, usd: hour === 9 ? 5 : 0 })),
      paceUsd: 41, usualDayUsd: 23,
      sessions: [{
        sessionId: 's1', title: 'deep research', projectName: 'Research',
        featureKey: 'research', startedAt: '09:02', endedAt: '10:14', usd: 11,
      }, {
        sessionId: 's2', title: 'no feature', projectName: 'misc',
        featureKey: null, startedAt: '11:00', endedAt: '11:30', usd: 2,
      }],
      shipped: {
        prCount: 1, commitCount: 2,
        items: [
          { kind: 'pr', title: 'Today page redesign', state: 'merged', at: '' },
          { kind: 'commit', title: 'fix: today page markup', at: '' },
        ],
      },
    };
    const html = renderToday(vm);
    assert.match(html, /class="strip/);
    assert.match(html, /Burn by hour/i);
    assert.match(html, /pace ~\$41/);
    assert.match(html, /usual day \$23/);
    assert.match(html, /Sessions today · 2/);
    assert.match(html, /09:02–10:14/);
    assert.match(html, /href="\/feature\/research"/);       // attributed → link
    assert.doesNotMatch(html, /href="[^"]*"[^>]*>no feature/); // unattributed → no link
    assert.match(html, /1 PR · 2 commits/);
    assert.match(html, /Today page redesign/);
  });

  test('pace omitted when null', () => {
    const vm: TodayVM = {
      todayUsd: 28, yesterdayUsd: 25, deltaPct: 13, sessionsToday: 0,
      topProjects: [item], anomalies: [],
      hourly: Array.from({ length: 24 }, (_, hour) => ({ hour, usd: 0 })),
      paceUsd: null, usualDayUsd: 23,
      sessions: [],
      shipped: { prCount: 0, commitCount: 0, items: [] },
    };
    const html = renderToday(vm);
    assert.doesNotMatch(html, /pace ~/);
    assert.match(html, /usual day \$23/);
  });
```

Run: `node --import tsx --test tests/project-rows.test.ts` — Expected: FAIL.

- [ ] **Step 2: Rewrite `renderToday`**

Replace the body of `renderToday` in `src/dashboard/render/today.ts`:

```ts
export function renderToday(vm: TodayVM): string {
  if (isEmpty(vm)) return renderEmptyState();
  return `
${renderStrip(vm)}
<div class="layout">
  <section class="main-col">
    <div class="card">
      <div class="label">Today's burn paths</div>
      ${renderProjectRows(vm.topProjects, { staticFill: true, emptyMessage: 'No project activity today.' })}
    </div>

    <div class="card">
      <div class="label">Sessions today · ${vm.sessions.length}</div>
      ${renderSessions(vm.sessions)}
    </div>
  </section>

  <aside class="side-col">
    <div class="card hero-card">
      <div class="label">Today</div>
      <div class="hero">$${vm.todayUsd.toFixed(0)}</div>
      <div class="delta ${vm.deltaPct >= 0 ? 'up' : 'down'}">${vm.deltaPct >= 0 ? '▲' : '▼'} ${Math.abs(vm.deltaPct)}% vs yesterday</div>
      <div class="muted">Yesterday: $${vm.yesterdayUsd.toFixed(0)}</div>
    </div>

    <div class="card">
      <div class="label">Shipped today</div>
      ${renderShipped(vm.shipped)}
    </div>

    <div class="card">
      <div class="label">Worth a look</div>
      ${vm.anomalies.length === 0 ? '<div class="muted">No anomalies today.</div>' : renderAnomalies(vm.anomalies)}
      ${vm.anomalies.length > 0 ? '<div class="footer-link"><a href="/worth-a-look">See all →</a></div>' : ''}
    </div>
  </aside>
</div>
  `;
}

function renderStrip(vm: TodayVM): string {
  const max = Math.max(...vm.hourly.map((h) => h.usd), 0.01);
  const bars = vm.hourly
    .map(
      (h) =>
        `<div class="hour-bar" title="${String(h.hour).padStart(2, '0')}:00 — $${h.usd.toFixed(2)}"><span style="height:${Math.round((h.usd / max) * 100)}%"></span></div>`
    )
    .join('');
  const pace = vm.paceUsd !== null ? ` · pace ~$${vm.paceUsd.toFixed(0)}` : '';
  const usual = vm.usualDayUsd > 0 ? ` · usual day $${vm.usualDayUsd.toFixed(0)}` : '';
  return `
<div class="card strip">
  <div class="strip-head">
    <span class="label">Burn by hour</span>
    <span class="strip-stat">$${vm.todayUsd.toFixed(0)} so far${pace}${usual}</span>
  </div>
  <div class="hour-bars">${bars}</div>
  <div class="hour-labels"><span>12a</span><span>3a</span><span>6a</span><span>9a</span><span>12p</span><span>3p</span><span>6p</span><span>9p</span></div>
</div>`;
}

function renderSessions(items: TodayVM['sessions']): string {
  if (items.length === 0) return '<div class="muted">No sessions yet today.</div>';
  return items
    .map((s) => {
      const title = s.featureKey
        ? `<a href="/feature/${encodeURIComponent(s.featureKey)}">${escapeHtml(s.title)}</a>`
        : escapeHtml(s.title);
      return `<div class="session-row">
        <span class="session-time">${s.startedAt}–${s.endedAt}</span>
        <span class="session-title">${title} <span class="muted">· ${escapeHtml(s.projectName)}</span></span>
        <span class="session-amt">$${s.usd.toFixed(s.usd < 1 ? 2 : 0)}</span>
      </div>`;
    })
    .join('');
}

function renderShipped(shipped: TodayVM['shipped']): string {
  if (shipped.prCount === 0 && shipped.commitCount === 0) {
    return '<div class="muted">Nothing shipped yet — the trail\'s still being walked.</div>';
  }
  const head = `<div class="kicker">${shipped.prCount} PR${shipped.prCount === 1 ? '' : 's'} · ${shipped.commitCount} commit${shipped.commitCount === 1 ? '' : 's'}</div>`;
  const rows = shipped.items
    .map((i) =>
      i.kind === 'pr'
        ? `<div class="pr-row"><span class="muted">${escapeHtml(i.state ?? 'pr')}</span> <span class="subject">${escapeHtml(i.title)}</span></div>`
        : `<div class="commit-row"><span class="subject">${escapeHtml(i.title)}</span></div>`
    )
    .join('');
  return head + rows;
}
```

`isEmpty` gains nothing — an all-zero day still short-circuits to the empty state before the new modules matter.

- [ ] **Step 3: Append CSS**

Append to `src/dashboard/static/dashboard.css`:

```css
/* --- Today page: burn-by-hour strip + sessions + shipped ------------------ */
.strip { margin-bottom: var(--space-m); }
.strip-head { display: flex; justify-content: space-between; align-items: baseline; }
.strip-stat {
  font-family: var(--font-serif);
  font-size: var(--size-small);
  color: var(--color-ink-muted);
  font-variant-numeric: tabular-nums;
}
.hour-bars {
  display: grid;
  grid-template-columns: repeat(24, 1fr);
  gap: 3px;
  height: 56px;
  align-items: end;
  margin-top: var(--space-s);
}
.hour-bar { height: 100%; display: flex; align-items: flex-end; background: rgba(139,111,71,0.06); border-radius: 2px; }
.hour-bar span {
  display: block;
  width: 100%;
  background: var(--color-accent-bar);
  border-radius: 2px 2px 0 0;
  opacity: 0.75;
  min-height: 0;
}
.hour-labels {
  display: grid;
  grid-template-columns: repeat(8, 1fr);
  margin-top: 4px;
  font-size: var(--size-small);
  color: var(--color-ink-subtle);
  font-variant-numeric: tabular-nums;
}
.session-row {
  display: grid;
  grid-template-columns: auto 1fr auto;
  gap: var(--space-s);
  align-items: baseline;
  padding: 5px 0;
  font-size: var(--size-small);
  border-bottom: 1px dashed rgba(139,111,71,0.12);
}
.session-row:last-child { border-bottom: none; }
.session-time { color: var(--color-ink-muted); font-variant-numeric: tabular-nums; }
.session-title { font-family: var(--font-serif); }
.session-amt { font-variant-numeric: tabular-nums; font-weight: 600; text-align: right; }
.pr-row { font-size: var(--size-small); padding: 3px 0; }
.pr-row .subject { color: var(--color-ink); }
```

(`.commit-row` already exists — shipped commit rows reuse it.)

- [ ] **Step 4: Run tests**

Run: `npm test` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/render/today.ts src/dashboard/static/dashboard.css tests/project-rows.test.ts
git commit -m "feat: timeline-first Today page — burn-by-hour strip, sessions, shipped"
```

---

### Task 6: Live verification against the real database

**Files:** none (verification only)

- [ ] **Step 1: Type-check and full suite**

Run: `npx tsc --noEmit` — Expected: clean.
Run: `npm test` — Expected: all PASS.

- [ ] **Step 2: Serve and inspect the real page**

Run: `pnpm dev` (dashboard serves on its usual port — check startup log), then:

```bash
curl -s http://127.0.0.1:PORT/today | grep -c "name-col"     # ≥ 1 → repaired rows
curl -s http://127.0.0.1:PORT/today | grep -o "Burn by hour" # strip present
curl -s http://127.0.0.1:PORT/today | grep -o "Sessions today · [0-9]*"
```

Then load `http://127.0.0.1:PORT/today` in a browser: no overlapping text, hourly bars visible with today's real burn, sessions listed chronologically, shipped card populated (or its empty-state line), colors matching Overview's for the same projects.

- [ ] **Step 3: Check the empty state still works**

Run against a throwaway empty DB (`TOKENTRAIL_DB=/tmp/empty.db pnpm dev` or the project's equivalent env var — check `src/index.ts` for the DB-path option): `/today` shows "No trail today yet".

- [ ] **Step 4: Final commit if anything was touched**

```bash
git status --short   # expect clean; commit any stragglers with a chore: message
```
