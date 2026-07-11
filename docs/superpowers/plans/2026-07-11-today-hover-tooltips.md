# Today Page Chart Hover Tooltips Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hover tooltips on both Today-page chart surfaces: full per-project breakdowns on the burn-by-hour bars, and Overview-parity feature-segmented tooltips on the burn-path bars.

**Architecture:** Server embeds two JSON script tags (`#burn-paths-data`, `#hour-burn-data`); the existing `renderBurnPathsSubBars` hydrator lights up unchanged, and a new `renderHourBarTips` builds a second shared body-level tooltip using the same guard/positioning conventions. `jsonForScriptTag` is consolidated into `render/shell.ts` (deleting three private copies).

**Tech Stack:** TypeScript, better-sqlite3, node:test via `node --import tsx --test`, vanilla JS in `dashboard.js`, plain CSS.

**Spec:** `docs/superpowers/specs/2026-07-11-today-hover-tooltips-design.md`

## Global Constraints

- `TodayVM.hourly` stays ALWAYS 24 entries, hours 0–23, zero-filled; entries gain `projects: { name; usd; color }[]` (empty array for zero-spend hours), sorted usd-descending within each hour.
- Project bucketing uses the existing `bucketProject` from `data/overview.js` — no new bucketing logic.
- Colors from the 30-day `projectColors` reference already fetched in `buildTodayVM`; unknown keys fall back to `'#9CA3AF'`.
- Tooltip caps at 6 project rows + a muted `+n more` row.
- The native `title` attribute on `.hour-bar` is REMOVED; the static solid subbar segment STAYS (no-JS fallback).
- Hydrators bail silently on absent/malformed JSON (existing convention).
- The shared tooltip element must have `pointer-events: none` (inherited from `.chart-tooltip`) — it sits over the hovered bar.
- All new date/time SQL uses `'localtime'`.
- Test baseline: `tests/branches.test.ts` has 8 pre-existing failures; only failures outside it count.
- Run tests: `npm test` (all) / `node --import tsx --test <file>` (single).

---

### Task 1: Consolidate `jsonForScriptTag` into shell.ts

**Files:**
- Modify: `src/dashboard/render/shell.ts` (add export at bottom, near `escapeHtml`)
- Modify: `src/dashboard/render/overview.ts:120-122` (delete local copy, import)
- Modify: `src/dashboard/render/project.ts:92-94` (delete local copy, import)
- Modify: `src/dashboard/render/feature.ts:122-124` (delete local copy, import)
- Test: `tests/shell.test.ts` (append)

**Interfaces:**
- Produces: `export function jsonForScriptTag(data: unknown): string` from `render/shell.js` — JSON.stringify with `<` escaped to `<`. Task 3 imports it in `render/today.ts`.

- [ ] **Step 1: Write the failing test**

Append to `tests/shell.test.ts` (it already imports from `../src/dashboard/render/shell.js` — extend that import with `jsonForScriptTag`):

```ts
describe('jsonForScriptTag', () => {
  test('escapes < so payloads cannot close the script tag', () => {
    const out = jsonForScriptTag({ name: '</script><script>alert(1)' });
    assert.equal(out.includes('</script>'), false);
    assert.match(out, /\\u003c\/script\\u003e/);
    assert.deepEqual(JSON.parse(out), { name: '</script><script>alert(1)' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test tests/shell.test.ts`
Expected: FAIL — `jsonForScriptTag` is not exported.

- [ ] **Step 3: Add the export to shell.ts**

Append to `src/dashboard/render/shell.ts` after `escapeHtml`:

```ts
// One canonical copy — inline <script type="application/json"> payloads
// must escape '<' so user data can never close the tag.
export function jsonForScriptTag(data: unknown): string {
  return JSON.stringify(data).replace(/</g, '\\u003c');
}
```

- [ ] **Step 4: Replace the three private copies**

In each of `overview.ts`, `project.ts`, `feature.ts`: delete the local `function jsonForScriptTag(...) {...}` (three identical copies at the lines listed above) and add `jsonForScriptTag` to the existing `import { ... } from './shell.js'` line (each file already imports `escapeHtml` from there).

- [ ] **Step 5: Run tests**

