# Menubar sparkline + stat grid — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the SwiftBar dropdown's flat project list with a CodexBar-inspired header (sparkline + delta + "updated Ns ago") and stat row (Today / 7d / 30d / Worth-a-look).

**Architecture:** Extend `buildToday()` with a `menubar` field (sparkline + 7d/30d totals + delta vs yesterday). Update the SwiftBar plugin to render the new sections above the existing project list. No new files in `src/dashboard/`; one new test file.

**Tech Stack:** TypeScript, better-sqlite3, Fastify (already wired), plain Node script inside the bash SwiftBar plugin.

**Reference spec:** `docs/superpowers/specs/2026-06-17-menubar-sparkline-stat-grid-design.md`

---

## File structure

| File                                            | Action  | Purpose                                                                  |
|-------------------------------------------------|---------|--------------------------------------------------------------------------|
| `src/dashboard/data/api.ts`                     | Modify  | Add `MenubarSummary` type + populate `menubar` field in `TodayResponse`  |
| `tests/api.test.ts`                             | Modify  | Add test cases for the new `menubar.*` fields                            |
| `scripts/menubar/tokentrail.1m.sh`              | Modify  | Inline Node script: read `menubar.*`, render hero + stat row             |

---

## Task 1: Extend `buildToday()` with `menubar` summary

**Files:**
- Modify: `src/dashboard/data/api.ts`
- Modify: `tests/api.test.ts`

- [ ] **Step 1.1: Write failing tests for the new fields**

Open `tests/api.test.ts` and append a new describe block. The existing `makeDb()` + `insertRollup()` helpers are reusable; ensure all newly-added tests run against a fresh `makeDb()` so they're isolated.

```ts
describe('buildToday — menubar summary', () => {
  test('sparkline includes 14 days oldest-first with today as the last cell', () => {
    const db = makeDb();
    // Seed: yesterday $10, 2 days ago $20, 5 days ago $5, today $7.
    const days = ['-5', '-2', '-1', '0'];
    const costs = [5, 20, 10, 7];
    days.forEach((d, i) => {
      const offset = d === '0' ? 'date(\'now\', \'localtime\')' : `date('now', '${d} days', 'localtime')`;
      const date = (db.prepare(`SELECT ${offset} AS d`).get() as { d: string }).d;
      insertRollup(db, { date, featureKey: `f-${i}`, featureName: `F ${i}`, repo: 'x/y', cost: costs[i]!, sessionIds: `s-${i}`, sessions: 1 });
    });
    const res = buildToday(db);
    assert.equal(res.menubar.sparkline.length, 14);
    // Today is index 13 (rightmost).
    assert.equal(res.menubar.sparkline[13], 7);
    // Yesterday is index 12.
    assert.equal(res.menubar.sparkline[12], 10);
    // Day with no rollup row is 0.
    assert.equal(res.menubar.sparkline[10], 0);
  });

  test('last7Usd and last30Usd sum the correct windows', () => {
    const db = makeDb();
    // 1 row 35 days ago ($100) — outside both windows.
    // 1 row 20 days ago ($30) — inside 30d only.
    // 1 row 3 days ago ($5) — inside both.
    // Today $7 — inside both.
    const samples: Array<[string, number]> = [
      [`date('now', '-35 days', 'localtime')`, 100],
      [`date('now', '-20 days', 'localtime')`, 30],
      [`date('now', '-3 days', 'localtime')`, 5],
      [`date('now', 'localtime')`, 7],
    ];
    samples.forEach(([expr, cost], i) => {
      const date = (db.prepare(`SELECT ${expr} AS d`).get() as { d: string }).d;
      insertRollup(db, { date, featureKey: `f-${i}`, featureName: `F ${i}`, repo: 'x/y', cost, sessionIds: `s-${i}`, sessions: 1 });
    });
    const res = buildToday(db);
    assert.equal(res.menubar.last7Usd, 12);   // 5 + 7
    assert.equal(res.menubar.last30Usd, 42);  // 30 + 5 + 7
  });

  test('deltaVsYesterday is signed percent vs yesterday total', () => {
    const db = makeDb();
    const today = (db.prepare(`SELECT date('now','localtime') AS d`).get() as { d: string }).d;
    const yest = (db.prepare(`SELECT date('now','-1 days','localtime') AS d`).get() as { d: string }).d;
    insertRollup(db, { date: yest, featureKey: 'a', featureName: 'A', repo: 'x/y', cost: 10, sessionIds: 's1', sessions: 1 });
    insertRollup(db, { date: today, featureKey: 'b', featureName: 'B', repo: 'x/y', cost: 25, sessionIds: 's2', sessions: 1 });
    const res = buildToday(db);
    assert.equal(res.menubar.yesterdayUsd, 10);
    // 25 / 10 = 2.5×, expressed as +150% (signed).
    assert.equal(res.menubar.deltaVsYesterday, 150);
  });

  test('first-day case: yesterday=0, today>0 returns Infinity for delta', () => {
    const db = makeDb();
    const today = (db.prepare(`SELECT date('now','localtime') AS d`).get() as { d: string }).d;
    insertRollup(db, { date: today, featureKey: 'a', featureName: 'A', repo: 'x/y', cost: 10, sessionIds: 's1', sessions: 1 });
    const res = buildToday(db);
    assert.equal(res.menubar.yesterdayUsd, 0);
    assert.equal(res.menubar.deltaVsYesterday, Infinity);
  });

  test('empty: all menubar fields zero, sparkline is 14 zeros', () => {
    const db = makeDb();
    const res = buildToday(db);
    assert.deepEqual(res.menubar.sparkline, Array(14).fill(0));
    assert.equal(res.menubar.last7Usd, 0);
    assert.equal(res.menubar.last30Usd, 0);
    assert.equal(res.menubar.yesterdayUsd, 0);
    assert.equal(res.menubar.deltaVsYesterday, 0);
  });
});
```

