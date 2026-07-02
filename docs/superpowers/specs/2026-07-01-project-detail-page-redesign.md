# Project Detail Page Redesign — Design Spec

**Date:** 2026-07-01
**Route:** `/project/:key`
**Type:** Story-first single-column redesign

## Goal

Turn the project detail page from a stack of loosely related cards into a
single-column narrative that answers, in read order, the four questions a
user has when they open a project:

1. What is this project and how big is it? *(Hero)*
2. Is spend heating up or cooling? *(Velocity)*
3. Where is the money going within it? *(Features)*
4. What's in flight vs. done? *(Active work)*
5. Is there anything to clean up? *(Worth reconciling)*

Each section is a card, but the sections read as chapters — every one
answers a question the previous section raised.

## Non-goals

- No tabs, no filters, no drill-through UI beyond existing links.
- No new data pipelines. All sections read from data already available
  in `feature_rollups`, `session_commits`, `session_prs`, `anomalies`,
  and the existing `ProjectDetailVM` shape (extended, not rewritten).
- No changes to the URL, the route handler wiring, or the shell.
- Trail-elevation is REPLACED by a daily velocity chart. The cumulative
  step chart it renders today does not survive the redesign — it was
  decorative more than informational.

## Layout

Single column, same width as the overview main-col, parchment cards on
a parchment page. Five cards in this vertical order:

```
HERO             — project name, $, delta, quick facts, most-active feature
VELOCITY         — 30d daily bar chart + rolling-week callouts + peak day
FEATURES         — ranked list with per-feature sparkline + last-active
ACTIVE WORK      — compact branch graph + open/merged/stale summary + commits
WORTH RECONCILING — project-scoped unattributed + anomalies with cause
```

Header nav (`Trail →` back link) stays exactly as it is today.

## Sections

### 1. Hero

Layout mirrors the overview's sidebar hero card but with more context:

```
REPO:LOSCHENBD/ARCHI

archi                                     $2,203
                                          ▲649% vs prior · $1,915 more
                                          17 sessions · 18 features
                                          most active: local-rag-chatbot ($765)
```

Data:

- `projectName`, `projectKey`, `totalUsd`, `deltaPct` — already on VM.
- **Dollar delta** (`$1,915 more`): compute as
  `totalUsd - priorUsd`. Absolute value, shown alongside `deltaPct`. If
  prior is 0 and current is nonzero, show `(new project)` instead of a
  delta.
- **Sessions / features counts** — already on VM.
- **Most-active feature callout** — top feature by `totalUsd` in-window
  and its dollar amount. Derived from `vm.features[0]`. Link to
  `/feature/<key>`. Skip the line entirely if `vm.features` is empty.

Typography follows the overview hero card exactly. Same serif for the
project name; same tabular-nums monospace for the dollar values.

### 2. Velocity

Answers *is spend heating up or cooling?*

Layout:

```
VELOCITY · last 30 days

$2,203 total  ·  $180/day avg  ·  ▲649% vs prior 30d

┌─────────────────────────────────────────────┐
│         ▲                                   │
│        ▲ ▲                             ▲    │
│    ▲▲ ▲   ▲▲   ▲       ▲▲▲     ▲     ▲ ▲   │
│  ▲                                          │
└─────────────────────────────────────────────┘
   Jun 1     Jun 8     Jun 15    Jun 22    Jun 29

  This week  $487   ▼26% vs last week
  Last week  $661   ▲58% vs prior week
  Peak day   Jun 15 · $412 (Feature: local-rag-chatbot)
```

Components:

- **Header stat row**: `$total · $/day avg · deltaPct vs prior 30d`.
  Avg = `totalUsd / windowDays`. Comma-separated with `·`.
- **Daily bar chart** replaces trail-elevation. One bar per day in the
  window. Height proportional to that day's total cost. Bars use the
  project's own color from `resolveProjectColors` (project-first-overview
  redesign), so the page reads as "this is archi" throughout. Empty days
  render as no-bar (zero-height slot, not a stub). Height range picks a
  max that leaves the tallest bar at ~90% of the chart area.
- **Y-axis** implicit — no gridlines, no labels. Peak-day is called out
  in text below.
- **X-axis** labels every ~7 days.
- **Rolling-week callouts** — three rows below the chart:
  - This week (last 7 days): total + delta vs the prior 7.
  - Last week (days 8–14 ago): total + delta vs the 7 before that.
  - Peak day: date + $ + which feature was the top spender that day.
