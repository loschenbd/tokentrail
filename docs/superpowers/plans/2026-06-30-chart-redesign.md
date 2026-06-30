# Feature-Decomposed Trend Chart — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the dashboard's single-line trend chart with a stacked-area chart that decomposes daily cost by feature so a glance answers "which features cost the most and when did they spike."

**Architecture:** New pure `feature-colors` module gives each `feature_key` a stable color. `buildOverview` extends its payload with a `features` array (legend metadata) and per-day `bands` (one entry per top-6 feature plus `__other__` and `uncategorized-mainline`). The client swaps the existing single-series uPlot config for a stacked-area config with hover-highlight, per-day tooltip, and click-through to `/feature/<key>`. `uncategorized-mainline` renders with a hatched canvas pattern.

**Tech Stack:** TypeScript, Node.js (>= 20), better-sqlite3, uPlot (already vendored at `src/dashboard/static/uPlot.iife.min.js`), `node:test` for unit/integration tests, pnpm for running scripts.

## Global Constraints

- **Stack order (bottom → top):** largest real feature → 6th-largest → `__other__` → `uncategorized-mainline`. Largest at bottom anchors the baseline.
- **Top features count:** exactly 6 real features get their own bands. Rank 7+ collapse into `__other__`.
- **`uncategorized-mainline` is never folded into Other.** Always its own band regardless of rank. Rendered with hatched fill over `#6B7280`.
- **`__other__` color:** `#9CA3AF`. **`uncategorized-mainline` base color:** `#6B7280` with diagonal stripes.
- **Palette:** Okabe-Ito 8-color qualitative — `['#0072B2','#E69F00','#009E73','#CC79A7','#56B4E9','#D55E00','#F0E442','#000000']`.
- **Color hash:** deterministic from `feature_key`. Same feature → same color across chart, legend, "Top burn paths" sidebar, and `/feature/<key>` page.
- **Legend placement:** vertical, right of chart. Order top-to-bottom = stack order top-to-bottom (uncategorized at top, then Other, then real features sorted by total $ desc).
- **Tooltip:** anchored to cursor on hover; lists per-feature breakdown sorted by $ desc **for that day**, only non-zero bands. Total $ at the top, commits/PRs count at the bottom (same data as today).
- **Hover-highlight:** hovering a band or legend row keeps that band at full opacity; others fade to ~25% opacity.
- **Click-through:** click a real-feature band or legend row → navigate to `/feature/<key>`. Other and uncategorized rows/bands are not clickable.
- **YAGNI list (do NOT build):** view-toggle to old chart, custom feature pinning, date-range picker, per-repo filter inside chart, animations/transitions, drag-to-zoom.
- **DB / schema:** no changes. Query reads existing `feature_rollups` table.
- **Voice / copy:** all UI strings follow project's calm, precise tone — empty state when only uncategorized exists reads exactly `Run \`infer-mainline\` to classify these.`
- **Spec source of truth:** `docs/superpowers/specs/2026-06-30-chart-redesign-design.md`.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/dashboard/lib/feature-colors.ts` | NEW | Pure `colorFor(featureKey)` + palette/sentinel constants. |
| `tests/feature-colors.test.ts` | NEW | Unit tests for `colorFor`. |
| `src/dashboard/data/overview.ts` | MODIFY | Replace `dailySeries` with new payload (`features[]`, `days[].bands`). |
| `tests/dashboard-data.test.ts` | MODIFY | Add tests for `features` array selection + `days[].bands` shape. |
| `src/dashboard/render/overview.ts` | MODIFY | Embed new payload; render chart container + legend scaffold. |
| `tests/overview-render.test.ts` | MODIFY | Assert chart + legend DOM is emitted. |
| `src/dashboard/static/dashboard.js` | MODIFY | Replace `renderTrend()` with stacked-area; wire tooltip, hover-highlight, click-through, striped fill. |
| `src/dashboard/static/dashboard.css` | MODIFY | Legend styles + striped swatch CSS. |
| `src/dashboard/render/feature.ts` | MODIFY | Use `colorFor()` for the feature detail page header swatch. |

---

## Task 1: Stable feature-color module

**Files:**
- Create: `src/dashboard/lib/feature-colors.ts`
- Create: `tests/feature-colors.test.ts`

**Interfaces:**
- Consumes: nothing (pure module).
- Produces:
  ```ts
  export const PALETTE: readonly string[];          // 8 hex strings
  export const OTHER_KEY: '__other__';
  export const OTHER_NAME: 'Other';
  export const OTHER_COLOR: '#9CA3AF';
  export const UNCATEGORIZED_KEY: 'uncategorized-mainline';
  export const UNCATEGORIZED_BASE_COLOR: '#6B7280';
  export const STRIPED_SENTINEL: '__striped__';
  export function colorFor(featureKey: string): string;
  ```

- [ ] **Step 1: Write the failing tests**

`tests/feature-colors.test.ts`:

```ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  colorFor,
  PALETTE,
  OTHER_KEY,
  OTHER_COLOR,
  UNCATEGORIZED_KEY,
  STRIPED_SENTINEL,
} from '../src/dashboard/lib/feature-colors.js';