- [ ] **Step 1.2: Run the tests, confirm failure**

```bash
npm test -- --test-name-pattern='menubar summary'
```

Expected: 5 failures, all of the shape `res.menubar is undefined` or similar.

- [ ] **Step 1.3: Implement the menubar summary in `src/dashboard/data/api.ts`**

Add the type at the top:

```ts
export type MenubarSummary = {
  sparkline: number[];          // last 14 days, oldest first, today rightmost
  last7Usd: number;
  last30Usd: number;
  deltaVsYesterday: number;     // signed % vs yesterday; 0 when both are 0;
                                // Infinity when yesterday is 0 and today is > 0
  yesterdayUsd: number;
};
```

Extend `TodayResponse`:

```ts
export type TodayResponse = {
  todayUsd: number;
  topProjects: TodayProject[];
  anomalyCount: number;
  asOf: string;
  menubar: MenubarSummary;
};
```

Add a helper that builds the summary inside `buildToday`:

```ts
function buildMenubarSummary(db: DatabaseType.Database, todayUsd: number): MenubarSummary {
  // Pull totals for the last 30 days in one query.
  const rows = db
    .prepare(
      `SELECT date, ROUND(SUM(total_cost_usd), 2) AS total
         FROM feature_rollups
        WHERE date >= date('now', '-29 days', 'localtime')
        GROUP BY date`
    )
    .all() as Array<{ date: string; total: number }>;
  const byDate = new Map(rows.map((r) => [r.date, r.total]));

  const sparkline: number[] = [];
  let last7Usd = 0;
  for (let i = 13; i >= 0; i--) {
    const d = (db.prepare(`SELECT date('now', '-${i} days', 'localtime') AS d`).get() as { d: string }).d;
    sparkline.push(round2(byDate.get(d) ?? 0));
  }
  for (let i = 6; i >= 0; i--) {
    const d = (db.prepare(`SELECT date('now', '-${i} days', 'localtime') AS d`).get() as { d: string }).d;
    last7Usd += byDate.get(d) ?? 0;
  }
  let last30Usd = 0;
  for (const r of rows) last30Usd += r.total;

  const yesterdayDate = (db.prepare(`SELECT date('now', '-1 days', 'localtime') AS d`).get() as { d: string }).d;
  const yesterdayUsd = round2(byDate.get(yesterdayDate) ?? 0);

  let deltaVsYesterday: number;
  if (yesterdayUsd === 0 && todayUsd === 0) deltaVsYesterday = 0;
  else if (yesterdayUsd === 0) deltaVsYesterday = Infinity;
  else deltaVsYesterday = Math.round(((todayUsd - yesterdayUsd) / yesterdayUsd) * 100);

  return {
    sparkline,
    last7Usd: round2(last7Usd),
    last30Usd: round2(last30Usd),
    deltaVsYesterday,
    yesterdayUsd,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
```