- **Peak day** = the day in-window with the highest `total`.
  Feature-of-the-day = the top `feature_key` on that specific date from
  `feature_rollups`.

Sparkline / bar rendering is server-side SVG so it works with no JS.

### 3. Features

Answers *where is the money going within this project?*

Layout:

```
FEATURES · 18

 1  local-rag-chatbot ·······················  $765 · 35%
    5 sess · last Jun 27         ▁▁▂▂▃▃▄▅▇▇█

 2  archi-homepage-redesign ·················  $355 · 16%
    3 sess · last Jun 21         ▁▁▂▂▄▃▂▁

 3  onboarding-wizard ·······················  $220 · 10%
    3 sess · last Jun 10         ▂▃▄█

 …
```

Per row:

- **Rank** — 1-indexed, muted.
- **Feature name** — link to `/feature/<key>`. Truncate at 40 chars with
  ellipsis; hover-tooltip shows full name.
- **Sessions count** — `N sess`.
- **Last active** — date of the most recent rollup row for this feature
  in-window (`MAX(date)` from `feature_rollups WHERE feature_key = …`).
  Formatted as `last Jun 27`.
- **Sparkline** — 30-day daily-cost mini SVG, ~80×16 px. Uses the same
  per-feature shade as the overview's burn-paths sub-bar segments:
  `shadeForFeature(resolveProjectColors[projectKey], featureKey)`. This
  keeps colour identity consistent across the two pages — a feature
  looks the same colour in the overview sub-bar as it does in the
  project-page sparkline. Empty days = zero baseline points, so
  recent-and-active features look different from early-but-dormant
  ones. Rendered server-side SVG (no JS).
- **Amount + share** — right-aligned. `$765 · 35%`. Same tabular-nums
  treatment as elsewhere.

Whole row is clickable, jumping to `/feature/<key>`. Row uses a
two-line grid: metadata on line 1, sparkline + info on line 2.

Show all features in-window (no top-N truncation). If the list is very
long, scroll behavior is native (no pagination). We already show 18
today without complaint.

### 4. Active work

Answers *what's in flight vs. done?*

Layout:

```
ACTIVE WORK · last 30d

Branches                                                            $12

  main    ──●────●────────────●─●────────
                 │            │ │
                 ●─● stale    │ ●─●  ● merged  Jun 9
                              ●───●  ✓ merged  Jun 9
                              ●──────●  → open  #38

  Open        1  ·  worktree-local-semantic-search   $12
  Merged      2  ·  onboarding-wizard  ·  coherence-pass
  Stale       1  ·  cloud-banner-on-user-sync-only

Recent commits

  a2c6cad1  fix: nodes grow by radius, not transform scale, so they don't jump
  2f0514a6  feat: restore corner-turning cascade pulses; line switches node on
  …
```

Components:

- **Compact branch graph** — same underlying data as today's `branchGraph`
  VM, but capped at 120–140 px tall. Branches shown as short lines
  forking off `main` and rejoining (merged), dying (stale), or ending in
  a hollow node (open). Same rendering module as today
  (`renderBranchGraph`), just tuned for the smaller box.
- **State summary** — three rows: Open / Merged / Stale, each with a
  count and comma-separated branch names. Dollars shown only when
  non-zero. This is the actual "what's going on" answer.
- **Recent commits merged from its own card** — same row format as
  today's `renderCommits` (SHA + subject, GitHub link). Top 10, most
  recent first. Filtered to commits inside this project.
- **`$` in section header** = sum of branch-attributed cost this window.
  When zero (common case with mostly-mainline work), the header just
  shows `$0` and no branch has a dollar tag; still valid.

Section renders even when there's no branch activity — the empty state
is just `No branches touched archi in this window.` (This is rare; most
projects have some branches.)

### 5. Worth reconciling

Answers *is there anything to clean up on this project?*

```
WORTH RECONCILING

  Unattributed on archi                          $0  ✓
  Every session in this project has a feature.

  Anomalies                                       2 active

   Jun 15   $412 — 4.2× the prior week's typical day
            driven by session 075fff73… (local-rag-chatbot)

   Jun 27   $189 — first activity in 6 days
            after a lull, spike on onboarding-wizard

            See all anomalies for archi →
```

Two sub-blocks:

