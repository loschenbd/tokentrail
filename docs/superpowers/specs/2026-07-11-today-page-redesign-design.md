# Today Page: Repair + Timeline-First Redesign

**Date:** 2026-07-11
**Status:** Approved

## Problem

Two problems on `/today`:

1. **Broken rendering (bug).** The burn-paths list renders with labels,
   dollar amounts, and percentages overlapping. Root cause: markup drift.
   The shared `.project-row` CSS was rewritten for Overview's new grammar
   (`rank`/`swatch`/`name-col`/`amt-col`/`subbar`, a 4-column grid), but
   `render/today.ts` still emits the old children (`mile`/`name`/`amt`),
   which auto-place into wrong grid cells — the name lands in the 12px
   swatch column. Same failure mode as the prior incident captured in the
   `css-grid-implicit-column-from-renderer-child-drift` skill.
2. **Sparse page.** Below the single burn-paths card and three side cards,
   the page is empty. The data to fill it (per-event timestamps, session
   titles, commit/PR attribution) already exists in SQLite.

## Design

Timeline-first layout: a full-width burn-by-hour strip becomes the page's
spine, with enriched two-column content below.

```
┌───────────────────────────────────────────┐
│ BURN BY HOUR                              │
│ ▁▁▃▇▂▁▁▂▅▃▁      $28 so far · pace ~$41   │
│ 6a   9a   12p   3p   6p   9p              │
├────────────────────────────┬──────────────┤
│ TODAY'S BURN PATHS         │ TODAY  $28   │
│  1 ▪ Research    $17 · 60% │  ▲13% vs yd  │
│  2 ▪ job-search  $10 · 34% │              │
│                            ├──────────────┤
│ SESSIONS TODAY · 4         │ SHIPPED      │
│  09:02  deep-research  $11 │  2 PRs       │
│  10:30  cover letter   $6  │  9 commits   │
│                            ├──────────────┤
│                            │ WORTH A LOOK │
└────────────────────────────┴──────────────┘
```

### 1. Repair: shared project-row renderer

- Extract Overview's project-row markup (lines ~95–100 of
  `render/overview.ts`) into a shared helper, e.g.
  `render/project-rows.ts`, exporting `renderProjectRow(p, i, color)`.
- Both `overview.ts` and `today.ts` call it. `today.ts` drops its local
  `renderTopProjects` markup (old `mile`/`name`/`amt` + separate `.bar`).
- Today's rows gain the swatch colors and `subbar` Overview already has.
  Data shape is already identical (`TodayVM.topProjects` is
  `OverviewVM['topProjects']`), so this is markup-only unification.
- Colors: reuse whatever color assignment Overview uses (project → color
  map); Today must render the same project in the same color as Overview.

### 2. Burn-by-hour strip

- New full-width card between the page header and `.layout` (new layout
  slot, e.g. `<div class="strip">…</div>` above the existing two-column
  `.layout` div).
- Data: 24 hourly buckets for today from `usage_events`:
  `SELECT strftime('%H', timestamp, 'localtime') AS hh, SUM(estimated_cost_usd)`
  grouped by hour, zero-filled for missing hours.
- Rendering: server-side CSS bars (divs with height percentages), matching
  the calm aesthetic; no uPlot, no client JS. Hour labels every 3 hours.
- Right-aligned inline stat: `$28 so far · pace ~$41 · usual day $23`.
- **Pace formula:** pace = todayUsd ÷ (historical share of a day's spend
  that has occurred by the current hour), where the share is computed from
  the last 30 days of `usage_events` (cumulative spend by hour ÷ total,
  averaged across days). Fallback: with < 7 days of history, omit the pace
  figure and show only `usual day $X` (30-day, or all-time, daily average).
- All figures are estimated costs (constitution rule 3) — the existing
  "estimated" labeling convention applies to the strip too.

### 3. Sessions today (main column, below burn paths)

- One row per session with any `usage_events` today, chronological
  ascending.
- Row content: start–end time (`HH:MM–HH:MM`, from min/max event
  timestamps today), session title from `sessions.title` (fallback:
  `inferred_feature_name`, then `project_dir` basename), project name,
  cost (summed `estimated_cost_usd` for today's events).
- Row links to the session's feature page (same target the feature rows
  use elsewhere). Sessions with no feature attribution render as plain
  (non-link) rows.
- Card label: `Sessions today · 4` — the standalone sessions-count side
  card is removed.

### 4. Shipped today (side column, replaces sessions-count card)

- Header stat: `2 PRs · 9 commits` — counts from `session_prs` /
  `session_commits` joined to sessions active today. To avoid old work
  riding along on a resumed session: commits count only if
  `authored_at` is today; PRs count if `merged_at` is today OR
  (`pr_state = 'open'` AND the linked session had usage today).
- Below: up to 5 commit subjects, most recent first; PRs shown with state
  (open/merged).
- Empty state: `Nothing shipped yet — the trail's still being walked.`

### 5. Unchanged

- Hero card (Today $, delta vs yesterday, yesterday line) — pace lives in
  the strip, not the hero.
- Worth a look card.
- Empty-day state (`renderEmptyState`) — still shown when the whole day is
  empty; the strip is part of the non-empty layout only.

## Data layer changes

`data/today.ts` — `TodayVM` gains:

```ts
hourly: { hour: number; usd: number }[];   // 24 entries, zero-filled
paceUsd: number | null;                    // null = insufficient history
usualDayUsd: number;                       // 30-day daily average
sessions: {
  sessionId: string; title: string; projectName: string;
  featureKey: string | null;
  startedAt: string; endedAt: string; usd: number;
}[];
shipped: {
  prCount: number; commitCount: number;
  items: { kind: 'pr' | 'commit'; title: string; state?: string; at: string }[];
};
```

`sessionsToday` count derives from `sessions.length` (the old
rollup-based count query goes away).

## Error handling

- Timezone: every new query uses `'localtime'`, consistent with existing
  queries.
- Sessions with missing titles fall back as specified; never render an
  empty title.
- Hours with zero spend render as empty slots (baseline track visible).
- Shipped join must not crash on sessions without commits/PRs (LEFT JOIN /
  empty list).

## Testing

- `dashboard-data.test.ts`: new VM fields — hourly bucketing (incl.
  zero-fill), session aggregation (title fallbacks, time range, cost sum),
  shipped counts (old commits from a today-active session excluded), pace
  fallback under 7 days of history.
- Render regression test: Today's project rows must contain `name-col`,
  `amt-col`, and `subbar` classes — a tripwire for the markup-drift bug
  class. Overview's rows covered by the same shared-renderer test.

## Out of scope

- Any Overview changes beyond extracting the shared row renderer.
- Client-side interactivity for the strip (tooltips, hover) — static CSS
  bars only in this pass.
- Mobile-specific layout work beyond what the existing responsive CSS
  provides.