Wire it into `buildToday`:

```ts
export function buildToday(db: DatabaseType.Database): TodayResponse {
  const overview = buildOverview(db, { days: 1 });
  const anomalyCount = (db
    .prepare(`SELECT COUNT(*) AS n FROM anomalies WHERE dismissed_at IS NULL`)
    .get() as { n: number }).n;

  return {
    todayUsd: overview.totalUsd,
    topProjects: overview.topProjects.slice(0, MAX_PROJECTS).map((p) => ({
      key: p.projectKey,
      name: p.projectName,
      usd: p.totalUsd,
      href: `${DASHBOARD_BASE_URL}/project/${encodeURIComponent(p.projectKey)}`,
      features: p.features.slice(0, MAX_FEATURES_PER_PROJECT).map((f) => ({
        key: f.featureKey,
        name: f.featureName,
        usd: f.totalUsd,
        href: `${DASHBOARD_BASE_URL}/feature/${encodeURIComponent(f.featureKey)}`,
      })),
    })),
    anomalyCount,
    asOf: new Date().toISOString(),
    menubar: buildMenubarSummary(db, overview.totalUsd),
  };
}
```

- [ ] **Step 1.4: Run the tests, confirm pass**

```bash
npm test -- --test-name-pattern='menubar summary'
```

Expected: 5 passed.

- [ ] **Step 1.5: Full suite — no regressions**

```bash
npm test
```

Expected: all green. Existing api.test.ts cases continue to pass because the new `menubar` field is additive.

- [ ] **Step 1.6: Commit**

```bash
git add src/dashboard/data/api.ts tests/api.test.ts
git commit -m "feat(api): /api/today returns menubar summary (sparkline + 7d/30d/delta)

Additive field. Existing clients that don't read menubar.* are unaffected.
Sparkline is 14 days, oldest first, today is the rightmost cell. Delta is
signed % (Infinity when yesterday was 0 and today is > 0)."
```

---

## Task 2: Update the SwiftBar plugin to render the new sections

**Files:**
- Modify: `scripts/menubar/tokentrail.1m.sh`