- **Unattributed on this project** — same pattern as the overview
  sidebar's unattributed card, but filtered to `feature_rollups WHERE
  project_key = <this> AND feature_key = 'uncategorized-mainline'`.
  When zero, shows the positive empty state (green $0 · "all sessions
  attributed"). When nonzero, shows sparkline + top offender features +
  the same **Run tokentrail infer-mainline →** button as the overview,
  wired to the same SSE endpoint. Clicking runs project-wide inference
  (the endpoint doesn't currently accept a project filter; that's fine
  — one click cleans this and everything else).
- **Anomalies** — filtered to anomalies on this project's features
  (`anomalies WHERE feature_key IN (project's features)` OR
  `session_id IN (project's sessions)`; the row-level filter already
  exists in `data/project.ts`). Each row shows:
  - Date + dollar amount.
  - Reason line (existing `anomalies.reason`).
  - **Cause line** (NEW): the driver of that anomaly. For a spike_day,
    the top session on that day. For a first_activity anomaly, the
    feature that resumed.
- **Empty-state collapse**: if unattributed is `$0` AND anomalies is
  empty, the whole section collapses to a single subtle line under the
  Active Work section: `All clear on archi.` No card. Preserves the
  trail-map "calm when nothing's wrong" feel.

Row-level click behavior: an anomaly row links to
`/session/<session_id>` when it references a specific session; the
Unattributed CTA does its SSE POST as today.

## Visual language

Everything stays inside the palette and typography already used across
the dashboard:

- Parchment `#F6EFDD`-ish page + card background.
- Serif hero (`--font-serif`), sans body (`--font-sans`), tabular-nums
  for numbers.
- Per-project hue via `resolveProjectColors` — the hero, velocity bars,
  feature sparklines, and unattributed sparkline all shade from that
  base. The unattributed block sparkline is intentionally muted
  (existing pattern) — everything else uses the project's hue.
- Same card treatment (`.card`), same `.label` micro-headers, same
  bar / sub-bar rules as the redesigned overview.

## Data changes

`ProjectDetailVM` extends with:

- `priorUsd: number` — for the dollar delta line in the hero.
- `avgUsdPerDay: number` — computed as `totalUsd / windowDays`.
- `days: Array<{ date: string; totalUsd: number }>` — daily costs
  in-window, ordered by date. Feeds velocity chart.
- `weekStats: { thisWeekUsd, lastWeekUsd, priorWeekUsd, thisVsLast: number,
  lastVsPrior: number }` — rolling week totals + deltas.
- `peakDay: { date: string; totalUsd: number; featureKey: string;
  featureName: string } | null` — the highest-spend day in-window and its
  top feature.
- Each `features[i]` gets:
  - `lastActive: string` — max date this feature had rollup activity
    in-window.
  - `daily: Array<{ date: string; totalUsd: number }>` — sparkline data.
- Anomalies get an optional `cause: { kind: 'session' | 'feature';
  ref: string; label: string }` for the second-line drilling annotation.

Existing fields (`totalUsd`, `deltaPct`, `sessions`, `branchGraph`,
`recentCommits`) stay as-is; the trail-elevation array
(`sessions[].date/cost` used to feed the cumulative chart) is no longer
consumed by render but stays on the VM for now — cheap to leave, and
`/api/…` consumers may depend on it.

## Render changes

`src/dashboard/render/project.ts` rewritten around a five-section
skeleton. `renderFeatureList` becomes a two-line-per-feature builder.
New helper modules:

- `renderVelocityChart(days, projectColor, peakDay)` — server-side SVG
  bar chart. New file.
- `renderFeatureSparkline(daily, projectColor)` — server-side SVG
  sparkline shared with the sidebar unattributed card. Extract from
  `dashboard.js drawSparkline` into a TS helper so both server (project
  page) and client (unattributed card) can use it.
- `renderBranchGraph` in `dashboard/static/branch-graph.js` keeps its
  data contract; only its bounding-box CSS shrinks.
- Anomaly row rendering picks up an optional cause line.

## Testing

- Unit: `data/project.ts` gains tests for weekStats, peakDay,
  per-feature `lastActive` + `daily`, and dollar-delta edge case
  (prior 0 → `(new project)`).
- Snapshot / structural tests on `render/project.ts` similar to the
  existing `tests/overview-render.test.ts` — assert each section
  renders, empty-state collapse works, and section order is stable.
- Playwright pass on the actual archi page for a visual verification.

## Rollout

- No feature flag. Ship as a single PR.
- No DB migration.
- Backwards-compat concern: `/api/project/<key>` (if exposed) keeps
  returning `sessions[]` for trail-elevation consumers; the render just
  stops using it.