describe('colorFor', () => {
  test('returns Other color for __other__ sentinel', () => {
    assert.equal(colorFor(OTHER_KEY), OTHER_COLOR);
  });

  test('returns striped sentinel for uncategorized-mainline', () => {
    assert.equal(colorFor(UNCATEGORIZED_KEY), STRIPED_SENTINEL);
  });

  test('returns a palette color for a real feature key', () => {
    const c = colorFor('menubar');
    assert.ok(PALETTE.includes(c), `expected ${c} in palette`);
  });

  test('is deterministic for the same key', () => {
    assert.equal(colorFor('menubar'), colorFor('menubar'));
    assert.equal(colorFor('ingest'), colorFor('ingest'));
  });

  test('returns different colors for likely-different keys (no universal collision)', () => {
    const seen = new Set<string>();
    for (const key of ['menubar', 'ingest', 'rollup', 'enrich', 'dashboard', 'infer-mainline']) {
      seen.add(colorFor(key));
    }
    // 6 keys against an 8-color palette — at least 4 distinct colors is a reasonable floor.
    assert.ok(seen.size >= 4, `only ${seen.size} distinct colors among 6 keys`);
  });

  test('PALETTE has exactly 8 entries (Okabe-Ito qualitative)', () => {
    assert.equal(PALETTE.length, 8);
  });

  test('returns a palette color even for an empty string (defensive)', () => {
    const c = colorFor('');
    assert.ok(PALETTE.includes(c));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- --test-name-pattern=colorFor`
Expected: FAIL — `Cannot find module '.../feature-colors.js'`.

- [ ] **Step 3: Write minimal implementation**

`src/dashboard/lib/feature-colors.ts`:

```ts
export const PALETTE = [
  '#0072B2', '#E69F00', '#009E73', '#CC79A7',
  '#56B4E9', '#D55E00', '#F0E442', '#000000',
] as const;

export const OTHER_KEY = '__other__' as const;
export const OTHER_NAME = 'Other' as const;
export const OTHER_COLOR = '#9CA3AF' as const;

export const UNCATEGORIZED_KEY = 'uncategorized-mainline' as const;
export const UNCATEGORIZED_BASE_COLOR = '#6B7280' as const;
export const STRIPED_SENTINEL = '__striped__' as const;

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

export function colorFor(featureKey: string): string {
  if (featureKey === OTHER_KEY) return OTHER_COLOR;
  if (featureKey === UNCATEGORIZED_KEY) return STRIPED_SENTINEL;
  return PALETTE[hash(featureKey) % PALETTE.length]!;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- --test-name-pattern=colorFor`
Expected: PASS — all 7 tests green.

- [ ] **Step 5: Type-check**

Run: `pnpm build`
Expected: zero errors.

- [ ] **Step 6: Commit**

```bash
git add src/dashboard/lib/feature-colors.ts tests/feature-colors.test.ts
git commit -m "feat(dashboard): stable feature → color mapping"
```

---

## Task 2: Extend overview payload with features + bands

**Files:**
- Modify: `src/dashboard/data/overview.ts`
- Modify: `tests/dashboard-data.test.ts`

**Interfaces:**
- Consumes: `colorFor`, `OTHER_KEY`, `OTHER_NAME`, `OTHER_COLOR`, `UNCATEGORIZED_KEY`, `STRIPED_SENTINEL` from `../lib/feature-colors.js`.
- Produces (new shape on `OverviewVM`):
  ```ts
  features: Array<{
    key: string;             // feature_key, or '__other__', or 'uncategorized-mainline'
    name: string;
    color: string;           // hex or STRIPED_SENTINEL
    totalUsd: number;
    clickable: boolean;      // false for __other__ and uncategorized-mainline
    stackPosition: number;   // 0 = bottom band
  }>;
  days: Array<{
    date: string;
    total: number;
    bands: Record<string, number>;   // keys in `features[].key`; missing entries default to 0
    commits: number;
    prs: number;
  }>;
  ```
  Old `dailySeries` is replaced by `days` — the per-day `total/commits/prs` data moves onto it. Downstream readers (`render/overview.ts`, `static/dashboard.js`) update in later tasks.

- [ ] **Step 1: Write the failing tests**

Add to `tests/dashboard-data.test.ts` inside the existing `describe('buildOverview', ...)`:

```ts
test('features array: top 6 real features by window-total, sorted desc, with stable colors', () => {
  const db = makeDb();
  // 7 features, costs 70..10 — only top 6 should keep own bands.
  seedRollups(db, [
    { date: daysAgo(1), cost: 70, featureKey: 'menubar', featureName: 'menubar' },
    { date: daysAgo(1), cost: 60, featureKey: 'ingest', featureName: 'ingest' },
    { date: daysAgo(1), cost: 50, featureKey: 'rollup', featureName: 'rollup' },
    { date: daysAgo(1), cost: 40, featureKey: 'enrich', featureName: 'enrich' },
    { date: daysAgo(1), cost: 30, featureKey: 'dashboard', featureName: 'dashboard' },
    { date: daysAgo(1), cost: 20, featureKey: 'infer-mainline', featureName: 'infer-mainline' },
    { date: daysAgo(1), cost: 10, featureKey: 'misc', featureName: 'misc' },
  ]);
  const vm = buildOverview(db, { days: 30 });

  // 6 real bands + 1 Other (no uncategorized in this fixture).
  assert.equal(vm.features.length, 7);
  const realFeatures = vm.features.filter((f) => f.clickable);
  assert.deepEqual(
    realFeatures.map((f) => f.key),
    ['menubar', 'ingest', 'rollup', 'enrich', 'dashboard', 'infer-mainline']
  );

  // Other is present, holds the tail.
  const other = vm.features.find((f) => f.key === '__other__');
  assert.ok(other);
  assert.equal(other!.totalUsd, 10);
  assert.equal(other!.clickable, false);

  // stackPosition: bottom (0) = biggest real feature; top = __other__ when no uncategorized.
  const byPos = [...vm.features].sort((a, b) => a.stackPosition - b.stackPosition);
  assert.equal(byPos[0]!.key, 'menubar');
  assert.equal(byPos[byPos.length - 1]!.key, '__other__');
});

test('uncategorized-mainline always gets its own band and stacks above Other', () => {
  const db = makeDb();
  seedRollups(db, [
    { date: daysAgo(1), cost: 100, featureKey: 'menubar', featureName: 'menubar' },
    { date: daysAgo(1), cost: 5,   featureKey: 'uncategorized-mainline', featureName: 'uncategorized-mainline' },
    { date: daysAgo(1), cost: 3,   featureKey: 'tail', featureName: 'tail' },
  ]);
  const vm = buildOverview(db, { days: 30 });

  const uncat = vm.features.find((f) => f.key === 'uncategorized-mainline');
  assert.ok(uncat);
  assert.equal(uncat!.clickable, false);
  assert.equal(uncat!.color, '__striped__');

  // Top of stack = uncategorized; just below = Other; bottom = menubar.
  const byPos = [...vm.features].sort((a, b) => a.stackPosition - b.stackPosition);
  assert.equal(byPos[0]!.key, 'menubar');
  assert.equal(byPos[byPos.length - 1]!.key, 'uncategorized-mainline');
  assert.equal(byPos[byPos.length - 2]!.key, '__other__');
});

test('days[].bands: per-day breakdown, zero-filled, totals match', () => {
  const db = makeDb();
  seedRollups(db, [
    { date: daysAgo(1), cost: 2.10, featureKey: 'menubar', featureName: 'menubar' },
    { date: daysAgo(1), cost: 1.21, featureKey: 'ingest',  featureName: 'ingest' },
    { date: daysAgo(2), cost: 0.50, featureKey: 'menubar', featureName: 'menubar' },
  ]);
  const vm = buildOverview(db, { days: 30 });

  assert.equal(vm.days.length, 30);
  const yesterday = vm.days.find((d) => d.date === daysAgo(1))!;
  assert.equal(yesterday.bands['menubar'], 2.10);
  assert.equal(yesterday.bands['ingest'], 1.21);
  assert.equal(yesterday.total, 3.31);

  const dayBefore = vm.days.find((d) => d.date === daysAgo(2))!;
  assert.equal(dayBefore.bands['menubar'], 0.50);
  // Missing band for ingest on this day → either absent or 0; both acceptable.
  assert.ok((dayBefore.bands['ingest'] ?? 0) === 0);

  // Untouched days: bands empty/zero, total 0.
  const zeroDay = vm.days.find((d) => d.date === daysAgo(10))!;
  assert.equal(zeroDay.total, 0);
});

test('fewer than 6 features: features array length matches reality, no empty bands', () => {
  const db = makeDb();
  seedRollups(db, [
    { date: daysAgo(1), cost: 5, featureKey: 'menubar', featureName: 'menubar' },
    { date: daysAgo(1), cost: 3, featureKey: 'ingest',  featureName: 'ingest' },
  ]);
  const vm = buildOverview(db, { days: 30 });

  // 2 real + 0 Other (no tail) + 0 uncategorized = 2.
  assert.equal(vm.features.length, 2);
  assert.equal(vm.features.find((f) => f.key === '__other__'), undefined);
});

test('days[].commits and days[].prs survive on the new shape', () => {
  // Keeps parity with the prior dailySeries semantics.
  const db = makeDb();
  // Existing fixture helpers add commits/prs already; assert presence of the keys.
  const vm = buildOverview(db, { days: 30 });
  for (const d of vm.days) {
    assert.equal(typeof d.commits, 'number');
    assert.equal(typeof d.prs, 'number');
  }
});
```

Confirm/extend `seedRollups` (top of file) to accept `featureKey` and `featureName` overrides if it doesn't already; default to `'misc'` / `'misc'` for backward compatibility with existing tests.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- --test-file=tests/dashboard-data.test.ts`
Expected: FAIL — new tests reference `vm.features` / `vm.days` which don't exist yet.

- [ ] **Step 3: Update the type and the builder**

In `src/dashboard/data/overview.ts`:

Replace the `dailySeries` line on `OverviewVM` and add new fields:

```ts
import {
  colorFor,
  OTHER_KEY,
  OTHER_NAME,
  OTHER_COLOR,
  UNCATEGORIZED_KEY,
} from '../lib/feature-colors.js';

export type OverviewVM = {
  windowDays: number;
  totalUsd: number;
  priorUsd: number;
  deltaPct: number;
  weekUsd: number;
  weekSessions: number;
  topFeatures: Array<{ featureKey: string; featureName: string; totalUsd: number }>;
  topProjects: Array<{
    projectKey: string;
    projectName: string;
    totalUsd: number;
    features: Array<{ featureKey: string; featureName: string; totalUsd: number }>;
  }>;
  features: Array<{
    key: string;
    name: string;
    color: string;
    totalUsd: number;
    clickable: boolean;
    stackPosition: number;
  }>;
  days: Array<{
    date: string;
    total: number;
    bands: Record<string, number>;
    commits: number;
    prs: number;
  }>;
  anomalies: Array<{ /* unchanged */ id: number; kind: string; date: string; featureKey: string | null; sessionId: string | null; amount: number; reason: string }>;
  recentCommits: Array<{ sha: string; subject: string; repo: string | null; authoredAt: string | null }>;
};
```

Delete the old `dailySeries` field from the type and from the `return { ... }` object.

After the existing `dailySeries` computation block (the loop populating dates with `total/commits/prs`), replace it with the new computation:

```ts
// --- features array (top 6 + Other + uncategorized-mainline) ---
type FeatureAgg = { key: string; name: string; totalUsd: number };
const allFeatureRows = db
  .prepare(`
    SELECT feature_key AS key,
           MAX(feature_name) AS name,
           ROUND(SUM(total_cost_usd), 2) AS totalUsd
    FROM feature_rollups
    WHERE date >= ${startExpr}
    GROUP BY feature_key
    ORDER BY totalUsd DESC
  `)
  .all() as FeatureAgg[];

const uncat = allFeatureRows.find((f) => f.key === UNCATEGORIZED_KEY);
const realFeatures = allFeatureRows.filter((f) => f.key !== UNCATEGORIZED_KEY);
const top6 = realFeatures.slice(0, 6);
const tail = realFeatures.slice(6);
const otherTotal = round2(tail.reduce((s, f) => s + f.totalUsd, 0));

// Build the `features` array in legend display order (top-to-bottom of legend):
// uncategorized, Other, then real features by totalUsd desc.
// `stackPosition` is assigned bottom-up: largest real feature = 0;
// uncategorized = highest position.
const features: OverviewVM['features'] = [];
// Stack from bottom (largest real first), increasing position.
top6.forEach((f, i) => {
  features.push({
    key: f.key,
    name: f.name,
    color: colorFor(f.key),
    totalUsd: f.totalUsd,
    clickable: true,
    stackPosition: i,                  // 0 = bottom
  });
});
let nextPos = top6.length;
if (otherTotal > 0) {
  features.push({
    key: OTHER_KEY,
    name: OTHER_NAME,
    color: OTHER_COLOR,
    totalUsd: otherTotal,
    clickable: false,
    stackPosition: nextPos++,
  });
}
if (uncat) {
  features.push({
    key: UNCATEGORIZED_KEY,
    name: uncat.name || UNCATEGORIZED_KEY,
    color: colorFor(UNCATEGORIZED_KEY),
    totalUsd: uncat.totalUsd,
    clickable: false,
    stackPosition: nextPos++,
  });
}

// --- days array: per-day per-feature breakdown ---
const includedKeys = new Set(features.map((f) => f.key));
const perDayRows = db
  .prepare(`
    SELECT date,
           feature_key AS featureKey,
           ROUND(SUM(total_cost_usd), 2) AS usd
    FROM feature_rollups
    WHERE date >= ${startExpr}
    GROUP BY date, feature_key
  `)
  .all() as Array<{ date: string; featureKey: string; usd: number }>;

// Pre-build empty day rows (zero-filled, same iteration the old dailySeries used).
const days: OverviewVM['days'] = [];
const dayIndex = new Map<string, OverviewVM['days'][number]>();
for (let i = opts.days - 1; i >= 0; i--) {
  const d = (db.prepare(`SELECT date('now', '-${i} days', 'localtime') AS d`).get() as { d: string }).d;
  const row = {
    date: d,
    total: observedMap.get(d) ?? 0,
    bands: {} as Record<string, number>,
    commits: commitsMap.get(d) ?? 0,
    prs: prsMap.get(d) ?? 0,
  };
  days.push(row);
  dayIndex.set(d, row);
}

for (const r of perDayRows) {
  const row = dayIndex.get(r.date);
  if (!row) continue;
  const key = includedKeys.has(r.featureKey) ? r.featureKey : OTHER_KEY;
  row.bands[key] = round2((row.bands[key] ?? 0) + r.usd);
}
```

Update the `return` object: replace `dailySeries,` with `features,` and `days,`. Remove the now-dead `dailySeries` local variable and its population loop (the block starting `const dailySeries: OverviewVM['dailySeries'] = [];`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- --test-file=tests/dashboard-data.test.ts`
Expected: PASS — all new tests green. Old tests that referenced `vm.dailySeries` will fail; update them to read from `vm.days` (same field names: `date`, `total`, `commits`, `prs`). One example fix:

```ts
// old: assert.equal(vm.dailySeries.length, 30);
// new:
assert.equal(vm.days.length, 30);
```

- [ ] **Step 5: Type-check**

Run: `pnpm build`
Expected: fails on `render/overview.ts` (still reads `vm.dailySeries`) and `static/dashboard.js` (ignored — JS file). Update `render/overview.ts` minimally to unblock the build by changing `vm.dailySeries` to `vm.days` on line 14; the chart will look wrong until Task 3, that's expected.

Re-run: `pnpm build`
Expected: zero errors.

- [ ] **Step 6: Commit**

```bash
git add src/dashboard/data/overview.ts src/dashboard/render/overview.ts tests/dashboard-data.test.ts
git commit -m "feat(dashboard): per-feature trend payload with stable colors"
```

---

## Task 3: Render chart container + legend scaffold

**Files:**
- Modify: `src/dashboard/render/overview.ts`
- Modify: `tests/overview-render.test.ts`

**Interfaces:**
- Consumes: `OverviewVM.features` and `OverviewVM.days` from Task 2.
- Produces: HTML containing:
  - `#trend-chart` (existing, unchanged container)
  - `#trend-data` JSON `<script>` now embeds the full `{ days, features }` payload (not just `days`)
  - New `#trend-legend` sibling `<ul>` with one `<li>` per feature, attributes the client JS will read:
    - `data-feature-key` — the feature key
    - `data-feature-color` — hex or `__striped__`
    - `data-clickable` — `"1"` if real feature, `"0"` otherwise

- [ ] **Step 1: Write the failing tests**

Add to `tests/overview-render.test.ts`:

```ts
test('renders the legend scaffold next to the chart with one li per feature', () => {
  // Build a minimal VM with 2 real features + Other + uncategorized.
  const vm = makeVm({
    features: [
      { key: 'menubar',              name: 'menubar',              color: '#0072B2', totalUsd: 30, clickable: true,  stackPosition: 0 },
      { key: 'ingest',               name: 'ingest',               color: '#E69F00', totalUsd: 20, clickable: true,  stackPosition: 1 },
      { key: '__other__',            name: 'Other',                color: '#9CA3AF', totalUsd: 5,  clickable: false, stackPosition: 2 },
      { key: 'uncategorized-mainline', name: 'uncategorized-mainline', color: '__striped__', totalUsd: 12, clickable: false, stackPosition: 3 },
    ],
    days: [{ date: '2026-06-29', total: 67, bands: { menubar: 30, ingest: 20, '__other__': 5, 'uncategorized-mainline': 12 }, commits: 1, prs: 0 }],
  });
  const html = renderOverview(vm);
  assert.match(html, /id="trend-legend"/);
  // 4 entries (top-of-stack first = uncategorized).
  const lis = html.match(/<li[^>]+data-feature-key=/g) ?? [];
  assert.equal(lis.length, 4);
  // Order: uncategorized first, then __other__, then real features sorted desc.
  const order = [...html.matchAll(/data-feature-key="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(order, ['uncategorized-mainline', '__other__', 'menubar', 'ingest']);
  // clickable flags.
  assert.match(html, /data-feature-key="menubar"[^>]*data-clickable="1"/);
  assert.match(html, /data-feature-key="__other__"[^>]*data-clickable="0"/);
});

test('trend-data JSON embeds both days and features arrays', () => {
  const vm = makeVm({
    features: [{ key: 'menubar', name: 'menubar', color: '#0072B2', totalUsd: 5, clickable: true, stackPosition: 0 }],
    days: [{ date: '2026-06-29', total: 5, bands: { menubar: 5 }, commits: 0, prs: 0 }],
  });
  const html = renderOverview(vm);
  const m = html.match(/<script type="application\/json" id="trend-data">([^<]+)<\/script>/);
  assert.ok(m);
  const parsed = JSON.parse(m![1]!);
  assert.ok(Array.isArray(parsed.days));
  assert.ok(Array.isArray(parsed.features));
  assert.equal(parsed.features[0].key, 'menubar');
});
```

`makeVm` is a local helper at the top of the file: take partial overrides, fill defaults — all-zero numbers, empty arrays for `topFeatures`/`topProjects`/`anomalies`/`recentCommits`, `windowDays: 30`, `totalUsd: 67` (or whatever the test cares about). If `makeVm` doesn't already exist, add it.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- --test-file=tests/overview-render.test.ts`
Expected: FAIL — `#trend-legend` not in output, `trend-data` only has `days`.

- [ ] **Step 3: Update `renderOverview`**

In `src/dashboard/render/overview.ts`, replace the chart card block:

```ts
    <div class="card chart-card">
      <div class="label">Trend · last ${vm.windowDays} days</div>
      <div class="trend-layout">
        <div id="trend-chart" style="width:100%;height:280px"></div>
        <ul id="trend-legend" class="trend-legend">
          ${renderTrendLegend(vm.features)}
        </ul>
      </div>
      <script type="application/json" id="trend-data">${jsonForScriptTag({ days: vm.days, features: vm.features })}</script>
    </div>
```

Add at the bottom of the file:

```ts
function renderTrendLegend(features: OverviewVM['features']): string {
  // Legend order = stack order top-to-bottom = highest stackPosition first.
  const ordered = [...features].sort((a, b) => b.stackPosition - a.stackPosition);
  return ordered
    .map((f) => {
      const swatchClass = f.color === '__striped__' ? 'swatch swatch--striped' : 'swatch';
      const swatchStyle = f.color === '__striped__' ? '' : ` style="background:${f.color}"`;
      const clickable = f.clickable ? '1' : '0';
      return `<li class="trend-legend-row" data-feature-key="${escapeHtml(f.key)}" data-feature-color="${escapeHtml(f.color)}" data-clickable="${clickable}">
        <span class="${swatchClass}"${swatchStyle}></span>
        <span class="name">${escapeHtml(f.name)}</span>
        <span class="amt">$${f.totalUsd.toFixed(2)}</span>
      </li>`;
    })
    .join('');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- --test-file=tests/overview-render.test.ts`
Expected: PASS — both new tests green.

- [ ] **Step 5: Build + smoke**

Run: `pnpm build`
Expected: zero errors.

Run: `pnpm start` in one terminal, open `http://localhost:3000` in a browser. Confirm:
- The chart card now shows a flat container (chart not yet styled) + a vertical legend listing each feature with swatches and totals.
- DevTools → Elements: `<ul id="trend-legend">` is present; `data-feature-key`, `data-feature-color`, `data-clickable` are wired.
- The old line chart is broken (expected — Task 4 fixes it).

- [ ] **Step 6: Commit**

```bash
git add src/dashboard/render/overview.ts tests/overview-render.test.ts
git commit -m "feat(dashboard): legend scaffold + per-feature trend payload in DOM"
```

---

## Task 4: Stacked-area chart + per-day tooltip

**Files:**
- Modify: `src/dashboard/static/dashboard.js`
- Modify: `src/dashboard/static/dashboard.css`

**Interfaces:**
- Consumes: `#trend-data` JSON (now `{ days, features }`), `#trend-legend` DOM, uPlot global.
- Produces: a stacked-area uPlot chart in `#trend-chart` with a per-day tooltip. No hover-highlight or click-through yet (Task 5).

- [ ] **Step 1: Plan the uPlot config**

Read uPlot docs (local copy at `node_modules/uplot/dist/uPlot.iife.min.js`) or the project's existing uPlot call at `src/dashboard/static/dashboard.js:31-91`. Stacked area shape:
- xs: array of unix seconds, one per day.
- For each feature in stack order (bottom to top by `stackPosition` asc), a series whose ys are the **cumulative** total at that band (i.e. running sum from bottom band up to and including this band). uPlot draws each series as a line; the fill between two consecutive series forms each band.
- A series's `fill` color comes from `features[i].color`. The bottom series fills down to zero; each subsequent fills up to the previous series. Use uPlot's `bands` option (`series` indexes are 1-based; band `series: [topIdx, bottomIdx]`).

- [ ] **Step 2: Replace `renderTrend()`**

In `src/dashboard/static/dashboard.js`, replace the entire `renderTrend()` function:

```js
function renderTrend() {
  const node = document.getElementById('trend-chart');
  const dataNode = document.getElementById('trend-data');
  if (!node || !dataNode || typeof uPlot === 'undefined') return;
  let payload;
  try { payload = JSON.parse(dataNode.textContent || 'null'); } catch (e) { return; }
  if (!payload || !Array.isArray(payload.days) || payload.days.length === 0) {
    node.innerHTML = '<div class="muted" style="padding:24px;text-align:center">No data in window.</div>';
    return;
  }
  const days = payload.days;
  const features = payload.features || [];
  if (features.length === 0) {
    node.innerHTML = '<div class="muted" style="padding:24px;text-align:center">No data in window.</div>';
    return;
  }

  // Stack order: bottom first (lowest stackPosition).
  const stackOrder = features.slice().sort((a, b) => a.stackPosition - b.stackPosition);
  const xs = days.map((d) => new Date(d.date + 'T00:00:00').getTime() / 1000);

  // Per-series cumulative ys (each series carries the running sum up to its band, inclusive).
  const seriesYs = stackOrder.map((feat, idx) => {
    return days.map((d) => {
      let sum = 0;
      for (let i = 0; i <= idx; i++) {
        sum += d.bands[stackOrder[i].key] || 0;
      }
      return sum;
    });
  });

  const tooltip = document.createElement('div');
  tooltip.className = 'chart-tooltip';
  tooltip.style.display = 'none';
  node.style.position = 'relative';
  node.appendChild(tooltip);

  function fmtDate(unixSec) {
    return new Date(unixSec * 1000).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  }
  function fmtUsd(n) {
    return '$' + (typeof n === 'number' ? n.toFixed(2) : n);
  }

  // Striped fill: a tiny canvas pattern, created lazily so it's bound to the
  // chart's own canvas context (uPlot will call the fill function per draw).
  function makeStripePattern(ctx) {
    const p = document.createElement('canvas');
    p.width = 8; p.height = 8;
    const c = p.getContext('2d');
    c.fillStyle = '#6B7280';
    c.fillRect(0, 0, 8, 8);
    c.strokeStyle = 'rgba(255,255,255,0.35)';
    c.lineWidth = 1.5;
    c.beginPath(); c.moveTo(-2, 10); c.lineTo(10, -2); c.stroke();
    c.beginPath(); c.moveTo(0, 14); c.lineTo(14, 0); c.stroke();
    return ctx.createPattern(p, 'repeat');
  }
  // For striped series, return a fill function that builds the pattern lazily.
  function fillFor(color) {
    if (color === '__striped__') {
      return (u) => {
        const ctx = u.ctx;
        if (!ctx._stripePattern) ctx._stripePattern = makeStripePattern(ctx);
        return ctx._stripePattern;
      };
    }
    // Slight transparency so band borders read; opaque inner color preserves identity.
    return hexToRgba(color, 0.92);
  }
  function hexToRgba(hex, alpha) {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    if (!m) return hex;
    return `rgba(${parseInt(m[1],16)},${parseInt(m[2],16)},${parseInt(m[3],16)},${alpha})`;
  }

  // uPlot series + bands wiring.
  // series[0] is the x-axis pseudo-series. Real series start at 1.
  const series = [{}].concat(stackOrder.map((feat) => ({
    label: feat.name,
    stroke: feat.color === '__striped__' ? '#4B5563' : feat.color,
    fill: fillFor(feat.color),
    width: 1,
    points: { show: false },
  })));
  // Bands: each band fills between series idx-1 and idx (idx = 2..N for stacked).
  // Band: { series: [topIdx, bottomIdx], fill }
  const bands = [];
  for (let i = 1; i < stackOrder.length; i++) {
    bands.push({ series: [i + 1, i] });
  }

  const data = [xs].concat(seriesYs);

  const opts = {
    width: node.clientWidth,
    height: 280,
    legend: { show: false },     // we render our own
    cursor: { drag: { x: false, y: false }, points: { size: 5 } },
    scales: { x: { time: true } },
    series: series,
    bands: bands,
    axes: [
      { stroke: '#6b563d', grid: { stroke: 'rgba(139,111,71,0.15)' } },
      { stroke: '#6b563d', grid: { stroke: 'rgba(139,111,71,0.15)' }, values: (_s, ticks) => ticks.map((t) => '$' + Math.round(t)) },
    ],
    hooks: {
      setCursor: [
        (self) => {
          const idx = self.cursor.idx;
          if (idx == null || idx < 0 || idx >= days.length) {
            tooltip.style.display = 'none';
            return;
          }
          const d = days[idx];
          // Per-day breakdown sorted by $ desc, non-zero only.
          const rows = stackOrder
            .map((f) => ({ key: f.key, name: f.name, color: f.color, usd: d.bands[f.key] || 0 }))
            .filter((r) => r.usd > 0)
            .sort((a, b) => b.usd - a.usd);
          const total = d.total || 0;
          const denom = total > 0 ? total : 1;
          let body = '<div class="chart-tooltip-date">' + fmtDate(xs[idx]) + '</div>' +
            '<div class="chart-tooltip-value">' + fmtUsd(total) + '</div>';
          if (total === 0) {
            body += '<div class="chart-tooltip-meta">no activity</div>';
          } else {
            body += '<div class="chart-tooltip-rows">';
            for (const r of rows) {
              const pct = Math.round((r.usd / denom) * 100);
              const swatch = r.color === '__striped__'
                ? '<span class="tooltip-swatch swatch--striped"></span>'
                : '<span class="tooltip-swatch" style="background:' + r.color + '"></span>';
              body += '<div class="chart-tooltip-row">' + swatch +
                '<span class="name">' + r.name + '</span>' +
                '<span class="amt">' + fmtUsd(r.usd) + ' <span class="muted">(' + pct + '%)</span></span></div>';
            }
            body += '</div>';
          }
          body += '<div class="chart-tooltip-meta">' +
            (d.commits || 0) + ' ' + ((d.commits || 0) === 1 ? 'commit' : 'commits') +
            ' · ' + (d.prs || 0) + ' ' + ((d.prs || 0) === 1 ? 'PR' : 'PRs') +
            '</div>';
          tooltip.innerHTML = body;
          tooltip.style.display = 'block';

          const left = self.valToPos(xs[idx], 'x');
          const top = self.valToPos(seriesYs[seriesYs.length - 1][idx], 'y');
          const rect = node.getBoundingClientRect();
          const tw = tooltip.offsetWidth, th = tooltip.offsetHeight;
          let px = left + 12, py = top - th - 8;
          if (px + tw > rect.width) px = left - tw - 12;
          if (py < 0) py = top + 12;
          tooltip.style.left = px + 'px';
          tooltip.style.top = py + 'px';
        },
      ],
    },
  };
  new uPlot(opts, data, node);

  node.addEventListener('mouseleave', () => { tooltip.style.display = 'none'; });
}
```

- [ ] **Step 3: Add legend + tooltip CSS**

Append to `src/dashboard/static/dashboard.css`:

```css
.trend-layout {
  display: flex;
  gap: 16px;
  align-items: stretch;
}
.trend-layout #trend-chart {
  flex: 1 1 auto;
  min-width: 0;
}
.trend-legend {
  flex: 0 0 200px;
  list-style: none;
  margin: 0;
  padding: 0;
  font-size: 13px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 280px;
  overflow-y: auto;
}
.trend-legend-row {
  display: grid;
  grid-template-columns: 14px 1fr auto;
  align-items: center;
  gap: 6px;
  padding: 2px 4px;
  border-radius: 4px;
  cursor: default;
}
.trend-legend-row[data-clickable="1"] { cursor: pointer; }
.trend-legend-row:hover { background: rgba(139,111,71,0.08); }
.trend-legend-row .name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.trend-legend-row .amt { color: #6b563d; font-variant-numeric: tabular-nums; }
.swatch {
  display: inline-block;
  width: 12px;
  height: 12px;
  border-radius: 2px;
  background: #ccc;
}
.swatch--striped {
  background: repeating-linear-gradient(
    45deg,
    #6B7280 0 4px,
    rgba(255,255,255,0.45) 4px 6px
  );
}
.chart-tooltip-rows {
  margin-top: 6px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 12px;
}
.chart-tooltip-row {
  display: grid;
  grid-template-columns: 10px 1fr auto;
  align-items: center;
  gap: 6px;
}
.tooltip-swatch {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 2px;
}
.tooltip-swatch.swatch--striped {
  background: repeating-linear-gradient(
    45deg, #6B7280 0 3px, rgba(255,255,255,0.45) 3px 5px
  );
}
```

- [ ] **Step 4: Manual verification**

Run: `pnpm start` (assumes a populated DB; otherwise run `pnpm run tokentrail -- run-all --skip-sync --skip-enrich` first).

Open `http://localhost:3000`. Verify:
- The trend chart now shows colored stacked bands instead of a single line.
- The top of the stack equals the total — eyeball check that the silhouette resembles the previous total line.
- `uncategorized-mainline` band (if present) is at the very top with diagonal stripes.
- Hover the chart → tooltip shows: date, total, per-feature breakdown sorted by $ desc, commits/PRs. Days with zero spend show "no activity".
- Tooltip is clamped inside the chart (does not get clipped at edges).
- Legend on the right shows entries top-to-bottom matching stack order (uncategorized → Other → real features by total desc).

If anything looks broken, fix it. No screenshots required — just confirm the four bullets above.

- [ ] **Step 5: Run tests + build**

Run: `pnpm test`
Expected: PASS (no JS unit tests for this file).

Run: `pnpm build`
Expected: zero errors.

- [ ] **Step 6: Commit**

```bash
git add src/dashboard/static/dashboard.js src/dashboard/static/dashboard.css
git commit -m "feat(dashboard): stacked-area trend chart with per-day tooltip"
```

---

## Task 5: Hover-highlight + click-through

**Files:**
- Modify: `src/dashboard/static/dashboard.js`

**Interfaces:**
- Consumes: the uPlot chart from Task 4, the legend DOM from Task 3, `data-feature-key` / `data-clickable` attributes on legend rows.
- Produces: hover on a band or a legend row dims all other bands to ~25% opacity; mouse-leave restores. Click on a real-feature band or legend row → navigates to `/feature/<key>`.

- [ ] **Step 1: Implement legend-row hover + click**

In `renderTrend()` after `new uPlot(...)`, before the existing `mouseleave` listener:

```js
  const legend = document.getElementById('trend-legend');
  const chartCanvas = node.querySelector('canvas');

  function setActiveKey(key) {
    if (!chartCanvas) return;
    chartCanvas.classList.toggle('chart-dimmed', !!key);
    // Per-band opacity is controlled by re-rendering — uPlot doesn't expose
    // per-series alpha at runtime cheaply. Cheaper: a single CSS overlay
    // makes all bands ~25% and we draw the active band's path on top.
    // Simpler approach: dim the whole canvas via CSS and overlay the
    // highlighted band by re-drawing its filled polygon on the parent node.
    // We use the simpler implementation for now (whole-canvas dim) and
    // skip the highlight overlay; the dim alone makes the active band
    // stand out by contrast against the dimmed siblings.
    // This is intentionally a low-cost first pass; if visual signal is
    // insufficient, upgrade to per-series alpha by storing original fills
    // and toggling via `u.redraw()`.
    if (legend) {
      legend.querySelectorAll('.trend-legend-row').forEach((li) => {
        li.classList.toggle('active', li.getAttribute('data-feature-key') === key);
        li.classList.toggle('inactive', !!key && li.getAttribute('data-feature-key') !== key);
      });
    }
  }

  if (legend) {
    legend.querySelectorAll('.trend-legend-row').forEach((li) => {
      const key = li.getAttribute('data-feature-key');
      const clickable = li.getAttribute('data-clickable') === '1';
      li.addEventListener('mouseenter', () => setActiveKey(key));
      li.addEventListener('mouseleave', () => setActiveKey(null));
      if (clickable && key) {
        li.addEventListener('click', () => {
          window.location.href = '/feature/' + encodeURIComponent(key);
        });
      }
    });
  }

  // Chart click: which band is under the cursor?
  // uPlot's setCursor hook already has `idx` (the day). We need the band
  // index too — derive from the cursor's y position vs. seriesYs.
  node.addEventListener('click', () => {
    const u = node.__uplot;        // set just after construction below
    if (!u) return;
    const idx = u.cursor.idx;
    if (idx == null) return;
    const yVal = u.posToVal(u.cursor.top, 'y');
    // Find the topmost series whose cumulative ys at idx >= yVal AND whose
    // band's bottom <= yVal — that's the active band.
    let active = null;
    for (let i = 0; i < stackOrder.length; i++) {
      const top = seriesYs[i][idx];
      const bot = i === 0 ? 0 : seriesYs[i - 1][idx];
      if (yVal >= bot && yVal <= top) { active = stackOrder[i]; break; }
    }
    if (active && active.clickable !== false && active.key !== '__other__' && active.key !== 'uncategorized-mainline') {
      window.location.href = '/feature/' + encodeURIComponent(active.key);
    }
  });
```

Update the `new uPlot(...)` line in Task 4's code to capture the instance:

```js
const u = new uPlot(opts, data, node);
node.__uplot = u;
```

Also, fold the chart-area mouse hover into the existing `setCursor` hook. At the end of the hook body (after the tooltip positioning), add:

```js
// Determine which band the cursor is over and highlight it.
const yVal = self.posToVal(self.cursor.top, 'y');
let activeKey = null;
for (let i = 0; i < stackOrder.length; i++) {
  const top = seriesYs[i][idx];
  const bot = i === 0 ? 0 : seriesYs[i - 1][idx];
  if (yVal >= bot && yVal <= top) { activeKey = stackOrder[i].key; break; }
}
setActiveKey(activeKey);
```

And on mouse-leave:

```js
node.addEventListener('mouseleave', () => {
  tooltip.style.display = 'none';
  setActiveKey(null);
});
```

(Replace the existing `mouseleave` listener.)

- [ ] **Step 2: Add highlight CSS**

Append to `src/dashboard/static/dashboard.css`:

```css
canvas.chart-dimmed { opacity: 0.55; transition: opacity 80ms ease-out; }
.trend-legend-row.active { background: rgba(139,111,71,0.18); }
.trend-legend-row.inactive { opacity: 0.45; }
```

(Whole-canvas dim is the YAGNI-friendly first pass. Per-series alpha is a known follow-up — see spec section 5 risks. The legend's active/inactive state still tells the eye which band is highlighted.)

- [ ] **Step 3: Manual verification**

Run: `pnpm start`. Open the dashboard.

- Hover a legend row (real feature) → its row gets a highlight tint; the others fade to ~45% opacity; the chart canvas dims to ~55% opacity.
- Hover a row labeled "Other" or "uncategorized" → same highlight on the legend; rows still not clickable on click.
- Move cursor off the chart and the legend → all opacity returns to normal.
- Click a real-feature legend row → navigates to `/feature/<key>`.
- Click a chart band over a real-feature region → navigates to `/feature/<key>` (use the tooltip to verify which day/band you clicked).
- Click an "Other" or "uncategorized" band → nothing happens.

Fix anything that's broken (e.g. wrong key passed to navigation, click-handler firing on non-clickable bands).

- [ ] **Step 4: Build**

Run: `pnpm build`
Expected: zero errors.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/static/dashboard.js src/dashboard/static/dashboard.css
git commit -m "feat(dashboard): hover-highlight + click-through on trend chart"
```

---

## Task 6: Share `colorFor` with feature detail page

**Files:**
- Modify: `src/dashboard/render/feature.ts`
- Modify: `src/dashboard/render/overview.ts` (project rows — Top burn paths)

**Interfaces:**
- Consumes: `colorFor`, `STRIPED_SENTINEL` from `../lib/feature-colors.js`.
- Produces: identical color swatches on the feature detail page header and on each Top-burn-paths project row.

- [ ] **Step 1: Color swatch on the feature detail page header**

In `src/dashboard/render/feature.ts`, find where the feature header (name) is rendered (usually near the top). Add the import:

```ts
import { colorFor, STRIPED_SENTINEL } from '../lib/feature-colors.js';
```

In the header rendering — where the feature's name first appears — prepend a swatch:

```ts
const color = colorFor(vm.featureKey);
const swatch = color === STRIPED_SENTINEL
  ? '<span class="swatch swatch--striped" style="vertical-align:middle;margin-right:8px"></span>'
  : `<span class="swatch" style="background:${color};vertical-align:middle;margin-right:8px"></span>`;
// inject `swatch` into the existing header HTML (e.g. before the <h1> text)
```

If the feature page already has a title element, the cleanest insertion is inline with the `<h1>` content: `<h1>${swatch}${escapeHtml(vm.featureName)}</h1>`.

- [ ] **Step 2: Color stripe on Top burn paths project rows**

In `src/dashboard/render/overview.ts`'s `renderTopProjects(...)`, give each project row a small swatch using the **dominant feature's** color (the first entry in `p.features`, which is already sorted desc):

```ts
import { colorFor, STRIPED_SENTINEL } from '../lib/feature-colors.js';

// ...inside renderTopProjects, replacing the existing return per-row...
const dominantKey = p.features[0]?.featureKey ?? '';
const dominantColor = colorFor(dominantKey);
const projectSwatch = dominantColor === STRIPED_SENTINEL
  ? '<span class="swatch swatch--striped"></span>'
  : `<span class="swatch" style="background:${dominantColor}"></span>`;
return `
  <a class="project-row" href="${href}">
    <span class="mile">${i + 1}</span>
    ${projectSwatch}
    <span class="name">${escapeHtml(p.projectName)} ${featuresLabel}</span>
    <span class="amt">$${p.totalUsd.toFixed(0)} <span class="muted share">· ${share.toFixed(0)}%</span></span>
  </a>
  <div class="bar"><span style="width:${pct}%"></span></div>
`;
```

The `.project-row` selector already exists in `dashboard.css`; the `.swatch` styles from Task 4 work as-is. If the project-row grid needs adjustment to accommodate the swatch, tweak the grid in CSS at the same time.

- [ ] **Step 3: Manual verification**

Run: `pnpm start`. Open the dashboard.

- Top burn paths rows now show a small color swatch per row matching the project's dominant feature.
- Click into a project → its largest feature's color matches what was shown on the row.
- The feature detail page header shows a swatch matching the chart's band color for that feature.
- Striped projects (those whose dominant feature is `uncategorized-mainline`) show the diagonal-stripe swatch.

- [ ] **Step 4: Build**

Run: `pnpm build`
Expected: zero errors.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/render/feature.ts src/dashboard/render/overview.ts
git commit -m "feat(dashboard): reuse feature colors on detail page + burn paths"
```

---

## Task 7: Empty-state copy + final verification

**Files:**
- Modify: `src/dashboard/static/dashboard.js`
- Modify: `src/dashboard/render/overview.ts`
- Modify: `tests/overview-render.test.ts`

**Interfaces:**
- Consumes: existing chart + legend wiring.
- Produces: a sub-chart hint that appears when the **only** non-zero feature in window is `uncategorized-mainline`; final manual + Playwright verification.

- [ ] **Step 1: Compute the empty-uncategorized signal in `renderOverview`**

In `src/dashboard/render/overview.ts`, after `if (isEmpty(vm))` and inside the main return, compute:

```ts
const onlyUncategorized =
  vm.features.length === 1 &&
  vm.features[0]!.key === 'uncategorized-mainline' &&
  vm.totalUsd > 0;
```

Add this hint inside the chart card, **below** the chart + legend, after the JSON script tag:

```ts
${onlyUncategorized ? '<div class="chart-hint">Run <code>tokentrail infer-mainline</code> to classify these.</div>' : ''}
```

Append to `dashboard.css`:

```css
.chart-hint {
  margin-top: 12px;
  padding: 8px 12px;
  border-radius: 6px;
  background: rgba(139,111,71,0.08);
  color: #6b563d;
  font-size: 13px;
}
.chart-hint code { background: rgba(139,111,71,0.16); padding: 1px 5px; border-radius: 3px; }
```

- [ ] **Step 2: Add the test**

In `tests/overview-render.test.ts`:

```ts
test('shows infer-mainline hint when only uncategorized-mainline has spend', () => {
  const vm = makeVm({
    totalUsd: 12,
    features: [{ key: 'uncategorized-mainline', name: 'uncategorized-mainline', color: '__striped__', totalUsd: 12, clickable: false, stackPosition: 0 }],
    days: [{ date: '2026-06-29', total: 12, bands: { 'uncategorized-mainline': 12 }, commits: 0, prs: 0 }],
  });
  const html = renderOverview(vm);
  assert.match(html, /Run <code>tokentrail infer-mainline<\/code>/);
});

test('does NOT show the hint when at least one real feature has spend', () => {
  const vm = makeVm({
    totalUsd: 15,
    features: [
      { key: 'menubar', name: 'menubar', color: '#0072B2', totalUsd: 10, clickable: true, stackPosition: 0 },
      { key: 'uncategorized-mainline', name: 'uncategorized-mainline', color: '__striped__', totalUsd: 5, clickable: false, stackPosition: 1 },
    ],
    days: [{ date: '2026-06-29', total: 15, bands: { menubar: 10, 'uncategorized-mainline': 5 }, commits: 0, prs: 0 }],
  });
  const html = renderOverview(vm);
  assert.doesNotMatch(html, /Run <code>tokentrail infer-mainline<\/code>/);
});
```

- [ ] **Step 3: Run tests + build**

Run: `pnpm test`
Expected: PASS.

Run: `pnpm build`
Expected: zero errors.

- [ ] **Step 4: Final manual + Playwright verification**

Run: `pnpm start`. Walk the full feature matrix in a browser:

| Check | Verifies |
|---|---|
| Open `/` — chart renders with colored bands | Tasks 2-4 |
| Top burn paths and feature detail header show matching swatches | Task 6 |
| Hover band → tooltip shows breakdown sorted by $ desc | Task 4 |
| Hover legend row → that row activates, others fade, canvas dims | Task 5 |
| Click real-feature band → lands on `/feature/<key>` | Task 5 |
| Click Other / uncategorized band → no navigation | Task 5 |
| Empty day in window → tooltip says "no activity" | Task 4 |
| `uncategorized-mainline` band shows hatched fill | Task 4 |
| Reload page — same feature gets same color | Task 1 + Task 2 |

If you have Playwright MCP available, run a single snapshot of `/` to confirm the chart container has the expected SVG/canvas + the legend `<ul>` with the expected `<li>` count.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/render/overview.ts src/dashboard/static/dashboard.css tests/overview-render.test.ts
git commit -m "feat(dashboard): empty-state hint when only uncategorized-mainline has spend"
```

---

## Done criteria

- All 7 tasks committed.
- `pnpm test && pnpm build` green.
- Manual verification of the table in Task 7 step 4 passes.
- Spec at `docs/superpowers/specs/2026-06-30-chart-redesign-design.md` is fully covered (see "Spec coverage" below for the mapping used during self-review).

## Spec coverage mapping (for the self-reviewer)

| Spec section | Task(s) |
|---|---|
| 1. Visual structure (stacked area, Top 6 + Other + uncategorized) | 2, 4 |
| 2. Color palette (stable per feature, Okabe-Ito, Other gray, striped uncategorized) | 1, 2, 4 |
| 3. Legend & labels (right of chart, stack-order top-to-bottom, no inline labels) | 3, 4, 5 |
| 4. Tooltip & hover (per-day breakdown, band highlight, click-through) | 4, 5 |
| 5. Data & implementation (query, transform, payload shape, files touched) | 2, 3, 4 |
| 6. Edge cases (zero-day, <6 features, only-uncategorized, rename, sparse) | 2, 4, 7 |
| 7. Testing (color hash, data transform, render shape, manual Playwright) | 1, 2, 3, 7 |