This is a single-file change. No new tests — the existing repo convention is no plugin tests (it's a bash + inline Node script verified manually).

- [ ] **Step 2.1: Add helper functions to the inline Node script**

Open `scripts/menubar/tokentrail.1m.sh`. Find the helpers block near the top of the inline Node script (around the `fmtUsd` / `plural` declarations). Add:

```js
const BLOCKS = [' ', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
function spark(values) {
  const max = Math.max.apply(null, values.concat(1));
  return values
    .map(function (v) { return BLOCKS[Math.min(8, Math.round((v / max) * 8))]; })
    .join('');
}

function fmtDelta(d) {
  if (d === 0) return '—';                                            // — em dash
  if (d === Infinity || (typeof d === 'string' && d === 'Infinity')) return 'first day';
  const arrow = d > 0 ? '▲' : '▼';                                 // ▲ / ▼
  const abs = Math.abs(d);
  // Format as multiplier if abs >= 50; as % otherwise (matches Tokentrail voice).
  if (abs >= 50) return arrow + ' ' + (1 + abs / 100).toFixed(1) + 'x';
  return arrow + ' ' + abs + '%';
}

function fmtAgo(ms) {
  const secs = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (secs < 60) return secs + 's';
  const mins = Math.round(secs / 60);
  if (mins < 60) return mins + 'm';
  return Math.round(mins / 60) + 'h';
}
```

- [ ] **Step 2.2: Render hero row, sparkline, "updated", and stat row**

Find `renderHappy(data)`. Currently the first lines push the dollar amount and the meta line. Replace the prelude (before the `for (let i = 0; ...)` over `data.topProjects`) so it now emits:

1. Menubar icon line — unchanged: `${fmtUsd(data.todayUsd)} | font=Menlo size=12`
2. `---` separator
3. Hero row: `${dollar} today  ${delta}  ${spark}` formatted as one SwiftBar row
4. `Updated ${ago} ago` muted
5. `---`
6. Four stat rows (Today, 7d, 30d, Worth-a-look) — start as stacked rows per the spec's risk-fallback path
7. `---`
8. The existing `TODAY · N projects · N anomalies` line and the project list

Concrete change inside `renderHappy(data)`:

```js
function renderHappy(data) {
  const lines = [];
  lines.push(`${fmtUsd(data.todayUsd)} | font=Menlo size=12`);
  lines.push('---');

  // Defensive: older daemon revisions might not emit menubar.
  const menubar = data.menubar || { sparkline: [], last7Usd: 0, last30Usd: 0, deltaVsYesterday: 0, yesterdayUsd: 0 };
  const sparkText = menubar.sparkline.length ? spark(menubar.sparkline) : '';
  const heroLeft = `${fmtUsd(data.todayUsd)} today`;
  const heroRight = `${fmtDelta(menubar.deltaVsYesterday)}   ${sparkText}`;
  lines.push(`${sanitizeLabel(heroLeft + '   ' + heroRight)} | font=Menlo size=12`);

  const ago = data.asOf ? fmtAgo(new Date(data.asOf).getTime()) : '?';
  lines.push(`Updated ${ago} ago | ${META_STYLE}`);
  lines.push('---');

  // Stat rows (stacked — see spec risk note).
  lines.push(`Today      ${fmtUsd(data.todayUsd)} | ${META_STYLE}`);
  lines.push(`Last 7d    ${fmtUsd(menubar.last7Usd)} | ${META_STYLE}`);
  lines.push(`Last 30d   ${fmtUsd(menubar.last30Usd)} | ${META_STYLE}`);
  const anomaliesLabel = data.anomalyCount > 0
    ? `⚠ Worth a look   ${data.anomalyCount} active`
    : `Worth a look   —`;
  lines.push(`${anomaliesLabel} | href=${DASHBOARD_URL}/worth-a-look ${META_STYLE}`);
  lines.push('---');

  // Existing TODAY meta + project list — unchanged from here.
  if (data.topProjects.length === 0) {
    lines.push(`TODAY · no activity yet | ${META_STYLE}`);
  } else {
    lines.push(
      `TODAY · ${plural(data.topProjects.length, 'project', 'projects')} · ` +
      `${plural(data.anomalyCount, 'anomaly', 'anomalies')} | ${META_STYLE}`
    );
    lines.push('---');
    for (let i = 0; i < data.topProjects.length; i++) {
      const p = data.topProjects[i];
      const projLabel = sanitizeLabel(`${p.name}  ${fmtUsd(p.usd)}`);
      lines.push(`${projLabel} | href=${p.href} ${PROJECT_FONT}`);
      if (p.features.length > 1) {
        for (let j = 0; j < p.features.length; j++) {
          const f = p.features[j];
          const glyph = j === p.features.length - 1 ? TREE_LAST : TREE_BRANCH;
          const fLabel = sanitizeLabel(`  ${glyph} ${f.name}  ${fmtUsd(f.usd)}`);
          lines.push(`${fLabel} | href=${f.href} ${FEATURE_STYLE}`);
        }
      }
      if (i < data.topProjects.length - 1) {
        lines.push('---');
      }
    }
  }

  lines.push('---');
  lines.push(`Open dashboard | href=${DASHBOARD_URL}/`);
  lines.push(`Today | href=${DASHBOARD_URL}/today`);
  lines.push('Refresh | refresh=true');
  return lines.join('\n');
}
```

- [ ] **Step 2.3: Manual test the plugin output**

```bash
bash scripts/menubar/tokentrail.1m.sh
```

Expected output begins with:

```
$XX.XX | font=Menlo size=12
---
$XX.XX today   ▲ 1.4x   ▁▂▁▃▂▅▇▃▅▂▇▃▁▂ | font=Menlo size=12
Updated 12s ago | color=#6b563d size=11
---
Today      $XX.XX | color=#6b563d size=11
Last 7d    $YYY.YY | color=#6b563d size=11
Last 30d   $ZZZZ.ZZ | color=#6b563d size=11
⚠ Worth a look   2 active | href=http://127.0.0.1:4920/worth-a-look color=#6b563d size=11
---
TODAY · N projects · N anomalies | color=#6b563d size=11
---
[project list unchanged]
---
Open dashboard | href=...
Today | href=...
Refresh | refresh=true
```

Check:
- Sparkline glyphs render as block characters (not boxes / mojibake).
- Stat rows align readably (use the `Last 7d`/`Last 30d` long labels for visual rhythm).
- ⚠ Worth a look row only highlights when `anomalyCount > 0`.
- Open dashboard / Today / Refresh footer still works.

- [ ] **Step 2.4: Reload the live SwiftBar plugin**

The daemon picks up new responses automatically. The plugin re-runs every minute, but you can force-refresh:

```bash
open 'swiftbar://refreshallplugins'
```

Or click "Refresh" inside the dropdown.

- [ ] **Step 2.5: Commit**

```bash
git add scripts/menubar/tokentrail.1m.sh
git commit -m "feat(menubar): sparkline + stat rows in SwiftBar dropdown

Hero row: $XX today + delta-vs-yesterday arrow + 14-day sparkline of
block glyphs + 'Updated Ns ago'. Stat rows: Today, Last 7d, Last 30d,
Worth-a-look (with ⚠ when anomalies exist, dash when none). Project
list unchanged.

Consumes the new menubar.* field added by /api/today; falls back to a
zero-state when an older daemon doesn't emit menubar."
```

---

## Task 3: README + done

**Files:**
- Modify: `README.md`

- [ ] **Step 3.1: Update the README menubar screenshot/description**

Find the menubar section in README.md (search for `swiftbar` or `menubar`). Update the screenshot reference if there's one. Add a paragraph noting the new sparkline + stat row.

Suggested copy:

```markdown
The dropdown now shows a 14-day sparkline of daily spend in the hero row
alongside the delta vs yesterday, followed by Today / Last 7d / Last 30d
totals and a Worth-a-look anomaly count. Click any row to open the
matching dashboard page.
```

If there's no menubar section yet, skip this step — the existing README
text in PR #11 (\"Dashboard\" section) already mentions the menubar.

- [ ] **Step 3.2: Commit**

```bash
git add README.md
git commit -m "docs(readme): mention menubar sparkline + stat rows"
```

---

## Self-review

**Spec coverage:**
- ✅ Sparkline (14 cells, today rightmost) — Task 1.3 + Task 2.2
- ✅ Stat row (Today / 7d / 30d / Worth-a-look) — Task 2.2
- ✅ Delta arrow (▲/▼/—/first-day) — Task 2.1 (`fmtDelta`)
- ✅ "Updated Ns ago" — Task 2.1 (`fmtAgo`)
- ✅ Backward-compatible `/api/today` (additive field) — Task 1.3
- ✅ Edge case: empty sparkline / 0 yesterday — covered by Task 1.1 tests
- ✅ Risk mitigation: stat row starts as stacked menu rows (spec's fallback path)
- ✅ Footer actions: Open dashboard / Today / Refresh — Task 2.2

**Placeholder scan:** No TBD / TODO / vague "handle errors." All code blocks are concrete.

**Type consistency:**
- `MenubarSummary.sparkline: number[]` — defined Task 1.3, consumed in Task 2.1's `spark()`
- `MenubarSummary.deltaVsYesterday` — number | Infinity, both branches handled in Task 2.1's `fmtDelta`
- `data.asOf` — ISO string, parsed by `Date(...).getTime()` in `fmtAgo`
