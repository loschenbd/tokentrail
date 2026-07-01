# Project-First Overview Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Invert the overview's primary framing from feature-driven to project-driven — trend chart bands become projects, feature detail moves into hover/inline sub-bars, and a new sidebar card surfaces unattributed work with a CTA to run the labeling tool.

**Architecture:** Extend the existing `feature-colors` module with a `colorForProject` twin using the same palette. Rewrite `buildOverview` to emit a project-centric payload: `projects[]` bands for the stacked area, per-day `featureBands` for the hover bottom block, per-project `projectFeatureMix` for burn-paths sub-bars, and a single `unattributed` object for the new sidebar card (or `null` when zero). The client-side `dashboard.js` swaps the stacked-area's decomposition key, extends the tooltip with a per-project feature detail block that renders feature rows as clickable `<a href="/feature/<key>">`, draws inline feature sub-bars beneath each burn-paths row, and mounts a small unattributed card with a lightweight SVG sparkline + a `navigator.clipboard.writeText` CTA.

**Tech Stack:** TypeScript, Node.js (>= 20), better-sqlite3, uPlot (already vendored at `src/dashboard/static/uPlot.iife.min.js`), `node:test` for unit/integration tests, pnpm for running scripts.

## Global Constraints

- **Primary framing:** project-first. Feature detail is a drill-down concern (hover tooltips, inline sub-bars, existing `/feature/<key>` pages).
- **Trend chart bands:** top **6** projects by 30d $ + `Other` (rank 7+). No striped band on the trend chart. `uncategorized-mainline` dissolves into each project's total.
- **Trend chart stack order (bottom → top):** largest real project at bottom → 6th-largest → `Other` at top.
- **Colors:** Okabe-Ito 8-color palette shared across features and projects: `['#0072B2','#E69F00','#009E73','#CC79A7','#56B4E9','#D55E00','#F0E442','#000000']`. `colorForProject(key)` and `colorFor(featureKey)` are independent Murmur3-finalizer hash keyspaces so a same-slug project and feature may collide-differently (desired).
- **`Other` band color:** `#9CA3AF`. Non-clickable.
- **Legend placement / order:** vertical right of chart. Rows mirror the stack top-to-bottom via single-tier sort by descending `stackPosition` — `Other` at top; real projects with the highest `stackPosition` (smallest $) next; largest real project at the bottom.
- **Trend chart click-through:** click a real-project band or its legend row → navigate to `/project/<key>`. `Other` is not clickable.
- **Trend tooltip (two blocks):**
  - **Top block:** per-project totals for the day, sorted by $ desc.
  - **Bottom block (only when a band is active):** header `Inside <project-name>:`, up to 3 feature rows sorted $ desc with feature swatches (`colorFor(featureKey)`), each rendered as `<a href="/feature/<key>">`. Unattributed appears as one non-clickable `unattributed` row. `+ N more` when truncated.