Run: `node --import tsx --test tests/shell.test.ts` — Expected: PASS
Run: `npm test` — Expected: only the 8 known branches.test.ts failures (overview/project/feature render tests confirm behavior unchanged).
Run: `npx tsc --noEmit` — Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/dashboard/render/shell.ts src/dashboard/render/overview.ts src/dashboard/render/project.ts src/dashboard/render/feature.ts tests/shell.test.ts
git commit -m "refactor: one canonical jsonForScriptTag in shell.ts"
```

---

### Task 2: Data — hourly project breakdown + projectFeatureMix pass-through

**Files:**
- Modify: `src/dashboard/data/today.ts`
- Modify: `tests/today-data.test.ts` (append describe; extend `seedEvent`)
- Modify: `tests/project-rows.test.ts` (VM literals gain the new fields)

**Interfaces:**
- Consumes: `bucketProject` from `./overview.js` — `(r: { featureKey: string; featureName: string; repo: string | null }) => { projectKey: string; projectName: string }`; the existing `colorRef` (30-day `projectColors`) already computed in `buildTodayVM`.
- Produces: `TodayVM.hourly: { hour: number; usd: number; projects: { name: string; usd: number; color: string }[] }[]` and `TodayVM.projectFeatureMix: OverviewVM['projectFeatureMix']`. Task 3 renders both.

- [ ] **Step 1: Write the failing tests**

Extend `seedEvent` in `tests/today-data.test.ts` to accept an optional `repo` (add a `repo = null` option and include the column in the INSERT — it currently inserts `id, session_id, timestamp, model, estimated_cost_usd` plus whatever Task-2/3 additions exist; read the current helper and add `repo` analogously). Then append:

```ts
describe('buildTodayVM hourly project breakdown', () => {
  test('per-hour projects sum to the hour total, sorted desc', () => {
    const db = makeDb();
    seedEvent(db, { ts: todayAtLocalHour(9), usd: 1, repo: 'ben/alpha' });
    seedEvent(db, { ts: todayAtLocalHour(9), usd: 4, repo: 'ben/beta' });
    seedEvent(db, { ts: todayAtLocalHour(9), usd: 2, repo: 'ben/beta' });
    const vm = buildTodayVM(db, { nowHour: 10 });
    const h9 = vm.hourly[9]!;
    assert.equal(h9.usd, 7);
    assert.equal(h9.projects.length, 2);
    assert.equal(h9.projects[0]!.name, 'beta');   // $6 first
    assert.equal(h9.projects[0]!.usd, 6);
    assert.equal(h9.projects[1]!.name, 'alpha');
    const rowSum = h9.projects.reduce((s, p) => s + p.usd, 0);
    assert.equal(Math.round(rowSum * 100) / 100, h9.usd);
    assert.ok(h9.projects.every((p) => /^#|^rgb/.test(p.color)));
  });

  test('zero-spend hours have empty projects arrays', () => {
    const db = makeDb();
    seedEvent(db, { ts: todayAtLocalHour(9), usd: 1 });
    const vm = buildTodayVM(db, { nowHour: 10 });
    assert.deepEqual(vm.hourly[3]!.projects, []);
  });

  test('projectFeatureMix is passed through and keyed by topProjects keys', () => {
    const db = makeDb();
    seedEvent(db, { ts: todayAtLocalHour(9), usd: 5 });
    // topProjects derive from feature_rollups — seed one row for today
    // (match the existing color-palette test's fixture pattern in this file).
    db.prepare(
      `INSERT INTO feature_rollups (date, feature_key, feature_name, total_cost_usd, sessions_count)
       VALUES (date('now','localtime'), 'f', 'F', 5, 1)`
    ).run();
    const vm = buildTodayVM(db, { nowHour: 10 });
    assert.ok(Array.isArray(vm.projectFeatureMix));
    const mixKeys = new Set(vm.projectFeatureMix.map((m) => m.projectKey));
    for (const p of vm.topProjects) assert.ok(mixKeys.has(p.key), `mix missing ${p.key}`);
  });
});
```

(If the existing `feature_rollups` INSERT in this file uses different columns, copy that exact fixture instead.)

- [ ] **Step 2: Run to verify failure**

Run: `node --import tsx --test tests/today-data.test.ts`
Expected: FAIL — `projects`/`projectFeatureMix` undefined.

- [ ] **Step 3: Implement in `data/today.ts`**

Extend the type:

```ts
export type TodayVM = {
  // ...existing fields...
  hourly: { hour: number; usd: number; projects: { name: string; usd: number; color: string }[] }[];
  projectFeatureMix: OverviewVM['projectFeatureMix'];
  // ...
};
```

Import `bucketProject` alongside the existing `buildOverview` import from `./overview.js`. In `buildTodayVM`, change the zero-fill to include `projects: []`:

```ts
const hourly: TodayVM['hourly'] = Array.from({ length: 24 }, (_, hour) => ({ hour, usd: 0, projects: [] }));
```

After the existing hourly-totals loop, add the breakdown (uses the `colorRef` map already computed for topProjects re-coloring — reuse the same variable; if it's scoped after this point, hoist it above):

```ts
const hourProjectRows = db
  .prepare(
    `SELECT CAST(strftime('%H', timestamp, 'localtime') AS INTEGER) AS hour,
            COALESCE(inferred_feature_key, 'unattributed') AS featureKey,
            COALESCE(inferred_feature_name, 'Unattributed') AS featureName,
            repo,
            SUM(estimated_cost_usd) AS usd
       FROM usage_events
      WHERE date(timestamp, 'localtime') = date('now', 'localtime')
      GROUP BY hour, featureKey, featureName, repo`
  )
  .all() as Array<{ hour: number; featureKey: string; featureName: string; repo: string | null; usd: number }>;

// Bucket TS-side (same as Overview), re-aggregate per (hour, projectKey).
const perHour = new Map<number, Map<string, { name: string; usd: number; color: string }>>();
for (const r of hourProjectRows) {
  const { projectKey, projectName } = bucketProject(r);
  let bucket = perHour.get(r.hour);
  if (!bucket) { bucket = new Map(); perHour.set(r.hour, bucket); }
  const cur = bucket.get(projectKey);
  if (cur) cur.usd += r.usd;
  else bucket.set(projectKey, { name: projectName, usd: r.usd, color: colorRef[projectKey] ?? '#9CA3AF' });
}
for (const [hour, bucket] of perHour) {
  hourly[hour]!.projects = [...bucket.values()]
    .map((p) => ({ ...p, usd: round2(p.usd) }))
    .sort((a, b) => b.usd - a.usd);
}
```

Add to the returned VM: `projectFeatureMix: overview.projectFeatureMix` (the day-1 overview already computes it) and the extended `hourly`.

- [ ] **Step 4: Fix VM literals in `tests/project-rows.test.ts`**

Every `TodayVM` literal there: `hourly` entries become `({ hour, usd: ..., projects: [] })`, and each literal gains `projectFeatureMix: []`.

- [ ] **Step 5: Run tests**

Run: `npm test` — Expected: only the 8 known failures. `npx tsc --noEmit` — clean.

- [ ] **Step 6: Commit**

```bash
git add src/dashboard/data/today.ts tests/today-data.test.ts tests/project-rows.test.ts
git commit -m "feat: per-project hourly breakdown + projectFeatureMix in TodayVM"
```

---

### Task 3: Render — script tags, data-hour, drop native title

**Files:**
- Modify: `src/dashboard/render/today.ts`
- Modify: `tests/project-rows.test.ts` (extend the module render test)

**Interfaces:**
- Consumes: `jsonForScriptTag` from `./shell.js` (Task 1); `vm.projectFeatureMix` and `vm.hourly[].projects` (Task 2).
- Produces: `#burn-paths-data` and `#hour-burn-data` script tags; `.hour-bar` elements carry `data-hour` and no `title`. Task 4's JS reads exactly these.

- [ ] **Step 1: Extend the render test (failing first)**

In `tests/project-rows.test.ts`, in the "renders strip, sessions, and shipped modules" test, set the fixture's hour-9 entry to `{ hour: 9, usd: 5, projects: [{ name: 'Research', usd: 5, color: '#8b6f47' }] }` and `projectFeatureMix: [{ projectKey: 'research', features: [{ key: 'f', name: 'F', color: '#8b6f47', totalUsd: 17 }] }]`, then add assertions:

```ts
    assert.match(html, /id="burn-paths-data"/);
    assert.match(html, /id="hour-burn-data"/);
    assert.match(html, /"projectKey":"research"/);
    assert.match(html, /"hour":9/);
    assert.doesNotMatch(html, /"hour":3/);            // zero hours excluded from payload
    assert.match(html, /class="hour-bar" data-hour="9"/);
    assert.doesNotMatch(html, /hour-bar" title=/);    // native title gone
    assert.doesNotMatch(html, /<div class="hour-bar" data-hour="\d+" title/);
```

Run: `node --import tsx --test tests/project-rows.test.ts` — Expected: FAIL.

- [ ] **Step 2: Implement in `render/today.ts`**

Add `jsonForScriptTag` to the existing `./shell.js` import. In `renderStrip`, change the bar template — remove `title="..."`, add `data-hour`:

```ts
  const bars = vm.hourly
    .map(
      (h) =>
        `<div class="hour-bar" data-hour="${h.hour}"><span style="height:${Math.round((h.usd / max) * 100)}%"></span></div>`
    )
    .join('');
```

In `renderToday`'s non-empty branch, after the closing `</div>` of `.layout`, emit:

```ts
<script type="application/json" id="burn-paths-data">${jsonForScriptTag(vm.projectFeatureMix)}</script>
<script type="application/json" id="hour-burn-data">${jsonForScriptTag(vm.hourly.filter((h) => h.usd > 0))}</script>
```

- [ ] **Step 3: Run tests**

Run: `npm test` — only the 8 known failures. `npx tsc --noEmit` — clean.

- [ ] **Step 4: Commit**

```bash
git add src/dashboard/render/today.ts tests/project-rows.test.ts
git commit -m "feat: Today emits burn-paths + hour-burn JSON; hour bars get data-hour"
```

---

### Task 4: Client JS + CSS — hour-bar tooltips

**Files:**
- Modify: `src/dashboard/static/dashboard.js` (new function + one init call at the `DOMContentLoaded` block near line 954, next to the existing `renderBurnPathsSubBars();` call)
- Modify: `src/dashboard/static/dashboard.css` (append)

**Interfaces:**
- Consumes: `#hour-burn-data` payload `[{ hour, usd, projects: [{ name, usd, color }] }]` (Task 3); existing helpers `esc`, `escapeAttr` in dashboard.js.
- Produces: `.hour-tooltip` shared singleton; hover behavior. No exports.

- [ ] **Step 1: Add `renderHourBarTips` to dashboard.js**

Place it directly after `attachSubbarSegmentTip` (so the tooltip helpers stay together), and add `renderHourBarTips();` beside `renderBurnPathsSubBars();` in the `DOMContentLoaded` handler:

```js
  // Hour-bar tooltips (Today page). Payload: [{hour, usd, projects:[{name,usd,color}]}].
  // Same conventions as the subbar tip: shared body-level singleton,
  // pointer-events:none via .chart-tooltip, display-before-measure,
  // viewport-clamped. Zero-spend hours are absent from the payload and
  // get no listeners.
  let hourTip = null;
  function ensureHourTip() {
    if (!hourTip) {
      hourTip = document.createElement('div');
      hourTip.className = 'chart-tooltip hour-tooltip';
      hourTip.style.display = 'none';
      document.body.appendChild(hourTip);
    }
    return hourTip;
  }

  function renderHourBarTips() {
    const dataNode = document.getElementById('hour-burn-data');
    if (!dataNode) return;
    let payload;
    try { payload = JSON.parse(dataNode.textContent || 'null'); } catch (e) { return; }
    if (!Array.isArray(payload)) return;
    const byHour = new Map(payload.map((h) => [h.hour, h]));
    const MAX_ROWS = 6;

    document.querySelectorAll('.hour-bar[data-hour]').forEach((bar) => {
      const entry = byHour.get(Number(bar.dataset.hour));
      if (!entry || !(entry.usd > 0)) return;
      bar.addEventListener('mouseenter', () => {
        const tip = ensureHourTip();
        const hh = String(entry.hour).padStart(2, '0');
        const next = String((entry.hour + 1) % 24).padStart(2, '0');
        const projects = Array.isArray(entry.projects) ? entry.projects : [];
        const rows = projects.slice(0, MAX_ROWS).map((p) =>
          `<div class="hour-tip-row">` +
          `<span class="swatch" style="background:${escapeAttr(p.color || '#9CA3AF')}"></span>` +
          `<span class="name">${esc(p.name || '')}</span>` +
          `<span class="amt">$${p.usd < 1 ? p.usd.toFixed(2) : p.usd.toFixed(0)}</span>` +
          `</div>`
        );
        if (projects.length > MAX_ROWS) {
          rows.push(`<div class="hour-tip-row hour-tip-more">+${projects.length - MAX_ROWS} more</div>`);
        }
        tip.innerHTML =
          `<div class="hour-tip-head">${hh}:00–${next}:00 · $${entry.usd.toFixed(2)}</div>` + rows.join('');
        // Display before measuring — offsetWidth is 0 while display:none.
        tip.style.display = 'flex';
        const rect = bar.getBoundingClientRect();
        const x = Math.max(8, Math.min(
          rect.left + rect.width / 2 - tip.offsetWidth / 2,
          window.innerWidth - tip.offsetWidth - 8,
        ));
        tip.style.left = x + 'px';
        tip.style.top = (rect.top - tip.offsetHeight - 6) + 'px';
      });
      bar.addEventListener('mouseleave', () => {
        if (hourTip) hourTip.style.display = 'none';
      });
    });
  }
```

Note: positions use `getBoundingClientRect` (viewport coords) exactly like `attachSubbarSegmentTip`; if that existing function adds scroll offsets, mirror whatever it does verbatim.

- [ ] **Step 2: Append CSS**

Append to `src/dashboard/static/dashboard.css`:

```css
/* --- Hour-bar tooltip (Today strip): column variant of the shared tip --- */
.hour-tooltip {
  flex-direction: column;
  align-items: stretch;
  gap: 3px;
  min-width: 150px;
}
.hour-tip-head {
  font-weight: 600;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
  padding-bottom: 3px;
  margin-bottom: 2px;
  border-bottom: 1px dashed var(--color-rule);
}
.hour-tip-row { display: flex; align-items: center; gap: 6px; }
.hour-tip-row .swatch { width: 10px; height: 10px; border-radius: 2px; flex: none; }
.hour-tip-row .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hour-tip-row .amt { font-variant-numeric: tabular-nums; font-weight: 600; }
.hour-tip-more { color: var(--color-ink-muted); }
```

- [ ] **Step 3: Sanity-run the suite** (no JS unit rig exists; this catches nothing JS-side but confirms no accidental TS/render breakage)

Run: `npm test` — only the 8 known failures.

- [ ] **Step 4: Commit**

```bash
git add src/dashboard/static/dashboard.js src/dashboard/static/dashboard.css
git commit -m "feat: hover tooltips for Today hour bars; burn-path tips light up via existing hydrator"
```

---

### Task 5: Live verification

**Files:** none (verification only)

- [ ] **Step 1: Type-check + suite**

Run: `npx tsc --noEmit` (clean) and `npm test` (only the 8 known failures).

- [ ] **Step 2: Serve and verify payloads**

```bash
npx tsx src/index.ts dashboard --port 4999 &
sleep 4
curl -s http://127.0.0.1:4999/today | grep -c 'id="burn-paths-data"'   # 1
curl -s http://127.0.0.1:4999/today | grep -c 'id="hour-burn-data"'    # 1
curl -s http://127.0.0.1:4999/today | grep -o 'data-hour="9"'          # present
curl -s http://127.0.0.1:4999/today | grep -c 'hour-bar" title='       # 0
```

- [ ] **Step 3: Browser hover check**

In a real browser (or Playwright): hover an hour bar with spend → column tooltip with header `HH:00–HH:00 · $X.XX` and per-project rows; hover hour 0-region and 23-region bars → tooltip stays on-screen (clamped); hover a burn-path bar → feature segments with the Overview-style single-row tooltips (hydrated, not the static fill); a zero-spend hour → no tooltip. Kill the dev server after.

- [ ] **Step 4: Done — no commit expected** (commit any verification-driven fixes with a `fix:` message and re-run the suite).