- **Tooltip must stay interactive:** the chart-cursor mouseleave guard must extend so the tooltip does not dismiss while the cursor is inside the tooltip DOM.
- **Burn paths rows:** each row = rank · project swatch (project color from `colorForProject`) · name · $total+% · main bar (existing % of grand total) · new inline feature sub-bar (~8px, feature-color segments summing to 100% of THIS project's total). Unattributed portion inside a project renders as a striped segment. Segments sorted $ desc.
- **Project swatches on burn paths:** switch from *dominant-feature color* to *project color*. Visible change on the current view.
- **Unattributed card (new):**
  - Placement: sidebar, between "This week" and "Worth a look".
  - Content: big number `$X unattributed · N% of trail`, then 30d SVG sparkline, then up to 3 top projects by unattributed $ each with `unattributed / project total` progress bar, then CTA button `Run tokentrail infer-mainline →`.
  - CTA copies literal string `tokentrail infer-mainline` to clipboard via `navigator.clipboard.writeText`; on success, label flips to `Copied ✓` for 1500ms.
  - Hidden entirely (card not rendered) when `unattributed.totalUsd === 0`.
- **Empty state (whole page):** `renderEmptyState()` shell unchanged.
- **DB / schema:** no changes. Read `feature_rollups`.
- **YAGNI list (do NOT build):** view-toggle between project-first and feature-first, per-user palette overrides, custom pinning, animations/transitions on bands, drag-to-zoom on any chart, server-side execution of `infer-mainline`, historical unattributed reduction metrics.
- **Spec source of truth:** `docs/superpowers/specs/2026-07-01-project-first-overview-design.md`.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/dashboard/lib/feature-colors.ts` | MODIFY | Add `colorForProject(projectKey)` next to existing `colorFor(featureKey)`; share palette + hash finalizer. |
| `tests/feature-colors.test.ts` | MODIFY | Add 3 assertions for `colorForProject`. |
| `src/dashboard/data/overview.ts` | MODIFY | Rewrite `buildOverview` payload: `projects[]`, `days[].bands` keyed by project, `days[].featureBands`, `days[].unattributedTotal`, `projectFeatureMix[]`, `unattributed` block. |
| `tests/dashboard-data.test.ts` | MODIFY | Replace feature-first payload assertions with project-first shape; add `unattributed` and `projectFeatureMix` tests. |
| `src/dashboard/render/overview.ts` | MODIFY | Emit new JSON payload; render chart shell + project legend; add burn-paths markup with sub-bar container; add unattributed card DOM when payload non-null; use `colorForProject` for burn-paths swatch. |
| `tests/overview-render.test.ts` | MODIFY | Assertions on new markup: legend uses `data-project-key`, burn-paths sub-bar containers exist, unattributed card visibility toggle. |
| `src/dashboard/static/dashboard.js` | MODIFY | `renderTrend()` rewrite (project-first bands + two-block tooltip + click-through); new `renderBurnPathsSubBars()`; new `renderUnattributedCard()` incl. SVG sparkline draw + clipboard CTA handler; mouseleave guard extended to tolerate cursor inside tooltip. |
| `src/dashboard/static/dashboard.css` | MODIFY | Feature sub-bar styles (`.subbar`, `.subbar-segment`, `.subbar-segment--striped`), unattributed card styles (`.unatt-card`, `.unatt-hero`, `.unatt-sparkline`, `.unatt-projects`, `.unatt-cta`), tooltip anchor tolerance for pointer-events. |

No new files. All changes are additive/modifying existing modules to keep the diff reviewable.

---

## Task 1: Extend `feature-colors.ts` with `colorForProject`

**Files:**
- Modify: `src/dashboard/lib/feature-colors.ts` — add `colorForProject` export sharing `PALETTE` and hash finalizer with existing `colorFor`.
- Modify: `tests/feature-colors.test.ts` — add 3 assertions.

**Interfaces:**
- Consumes: existing `PALETTE`, `colorFor` (unchanged).
- Produces: `export function colorForProject(projectKey: string): string` — returns a hex from `PALETTE`; deterministic per key; independent keyspace from `colorFor`.

- [ ] **Step 1: Add the three failing tests**

Open `tests/feature-colors.test.ts` and append:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { colorFor, colorForProject, PALETTE } from '../src/dashboard/lib/feature-colors.js';

test('colorForProject is deterministic', () => {
  const a = colorForProject('archi');
  const b = colorForProject('archi');
  assert.equal(a, b);
});

test('colorForProject returns a value from PALETTE', () => {
  const c = colorForProject('tokentrail');
  assert.ok(PALETTE.includes(c), `expected ${c} to be in PALETTE`);
});

test('colorForProject and colorFor have independent keyspaces', () => {
  // Not strictly guaranteed by contract (they COULD collide for a specific
  // slug), but for a broad sample the two mappings should differ often.
  const keys = ['a','b','c','d','e','f','archi','tokentrail','malslp'];
  const featurePicks = keys.map(colorFor);
  const projectPicks = keys.map(colorForProject);
  // At least one slug picks a different colour under the two functions.
  const diffs = keys.filter((_, i) => featurePicks[i] !== projectPicks[i]);
  assert.ok(diffs.length > 0, 'expected at least one key to differ');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import tsx --test tests/feature-colors.test.ts`
Expected: FAIL — `colorForProject` is not an exported member.

- [ ] **Step 3: Implement `colorForProject`**

Open `src/dashboard/lib/feature-colors.ts`. Extract the existing hash into a private helper if convenient, then add:

```ts
function hashProject(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  // Same finalizer as colorFor to preserve distribution quality.
  h = Math.imul(h ^ (h >>> 15), 0x9E3779B1);
  // XOR with a non-zero constant so a same-slug project and feature don't
  // necessarily land on the same colour. Independent keyspace, per spec.
  return Math.abs((h ^ 0xC0FFEE) >>> 0);
}

export function colorForProject(projectKey: string): string {
  return PALETTE[hashProject(projectKey) % PALETTE.length]!;
}
```

Do NOT alter `colorFor`, `PALETTE`, or any of the existing sentinel exports. Do NOT collapse the two hash functions into one — the whole point is independent keyspaces via the XOR constant.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --import tsx --test tests/feature-colors.test.ts`
Expected: all 3 new tests pass; existing 7 still pass; total 10 pass.

- [ ] **Step 5: Run full test + build**

Run: `pnpm test 2>&1 | tail -5 && pnpm build 2>&1 | tail -3`
Expected: full suite green (baseline + 3 new = existing baseline + 3), `pnpm build` exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/dashboard/lib/feature-colors.ts tests/feature-colors.test.ts
git commit -m "feat(dashboard): add colorForProject with independent hash keyspace"
```

---

## Task 2: Rewrite `overview.ts` payload — project-first bands + featureBands + unattributed

**Files:**
- Modify: `src/dashboard/data/overview.ts` — replace feature-centric payload with project-centric shape from the spec.
- Modify: `tests/dashboard-data.test.ts` — replace and extend tests for the new payload.

**Interfaces:**
- Consumes: `colorForProject`, `colorFor`, `OTHER_KEY`, `OTHER_NAME`, `OTHER_COLOR`, `STRIPED_SENTINEL` from Task 1's module.
- Produces: `OverviewVM` type with the following fields (existing fields kept; feature-first fields removed):

```ts
export interface OverviewVM {
  windowDays: number;
  totalUsd: number;
  weekUsd: number;
  weekSessions: number;
  deltaPct: number;

  // NEW: project-first bands for the trend chart.
  projects: Array<{
    key: string;
    name: string;
    color: string;
    totalUsd: number;
    clickable: boolean;
    stackPosition: number;   // 0 = bottom (largest real project), higher = higher; Other = 6
  }>;

  // MODIFIED: bands now keyed by project; featureBands nested per project;
  // unattributedTotal aggregated across all projects for that day.
  days: Array<{
    date: string;                                    // YYYY-MM-DD
    total: number;
    bands: Record<string, number>;                   // projectKey -> $ for this day
    featureBands: Record<string, Record<string, number>>; // projectKey -> featureKey (or "__unattributed__") -> $
    unattributedTotal: number;
    commits: number;
    prs: number;
  }>;

  // NEW: per-project feature mix for burn-paths sub-bars (window totals).
  projectFeatureMix: Array<{
    projectKey: string;
    features: Array<{
      key: string;          // featureKey or "__unattributed__"
      name: string;
      color: string;        // colorFor(key) or STRIPED_SENTINEL
      totalUsd: number;
    }>;
  }>;

  // NEW: null when no unattributed spend in the window.
  unattributed: {
    totalUsd: number;
    pctOfTrail: number;      // 0..100
    sparkline: Array<{ date: string; usd: number }>; // exactly windowDays items
    topProjects: Array<{
      key: string;
      name: string;
      color: string;         // colorForProject
      unattributedUsd: number;
      projectTotalUsd: number;
    }>;                       // up to 3, sorted desc
  } | null;

  // EXISTING (unchanged):
  topProjects: Array<{ key: string; name: string; totalUsd: number; pct: number; featureCount: number; sessionCount: number }>;
  anomalies: unknown[];
  recentCommits: unknown[];
}
```

The reserved feature key `__unattributed__` inside `featureBands` and `projectFeatureMix.features` denotes the unattributed-mainline portion of a project. When rendered, its color is `STRIPED_SENTINEL`.

- [ ] **Step 1: Update the empty-VM helper in tests**

Open `tests/overview-render.test.ts` and change its `emptyVM()` helper so the object literal matches the new shape. Replace whatever `features: []`, `days: []` you find with:

```ts
projects: [],
days: [],
projectFeatureMix: [],
unattributed: null,
```

Leave every other field of `emptyVM()` untouched — this edit only exists so the render tests still compile. The render assertions themselves are Task 4's problem.

- [ ] **Step 2: Write the failing data tests**

Open `tests/dashboard-data.test.ts`. Retain the existing `seedRollups`, `daysAgo` helpers (they already return real `YYYY-MM-DD`). Replace the previous chart-redesign era assertions (`features` array of feature-keys, `days[].bands` keyed by feature) with the new project-first assertions. Append/replace tests as follows — each is copy-pasteable:

```ts
test('projects[]: top 6 by 30d $ plus Other; correct stack positions', () => {
  const db = openInMemoryDb();
  // Seven distinct projects, decreasing spend.
  seedRollups(db, [
    { date: daysAgo(2), projectKey: 'p1', usd: 700 },
    { date: daysAgo(2), projectKey: 'p2', usd: 600 },
    { date: daysAgo(2), projectKey: 'p3', usd: 500 },
    { date: daysAgo(2), projectKey: 'p4', usd: 400 },
    { date: daysAgo(2), projectKey: 'p5', usd: 300 },
    { date: daysAgo(2), projectKey: 'p6', usd: 200 },
    { date: daysAgo(2), projectKey: 'p7', usd: 100 },
  ]);
  const vm = buildOverview({ db, days: 30 });
  const keys = vm.projects.map((p) => p.key);
  assert.deepEqual(keys.slice(0, 6), ['p1','p2','p3','p4','p5','p6']);
  assert.equal(vm.projects[6]!.key, '__other__');
  // Stack: 0 = bottom (largest), Other = 6 (top).
  assert.equal(vm.projects[0]!.stackPosition, 0);
  assert.equal(vm.projects[6]!.stackPosition, 6);
  assert.equal(vm.projects[6]!.clickable, false);
  assert.ok(vm.projects.slice(0, 6).every((p) => p.clickable));
});

test('projects[] omits Other when <=6 projects total', () => {
  const db = openInMemoryDb();
  seedRollups(db, [
    { date: daysAgo(1), projectKey: 'p1', usd: 100 },
    { date: daysAgo(1), projectKey: 'p2', usd: 80 },
  ]);
  const vm = buildOverview({ db, days: 30 });
  assert.equal(vm.projects.length, 2);
  assert.ok(!vm.projects.some((p) => p.key === '__other__'));
});

test('days[].bands keyed by project; sums to day total', () => {
  const db = openInMemoryDb();
  seedRollups(db, [
    { date: daysAgo(1), projectKey: 'archi', featureKey: 'rag', usd: 40 },
    { date: daysAgo(1), projectKey: 'archi', featureKey: 'onboarding', usd: 10 },
    { date: daysAgo(1), projectKey: 'tokentrail', featureKey: 'dashboard', usd: 50 },
  ]);
  const vm = buildOverview({ db, days: 30 });
  const row = vm.days.find((d) => d.date === daysAgo(1))!;
  assert.equal(row.total, 100);
  assert.equal(row.bands['archi'], 50);
  assert.equal(row.bands['tokentrail'], 50);
  const sum = Object.values(row.bands).reduce((a, b) => a + b, 0);
  assert.equal(sum, row.total);
});

test('days[].featureBands nested per project; unattributed uses __unattributed__ key', () => {
  const db = openInMemoryDb();
  seedRollups(db, [
    { date: daysAgo(1), projectKey: 'archi', featureKey: 'rag', usd: 30 },
    { date: daysAgo(1), projectKey: 'archi', featureKey: 'uncategorized-mainline', usd: 20 },
  ]);
  const vm = buildOverview({ db, days: 30 });
  const row = vm.days.find((d) => d.date === daysAgo(1))!;
  assert.equal(row.featureBands['archi']?.['rag'], 30);
  assert.equal(row.featureBands['archi']?.['__unattributed__'], 20);
  assert.equal(row.unattributedTotal, 20);
});

test('projectFeatureMix: per-project features sorted $ desc; window totals', () => {
  const db = openInMemoryDb();
  seedRollups(db, [
    { date: daysAgo(3), projectKey: 'archi', featureKey: 'rag',        usd: 100 },
    { date: daysAgo(3), projectKey: 'archi', featureKey: 'onboarding', usd:  50 },
    { date: daysAgo(3), projectKey: 'archi', featureKey: 'uncategorized-mainline', usd: 75 },
  ]);
  const vm = buildOverview({ db, days: 30 });
  const mix = vm.projectFeatureMix.find((m) => m.projectKey === 'archi')!;
  const keys = mix.features.map((f) => f.key);
  assert.deepEqual(keys, ['rag', '__unattributed__', 'onboarding']);
  assert.equal(mix.features[1]!.color, '__striped__');
});

test('unattributed: null when zero unattributed in window', () => {
  const db = openInMemoryDb();
  seedRollups(db, [
    { date: daysAgo(1), projectKey: 'archi', featureKey: 'rag', usd: 100 },
  ]);
  const vm = buildOverview({ db, days: 30 });
  assert.equal(vm.unattributed, null);
});

test('unattributed: populated payload includes sparkline and top projects', () => {
  const db = openInMemoryDb();
  seedRollups(db, [
    { date: daysAgo(1), projectKey: 'archi',      featureKey: 'uncategorized-mainline', usd: 60 },
    { date: daysAgo(1), projectKey: 'tokentrail', featureKey: 'uncategorized-mainline', usd: 40 },
    { date: daysAgo(2), projectKey: 'archi',      featureKey: 'uncategorized-mainline', usd: 10 },
    { date: daysAgo(3), projectKey: 'archi',      featureKey: 'rag',                    usd: 30 }, // for pctOfTrail denominator
  ]);
  const vm = buildOverview({ db, days: 30 });
  assert.ok(vm.unattributed);
  assert.equal(vm.unattributed!.totalUsd, 110);
  assert.equal(vm.unattributed!.sparkline.length, 30);
  const top = vm.unattributed!.topProjects.map((p) => p.key);
  assert.deepEqual(top, ['archi', 'tokentrail']);
  const pct = vm.unattributed!.pctOfTrail;
  assert.ok(pct > 70 && pct < 90, `expected pctOfTrail in [70,90], got ${pct}`);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --import tsx --test tests/dashboard-data.test.ts`
Expected: multiple failures — assertions reference fields (`projects`, `featureBands`, `projectFeatureMix`, `unattributed`) that don't exist yet on `OverviewVM`.

- [ ] **Step 4: Rewrite `buildOverview` payload**

Open `src/dashboard/data/overview.ts`. Remove the feature-first `features[]` and per-day `bands` keyed by feature. Add the new fields.

Key logic in prose (implementer transcribes to code following the file's existing style):

1. Compute `windowDays = Math.max(1, opts.days)`.
2. Query `feature_rollups` grouped by `project_key` across the window → sort by total desc → take first 6 as real projects, sum the tail into an `Other` bucket. Assign `stackPosition`: 0 = largest, 5 = 6th, 6 = Other. Colors: real projects → `colorForProject(key)`; Other → `OTHER_COLOR`. Each real project has a display `name` derived from the existing project-name lookup (reuse whatever helper the current `topProjects` builder uses).
3. Build `days[]` by pre-filling `windowDays` zero rows keyed by `daysAgo`. For each day:
   - `bands`: per-project totals (all real projects get an entry even if 0; Other is the sum of everything not in the top-6 for that day).
   - `featureBands[projectKey]`: nested map. For each rollup row, bucket by `feature_key`. If `feature_key === 'uncategorized-mainline'`, store under `'__unattributed__'`. Otherwise use the raw feature key.
   - `unattributedTotal`: sum of `featureBands[*][__unattributed__]` for that day.
4. Build `projectFeatureMix[]`: for every project in `projects[]` except `Other`, aggregate features across the window from `feature_rollups` for that project. Include `__unattributed__` if present. Sort each project's `features` array by `totalUsd` desc. Color: `colorFor(featureKey)` for real; `STRIPED_SENTINEL` for `__unattributed__`. Skip the `Other` project — its internal breakdown is not shown.
5. Build `unattributed`:
   - Sum unattributed across the whole window. If 0 → `unattributed = null`.
   - Else compute `pctOfTrail = (totalUnattributedUsd / totalUsd) * 100`.
   - Sparkline: iterate over `days[]`, `{ date, usd: day.unattributedTotal }`.
   - `topProjects`: aggregate per-project `__unattributed__` totals across the window, sort desc, take top 3. For each, include the project's total to compute the mini progress bar's denominator.
6. Return the populated `OverviewVM`.

The file has an existing pattern for reading `feature_rollups` (see the current `dailySeries` block that this refactor replaces). Reuse the shared query helpers; do NOT introduce a new DB abstraction.

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --import tsx --test tests/dashboard-data.test.ts`
Expected: all new tests pass. Pre-existing tests in the file may need trivial updates (existing test file already handled camel/snake feature-key overrides in a previous session — leave those helpers intact).

- [ ] **Step 6: Run full suite + build**

Run: `pnpm test 2>&1 | tail -5 && pnpm build 2>&1 | tail -3`
Expected: green suite, zero build errors. Any pre-existing tests referencing the removed feature-first `features[]` field will need to be updated — do so minimally, without changing their intent.

- [ ] **Step 7: Commit**

```bash
git add src/dashboard/data/overview.ts tests/dashboard-data.test.ts tests/overview-render.test.ts
git commit -m "feat(dashboard): project-first overview payload with featureBands + unattributed"
```

---

## Task 3: Render layer — trend chart shell, project legend, JSON payload

**Files:**
- Modify: `src/dashboard/render/overview.ts` — emit new JSON payload for the trend chart; render project-first legend; keep burn-paths markup unchanged for now (Task 5 adds sub-bar); add empty unattributed placeholder wrapper (Task 6 fills it).
- Modify: `tests/overview-render.test.ts` — assertions on new markup.

**Interfaces:**
- Consumes: `OverviewVM` from Task 2. `colorForProject` from Task 1 (only if the render layer needs the color directly — but the payload already carries it; probably not needed here).
- Produces: HTML structure with:
  - `<script type="application/json" id="trend-data">{ days, projects, unattributed }</script>` — includes `unattributed` here so the sidebar card can grab it from the same payload (or split into a second `<script>` if easier; the plan permits either).
  - `<ul id="trend-legend">` with one `<li class="trend-legend-row" data-project-key="..." data-project-color="..." data-clickable="0|1">` per row.
  - Burn-paths rows: one `<div class="project-row" data-project-key="..." data-project-color="...">` per row, with a `<div class="subbar" data-project-key="...">` container that Task 5's JS will populate.
  - Sidebar unattributed placeholder: `<div class="card unatt-card" id="unattributed-card" hidden></div>` — Task 6 mounts real content.

- [ ] **Step 1: Write the failing render tests**

Append to `tests/overview-render.test.ts`:

```ts
test('trend legend uses data-project-key and orders by stackPosition desc', () => {
  const vm: OverviewVM = {
    ...emptyVM(),
    totalUsd: 100,
    projects: [
      { key: 'a', name: 'Alpha', color: '#000', totalUsd: 60, clickable: true, stackPosition: 0 },
      { key: 'b', name: 'Beta',  color: '#111', totalUsd: 40, clickable: true, stackPosition: 1 },
      { key: '__other__', name: 'Other', color: '#9CA3AF', totalUsd: 5, clickable: false, stackPosition: 2 },
    ],
    days: [{ date: '2026-06-30', total: 105, bands: { a: 60, b: 40, __other__: 5 }, featureBands: {}, unattributedTotal: 0, commits: 0, prs: 0 }],
  };
  const html = renderOverview(vm);
  // First legend row is __other__ (highest stackPosition).
  const firstRowIdx = html.indexOf('trend-legend-row');
  const otherIdx = html.indexOf('data-project-key="__other__"');
  const bIdx = html.indexOf('data-project-key="b"');
  const aIdx = html.indexOf('data-project-key="a"');
  assert.ok(otherIdx > 0 && bIdx > 0 && aIdx > 0);
  assert.ok(otherIdx < bIdx && bIdx < aIdx, 'legend order should be Other, b, a');
});

test('__other__ legend row has data-clickable="0"', () => {
  const vm: OverviewVM = {
    ...emptyVM(),
    totalUsd: 100,
    projects: [
      { key: 'a', name: 'A', color: '#000', totalUsd: 60, clickable: true, stackPosition: 0 },
      { key: '__other__', name: 'Other', color: '#9CA3AF', totalUsd: 40, clickable: false, stackPosition: 1 },
    ],
    days: [{ date: '2026-06-30', total: 100, bands: {}, featureBands: {}, unattributedTotal: 0, commits: 0, prs: 0 }],
  };
  const html = renderOverview(vm);
  assert.match(html, /data-project-key="__other__"[^>]*data-clickable="0"/);
});

test('burn paths rows carry data-project-key and include an empty subbar container', () => {
  const vm: OverviewVM = {
    ...emptyVM(),
    totalUsd: 100,
    topProjects: [{ key: 'archi', name: 'archi', totalUsd: 100, pct: 100, featureCount: 2, sessionCount: 3 }],
  };
  const html = renderOverview(vm);
  assert.match(html, /class="project-row"[^>]*data-project-key="archi"/);
  assert.match(html, /class="subbar"[^>]*data-project-key="archi"/);
});

test('unattributed card placeholder hidden by default; visible marker when payload present', () => {
  const empty: OverviewVM = { ...emptyVM(), totalUsd: 0 };
  assert.doesNotMatch(renderOverview(empty), /id="unattributed-card"/);

  const withUnatt: OverviewVM = {
    ...emptyVM(),
    totalUsd: 100,
    unattributed: {
      totalUsd: 40,
      pctOfTrail: 40,
      sparkline: [],
      topProjects: [],
    },
  };
  const html = renderOverview(withUnatt);
  assert.match(html, /id="unattributed-card"/);
  assert.doesNotMatch(html, /id="unattributed-card"[^>]* hidden/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import tsx --test tests/overview-render.test.ts`
Expected: multiple failures — markup changes not yet applied.

- [ ] **Step 3: Rewrite the trend + legend markup in `src/dashboard/render/overview.ts`**

The current `renderOverview` emits `data-feature-key` legend rows. Replace with project legend. Update the JSON script tag payload. Do NOT touch `renderTopProjects` — Task 5 will replace its output. Add the unattributed card placeholder as a top-level sidebar element.

Sketch (implementer transcribes with exact escaping/helper conventions used elsewhere in the file):

```ts
// Legend rendering
function renderTrendLegend(projects: OverviewVM['projects']): string {
  // Single-tier sort: descending stackPosition (top-of-legend = top-of-stack).
  const rows = [...projects].sort((a, b) => b.stackPosition - a.stackPosition);
  return rows.map((p) => {
    const clickable = p.clickable ? '1' : '0';
    return `<li class="trend-legend-row" data-project-key="${escapeHtml(p.key)}" data-project-color="${escapeHtml(p.color)}" data-clickable="${clickable}">
      <span class="swatch" style="background:${escapeHtml(p.color)}"></span>
      <span class="name">${escapeHtml(p.name)}</span>
      <span class="amt">$${p.totalUsd.toFixed(0)}</span>
    </li>`;
  }).join('');
}
```

Update the JSON payload:

```ts
<script type="application/json" id="trend-data">${jsonForScriptTag({
  days: vm.days,
  projects: vm.projects,
  unattributed: vm.unattributed,
})}</script>
```

Remove the old empty-state hint for uncategorized-only content; Task 6's unattributed card supersedes it.

Add the unattributed card placeholder in the sidebar (conditional):

```ts
${vm.unattributed ? '<div class="card unatt-card" id="unattributed-card"></div>' : ''}
```

Position: between the "This week" card and the "Worth a look" card in the aside.

- [ ] **Step 4: Update burn-paths markup for Task 5's sub-bar**

In whichever helper renders `topProjects` (currently `renderTopProjects` per the file's structure), for each row emit:

```ts
`<div class="project-row" data-project-key="${escapeHtml(p.key)}" data-project-color="${escapeHtml(colorForProject(p.key))}">
  <div class="rank">${rank}</div>
  <span class="swatch" style="background:${escapeHtml(colorForProject(p.key))}"></span>
  <div class="name-col"><a href="/project/${encodeURIComponent(p.key)}">${escapeHtml(p.name)}</a> <span class="muted">· ${p.featureCount} features</span></div>
  <div class="amt-col">$${p.totalUsd.toFixed(0)} · ${p.pct.toFixed(0)}%</div>
  <div class="main-bar" style="--pct:${p.pct}"></div>
  <div class="subbar" data-project-key="${escapeHtml(p.key)}"></div>
</div>`
```

(Adjust to match the existing grid layout the file already uses; the CSS grid was updated in PR #38 to `24px 12px 1fr auto` — keep that.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --import tsx --test tests/overview-render.test.ts`
Expected: all 4 new tests pass.

- [ ] **Step 6: Run full suite + build**

Run: `pnpm test 2>&1 | tail -5 && pnpm build 2>&1 | tail -3`
Expected: green suite, zero build errors.

- [ ] **Step 7: Commit**

```bash
git add src/dashboard/render/overview.ts tests/overview-render.test.ts
git commit -m "feat(dashboard): project-first trend legend + burn-paths sub-bar container + unattributed placeholder"
```

---

## Task 4: `dashboard.js` — `renderTrend` rewrite (project bands + two-block tooltip)

**Files:**
- Modify: `src/dashboard/static/dashboard.js` — swap `renderTrend()` from feature-first to project-first; extend tooltip to two blocks with clickable `<a>` feature rows; extend mouseleave guard to tolerate the cursor entering the tooltip DOM.

**Interfaces:**
- Consumes: `{ days, projects, unattributed }` JSON payload from `#trend-data` script tag; `uPlot` global; existing `esc` and `hexToRgba` helpers already in the file (kept from PR #38).
- Produces: on-page interactive stacked-area chart with the new tooltip. Adds a global-ish `window.__tokentrailActiveProject` (or similar) if legend cross-highlight needs to reach across handler boundaries; keep the state local to the closure if possible.

- [ ] **Step 1: Locate the current `renderTrend` and copy its skeleton**

Read the top ~200 lines of `src/dashboard/static/dashboard.js`. The current `renderTrend()` implements: JSON parse guard, empty-state fallback, stack order construction from `features`, cumulative-ys per series, uPlot config with `bands`, per-day tooltip, hover-highlight, click-through to `/feature/<key>`. Keep the structure; swap the decomposition key.

- [ ] **Step 2: Rewrite the data prep**

Replace feature-first prep:

```js
const projects = payload.projects || [];
const stackOrder = projects.slice().sort((a, b) => a.stackPosition - b.stackPosition);
const xs = days.map((d) => new Date(d.date + 'T00:00:00').getTime() / 1000);
const seriesYs = stackOrder.map((proj, idx) => {
  return days.map((d) => {
    let sum = 0;
    for (let i = 0; i <= idx; i++) sum += d.bands[stackOrder[i].key] || 0;
    return sum;
  });
});
```

- [ ] **Step 3: Fills**

There's no striped band on the trend chart. Every band gets a solid hex fill (with 0.92 alpha, matching PR #38's convention). Drop the `makeStripePattern` / `STRIPED_SENTINEL` handling from `renderTrend` — it lives on now only in the sub-bar (Task 5) and the sparkline (Task 6).

```js
function fillFor(color) {
  return hexToRgba(color, 0.92);
}
```

- [ ] **Step 4: Two-block tooltip**

The tooltip's `top block` (per-project totals for the day, sorted $ desc) mirrors PR #38's per-feature list. The `bottom block` is new: when the cursor is over a band, look up `days[idx].featureBands[activeProjectKey]` and render up to 3 feature rows as `<a href="/feature/<key>">`.

```js
function renderTooltip(idx, activeProjectKey) {
  const day = days[idx];
  if (!day || day.total === 0) {
    return `<div class="chart-tooltip-header">${esc(fmtDate(xs[idx]))}</div>`;
  }
  const perProject = Object.entries(day.bands)
    .filter(([, usd]) => usd > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([key, usd]) => {
      const proj = stackOrder.find((p) => p.key === key);
      const color = proj ? proj.color : '#9CA3AF';
      const name = proj ? proj.name : key;
      return `<div class="chart-tooltip-row"><span class="swatch" style="background:${esc(color)}"></span>${esc(name)}<span class="amt">${fmtUsd(usd)}</span></div>`;
    }).join('');

  let bottom = '';
  if (activeProjectKey && activeProjectKey !== '__other__') {
    const active = stackOrder.find((p) => p.key === activeProjectKey);
    const feats = day.featureBands?.[activeProjectKey] || {};
    const entries = Object.entries(feats)
      .filter(([, usd]) => usd > 0)
      .sort((a, b) => b[1] - a[1]);
    const shown = entries.slice(0, 3);
    const more = entries.length - shown.length;
    const rows = shown.map(([key, usd]) => {
      if (key === '__unattributed__') {
        return `<div class="chart-tooltip-row chart-tooltip-row--unatt"><span class="swatch swatch--striped"></span>unattributed<span class="amt">${fmtUsd(usd)}</span></div>`;
      }
      // Feature key → clickable link + colored swatch. We don't have feature names in the payload;
      // fall back to the key slug. If a name is desired, extend the payload in Task 2.
      return `<a class="chart-tooltip-row chart-tooltip-link" href="/feature/${encodeURIComponent(key)}"><span class="swatch" style="background:${esc(colorForFeature(key))}"></span>${esc(key)}<span class="amt">${fmtUsd(usd)}</span></a>`;
    }).join('');
    bottom = `<div class="chart-tooltip-subhead">Inside ${esc(active ? active.name : activeProjectKey)}:</div>${rows}${more > 0 ? `<div class="chart-tooltip-more">+ ${more} more</div>` : ''}`;
  }
  return `<div class="chart-tooltip-header">${esc(fmtDate(xs[idx]))}</div><div class="chart-tooltip-rows">${perProject}</div>${bottom}`;
}
```

`colorForFeature` on the client side is a small mirror of the server helper. Add a minimal inline version:

```js
// Client-side colour picker for features shown in tooltips. Mirrors src/dashboard/lib/feature-colors.ts.
// Kept inline (not fetched over the wire) so tooltips render synchronously.
const PALETTE_INLINE = ['#0072B2','#E69F00','#009E73','#CC79A7','#56B4E9','#D55E00','#F0E442','#000000'];
function colorForFeature(k) {
  let h = 5381;
  for (let i = 0; i < k.length; i++) h = ((h << 5) - h + k.charCodeAt(i)) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x9E3779B1);
  return PALETTE_INLINE[Math.abs(h >>> 0) % PALETTE_INLINE.length];
}
```

- [ ] **Step 5: Click-through**

Adapt the existing click handler: on click of a band whose `stackOrder[bandIdx].clickable === true`, `window.location.href = '/project/' + encodeURIComponent(stackOrder[bandIdx].key)`. `__other__` no-ops. Preserve the existing legend `setActiveKey(key)` machinery — just rename to be project-agnostic (currently keyed by feature; now keyed by project). Chart↔legend mouseleave race guard from PR #38 must be preserved.

- [ ] **Step 6: Tooltip stays interactive**

The current implementation dismisses the tooltip on chart mouseleave (with a legend-hover guard). Extend the guard: also skip dismissal if `tooltip.matches(':hover')`. Reason: the bottom block now contains `<a>` links the user needs to click. Full pattern:

```js
node.addEventListener('mouseleave', () => {
  if (legend && legend.matches(':hover')) return;
  if (tooltip && tooltip.matches(':hover')) return;
  setActiveKey(null);
  tooltip.style.display = 'none';
});
tooltip.addEventListener('mouseleave', () => {
  if (legend && legend.matches(':hover')) return;
  if (node && node.matches(':hover')) return;
  setActiveKey(null);
  tooltip.style.display = 'none';
});
```

Also give the tooltip `pointer-events: auto` (Task 7 in CSS).

- [ ] **Step 7: Manual smoke test**

Rebuild + run the dashboard from local source (see the SKILL for `cp -R` gotcha — already fixed in `package.json`):

```bash
pnpm build && node dist/src/index.js dashboard --no-open
```

Then in another shell: `curl -s http://127.0.0.1:4920/ | grep -c "trend-legend-row"` should return a positive integer matching your `projects[]` length in the current DB.

- [ ] **Step 8: Run full suite + build**

Run: `pnpm test 2>&1 | tail -5 && pnpm build 2>&1 | tail -3`
Expected: green.

- [ ] **Step 9: Commit**

```bash
git add src/dashboard/static/dashboard.js
git commit -m "feat(dashboard): project-first stacked-area chart with per-project feature tooltip"
```

---

## Task 5: `dashboard.js` — burn-paths inline feature sub-bars

**Files:**
- Modify: `src/dashboard/static/dashboard.js` — add `renderBurnPathsSubBars()` that reads `projectFeatureMix` from a new `#burn-paths-data` script tag (or reuses `#trend-data` if you added `projectFeatureMix` there).
- Modify: `src/dashboard/render/overview.ts` — emit that JSON script tag once, near the top of the burn-paths card.
- Modify: `src/dashboard/static/dashboard.css` — sub-bar segment styles (Task 7 finalizes polish; this task adds the minimum functional CSS).

**Interfaces:**
- Consumes: `projectFeatureMix` array from the overview payload. `.subbar[data-project-key]` DOM nodes from Task 3.
- Produces: DOM under each `.subbar` = a horizontal row of `<div class="subbar-segment">` with % widths and per-feature colors. `__unattributed__` gets `.subbar-segment--striped`.

- [ ] **Step 1: Emit the payload**

In `src/dashboard/render/overview.ts`, add near the top of the burn-paths card:

```ts
<script type="application/json" id="burn-paths-data">${jsonForScriptTag(vm.projectFeatureMix)}</script>
```

- [ ] **Step 2: Add a failing test at the DOM level**

Sub-bar behaviour is small enough to leave to a light DOM assertion + manual QA. Add one assertion to `tests/overview-render.test.ts`:

```ts
test('burn paths payload includes projectFeatureMix JSON', () => {
  const vm: OverviewVM = {
    ...emptyVM(),
    totalUsd: 100,
    topProjects: [{ key: 'archi', name: 'archi', totalUsd: 100, pct: 100, featureCount: 2, sessionCount: 3 }],
    projectFeatureMix: [{
      projectKey: 'archi',
      features: [
        { key: 'rag', name: 'RAG', color: '#0072B2', totalUsd: 60 },
        { key: '__unattributed__', name: 'unattributed', color: '__striped__', totalUsd: 40 },
      ],
    }],
  };
  const html = renderOverview(vm);
  assert.match(html, /id="burn-paths-data"/);
  assert.match(html, /"projectKey":"archi"/);
  assert.match(html, /"__striped__"/);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --import tsx --test tests/overview-render.test.ts`
Expected: FAIL — `burn-paths-data` script tag absent.

- [ ] **Step 4: Write `renderBurnPathsSubBars()`**

Add near the end of `dashboard.js`:

```js
function renderBurnPathsSubBars() {
  const dataNode = document.getElementById('burn-paths-data');
  if (!dataNode) return;
  let payload;
  try { payload = JSON.parse(dataNode.textContent || 'null'); } catch (e) { return; }
  if (!Array.isArray(payload)) return;

  payload.forEach((entry) => {
    const container = document.querySelector(`.subbar[data-project-key="${cssEscape(entry.projectKey)}"]`);
    if (!container) return;
    const total = entry.features.reduce((s, f) => s + f.totalUsd, 0);
    if (total <= 0) return;

    // Enforce minimum visible segment width (2px). Small segments aggregate into a
    // trailing "other-features" neutral bucket to preserve legibility.
    const minPct = 2 / (container.clientWidth || 480) * 100;
    const kept = [];
    let otherUsd = 0;
    entry.features.forEach((f) => {
      const pct = (f.totalUsd / total) * 100;
      if (pct >= minPct) kept.push({ ...f, pct });
      else otherUsd += f.totalUsd;
    });
    if (otherUsd > 0) {
      kept.push({ key: '__other_features__', name: 'other features', color: '#9CA3AF', totalUsd: otherUsd, pct: (otherUsd / total) * 100 });
    }

    container.innerHTML = kept.map((f) => {
      const striped = f.color === '__striped__' ? ' subbar-segment--striped' : '';
      const bg = f.color === '__striped__' ? '' : `background:${escapeAttr(f.color)};`;
      const title = escapeAttr(`${f.name}: $${f.totalUsd.toFixed(0)}`);
      return `<div class="subbar-segment${striped}" style="${bg}width:${f.pct.toFixed(2)}%" title="${title}"></div>`;
    }).join('');
  });
}

function cssEscape(s) {
  return String(s).replace(/["\\]/g, '\\$&');
}
function escapeAttr(s) {
  return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;');
}

document.addEventListener('DOMContentLoaded', renderBurnPathsSubBars);
```

- [ ] **Step 5: Minimum CSS for functional layout**

Add to `src/dashboard/static/dashboard.css`:

```css
.subbar {
  display: flex;
  height: 8px;
  margin-top: 4px;
  border-radius: 2px;
  overflow: hidden;
  background: rgba(0,0,0,0.05);
}
.subbar-segment { height: 100%; }
.subbar-segment--striped {
  background: repeating-linear-gradient(
    45deg,
    #6B7280 0 4px,
    rgba(255,255,255,0.35) 4px 6px
  );
}
```

Full polish is Task 7.

- [ ] **Step 6: Run test to verify it passes**

Run: `node --import tsx --test tests/overview-render.test.ts`
Expected: PASS.

- [ ] **Step 7: Manual smoke test**

Rebuild + reload the dashboard. Each burn-paths row should show a thin coloured strip below its main bar. Rows with unattributed spend show a striped segment. Hover a segment: browser default tooltip shows the feature name + $.

- [ ] **Step 8: Run full suite + build**

Run: `pnpm test 2>&1 | tail -5 && pnpm build 2>&1 | tail -3`
Expected: green.

- [ ] **Step 9: Commit**

```bash
git add src/dashboard/render/overview.ts src/dashboard/static/dashboard.js src/dashboard/static/dashboard.css tests/overview-render.test.ts
git commit -m "feat(dashboard): inline feature sub-bars under each burn-paths row"
```

---

## Task 6: Unattributed card — sparkline, top projects, clipboard CTA

**Files:**
- Modify: `src/dashboard/static/dashboard.js` — add `renderUnattributedCard()`; mount into `#unattributed-card`; draw SVG sparkline; wire clipboard CTA.
- Modify: `src/dashboard/static/dashboard.css` — new card styles (`.unatt-card`, etc.).

**Interfaces:**
- Consumes: `unattributed` object from `#trend-data` script tag (already emitted by Task 3). `#unattributed-card` container from Task 3.
- Produces: rendered card DOM; clipboard-copy behaviour on the CTA button.

- [ ] **Step 1: Add a DOM-level assertion at the render layer**

Append to `tests/overview-render.test.ts`:

```ts
test('unattributed card visible with rendered content when payload present', () => {
  const vm: OverviewVM = {
    ...emptyVM(),
    totalUsd: 200,
    unattributed: {
      totalUsd: 60,
      pctOfTrail: 30,
      sparkline: Array.from({ length: 30 }, (_, i) => ({ date: `2026-06-${String(i+1).padStart(2,'0')}`, usd: i })),
      topProjects: [
        { key: 'archi', name: 'archi', color: '#0072B2', unattributedUsd: 40, projectTotalUsd: 120 },
      ],
    },
  };
  const html = renderOverview(vm);
  assert.match(html, /id="unattributed-card"/);
  // The card's data payload should be in the JSON blob so client JS can mount it.
  assert.match(html, /"pctOfTrail":30/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test tests/overview-render.test.ts`
Expected: PASS or FAIL depending on whether Task 3 already included `unattributed` in `#trend-data`. If it did, the assertion should already be satisfied — mark this step as VERIFIED without a fail-first cycle and move on.

- [ ] **Step 3: Write `renderUnattributedCard()`**

Append to `dashboard.js`:

```js
function renderUnattributedCard() {
  const card = document.getElementById('unattributed-card');
  const dataNode = document.getElementById('trend-data');
  if (!card || !dataNode) return;
  let payload;
  try { payload = JSON.parse(dataNode.textContent || 'null'); } catch (e) { return; }
  const u = payload && payload.unattributed;
  if (!u) return;

  const spark = drawSparkline(u.sparkline);
  const projRows = u.topProjects.map((p) => {
    const pct = p.projectTotalUsd > 0 ? (p.unattributedUsd / p.projectTotalUsd) * 100 : 0;
    return `<div class="unatt-project">
      <div class="unatt-project-head">
        <span class="swatch" style="background:${escapeAttr(p.color)}"></span>
        <span class="name">${esc(p.name)}</span>
        <span class="amt">${fmtUsd(p.unattributedUsd)}</span>
      </div>
      <div class="unatt-project-bar"><div style="width:${pct.toFixed(1)}%"></div></div>
    </div>`;
  }).join('');

  card.innerHTML = `
    <div class="label">Unattributed</div>
    <div class="unatt-hero">${fmtUsd(u.totalUsd)} <span class="muted">· ${u.pctOfTrail.toFixed(0)}% of trail</span></div>
    <div class="unatt-sparkline">${spark}</div>
    <div class="unatt-projects">${projRows}</div>
    <button class="unatt-cta" type="button" data-clipboard="tokentrail infer-mainline">Run <code>tokentrail infer-mainline</code> →</button>
  `;

  const btn = card.querySelector('.unatt-cta');
  btn.addEventListener('click', async (e) => {
    const text = e.currentTarget.getAttribute('data-clipboard') || '';
    try {
      await navigator.clipboard.writeText(text);
      const original = btn.innerHTML;
      btn.textContent = 'Copied ✓';
      setTimeout(() => { btn.innerHTML = original; }, 1500);
    } catch (err) {
      // Fallback: no-op; label doesn't flip. Not worth a toast for a copy failure on localhost.
    }
  });
}

function drawSparkline(points) {
  if (!points || points.length === 0) return '';
  const w = 220, h = 40, pad = 2;
  const max = Math.max(1, ...points.map((p) => p.usd));
  const stepX = (w - pad * 2) / Math.max(1, points.length - 1);
  const pts = points.map((p, i) => {
    const x = pad + i * stepX;
    const y = h - pad - (p.usd / max) * (h - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  // Uses the striped fill sentinel visually via CSS pattern on the polygon (we approximate with a solid grey fill + underline stripe pattern in CSS on the container).
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
    <polyline points="${pts}" fill="none" stroke="#6B7280" stroke-width="1.5" />
  </svg>`;
}

document.addEventListener('DOMContentLoaded', renderUnattributedCard);
```

- [ ] **Step 4: CSS for the card**

Add to `src/dashboard/static/dashboard.css`:

```css
.unatt-card { }
.unatt-hero { font-family: var(--font-serif); font-size: 22px; font-weight: 600; margin-top: 4px; }
.unatt-hero .muted { font-family: var(--font-sans); font-size: 12px; font-weight: 400; }
.unatt-sparkline { margin: 8px 0; }
.unatt-sparkline svg { width: 100%; height: 40px; }
.unatt-projects { display: flex; flex-direction: column; gap: 6px; margin-bottom: 10px; }
.unatt-project-head { display: flex; align-items: center; gap: 6px; font-size: 12px; }
.unatt-project-head .name { flex: 1; }
.unatt-project-head .amt { color: #6b563d; font-variant-numeric: tabular-nums; }
.unatt-project-bar { height: 4px; background: rgba(0,0,0,0.06); border-radius: 2px; overflow: hidden; }
.unatt-project-bar > div { height: 100%; background: repeating-linear-gradient(45deg, #6B7280 0 4px, rgba(255,255,255,0.35) 4px 6px); }
.unatt-cta {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 6px 10px; border: 1px solid rgba(0,0,0,0.15); background: transparent;
  border-radius: 4px; cursor: pointer; font-family: var(--font-sans); font-size: 12px;
}
.unatt-cta:hover { background: rgba(139,111,71,0.08); }
```

- [ ] **Step 5: Manual smoke test**

Rebuild + reload. If unattributed = $0, card hidden. Otherwise: hero number, sparkline, up to 3 project rows, CTA button. Click the CTA and paste into a terminal — clipboard should contain `tokentrail infer-mainline`. Label briefly flips to `Copied ✓`.

- [ ] **Step 6: Run full suite + build**

Run: `pnpm test 2>&1 | tail -5 && pnpm build 2>&1 | tail -3`
Expected: green.

- [ ] **Step 7: Commit**

```bash
git add src/dashboard/static/dashboard.js src/dashboard/static/dashboard.css tests/overview-render.test.ts
git commit -m "feat(dashboard): unattributed sidebar card with sparkline + clipboard CTA"
```

---

## Task 7: CSS polish + tooltip interactivity + burn-paths grid check

**Files:**
- Modify: `src/dashboard/static/dashboard.css` — polish sub-bar styles, tooltip pointer-events, project-legend layout, project swatch consistency across burn paths and feature detail.
- Modify: `src/dashboard/render/feature.ts` — no-op unless a swatch reference needs updating for consistency (verify header still uses `colorFor(featureKey)`; features still get feature colors on their detail page per spec).

**Interfaces:**
- Consumes: markup and JS from Tasks 3-6.
- Produces: final CSS state that matches the spec's visual expectations.

- [ ] **Step 1: Legend styling (data-project-key)**

The current `.trend-legend-row` selectors from PR #38 already work with any `data-*-key` attribute — verify. Update comments if the CSS still mentions "feature".

- [ ] **Step 2: Tooltip pointer-events**

Add:

```css
.chart-tooltip { pointer-events: auto; }
.chart-tooltip-link {
  display: grid;
  grid-template-columns: 12px 1fr auto;
  gap: 6px;
  align-items: center;
  text-decoration: none;
  color: inherit;
  padding: 2px 0;
}
.chart-tooltip-link:hover { background: rgba(139,111,71,0.08); }
.chart-tooltip-subhead {
  font-size: 11px;
  color: #6b563d;
  margin-top: 6px;
  border-top: 1px solid rgba(0,0,0,0.08);
  padding-top: 6px;
}
.chart-tooltip-more { font-size: 11px; color: #6b563d; margin-top: 2px; }
.swatch--striped {
  background: repeating-linear-gradient(45deg, #6B7280 0 4px, rgba(255,255,255,0.35) 4px 6px);
}
```

- [ ] **Step 3: `.project-row` grid verify**

The chart-redesign PR #38 already updated `.project-row` grid-template-columns to `24px 12px 1fr auto`. Confirm the current file still has that. If Task 3 added a `.subbar` inside `.project-row`, ensure the subbar spans all 4 columns:

```css
.project-row {
  display: grid;
  grid-template-columns: 24px 12px 1fr auto;
  grid-template-rows: auto auto auto;
  gap: 4px 8px;
  align-items: center;
  padding: 6px 0;
  border-bottom: 1px solid rgba(0,0,0,0.04);
}
.project-row .rank { grid-column: 1; grid-row: 1; }
.project-row .swatch { grid-column: 2; grid-row: 1; }
.project-row .name-col { grid-column: 3; grid-row: 1; }
.project-row .amt-col { grid-column: 4; grid-row: 1; text-align: right; }
.project-row .main-bar { grid-column: 1 / -1; grid-row: 2; height: 4px; background: rgba(0,0,0,0.06); position: relative; border-radius: 2px; overflow: hidden; }
.project-row .main-bar::before { content: ''; display: block; height: 100%; width: calc(var(--pct) * 1%); background: rgba(139,111,71,0.5); }
.project-row .subbar { grid-column: 1 / -1; grid-row: 3; }
```

(Adjust to whatever the file already declares — this task's goal is coherence, not a from-scratch rewrite.)

- [ ] **Step 4: Feature detail page**

Open `src/dashboard/render/feature.ts`. Confirm the header swatch still calls `colorFor(vm.featureKey)`. No change unless it now points to `colorForProject` accidentally.

- [ ] **Step 5: Manual smoke test — final visual pass**

Rebuild + reload. Check:
- Trend chart: 6+ project bands (or fewer if <6 projects), Other at top of stack.
- Legend rows: Other at top, then progressively larger projects toward the bottom.
- Hover a band: two-block tooltip; hover into the tooltip → doesn't dismiss; click a feature link → navigates to `/feature/<key>`; click a band → navigates to `/project/<key>`.
- Burn paths: each row has a thin feature sub-bar; unattributed segments are striped; project swatches match the trend legend colors.
- Unattributed card: hero, sparkline, top 3 projects, CTA copies to clipboard.
- Feature detail page: header swatch still shows a feature-color (not project-color).
- Project detail page: unchanged.

- [ ] **Step 6: Full suite + build**

Run: `pnpm test 2>&1 | tail -5 && pnpm build 2>&1 | tail -3`
Expected: green suite; zero build errors.

- [ ] **Step 7: Commit**

```bash
git add src/dashboard/static/dashboard.css src/dashboard/render/feature.ts
git commit -m "feat(dashboard): CSS polish for project-first overview + interactive tooltip links"
```

---

## Coverage mapping (spec → task)

- **Section A: trend chart** — Task 2 (payload), Task 3 (render + legend), Task 4 (JS render).
- **Section B: trend hover with clickable feature rows + mouseleave guard** — Task 2 (`featureBands`), Task 4 (tooltip JS + guard), Task 7 (link styling + pointer-events).
- **Section C: burn paths sub-bars + project swatches** — Task 3 (markup + swatch source), Task 5 (JS + minimum CSS), Task 7 (grid + polish).
- **Section D: unattributed card** — Task 2 (payload), Task 3 (placeholder), Task 6 (JS + CSS + CTA).
- **Section E: colors module** — Task 1 (`colorForProject`).
- **Edge cases (all)** — Task 2 (`unattributed = null`, `Other` omitted, single project, all unattributed).
- **Testing (all bullets)** — distributed across Tasks 1-6 with a final green run in Task 7.
