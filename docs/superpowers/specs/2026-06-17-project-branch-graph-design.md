# Project branch graph — lifecycle arcs with cost

**Date:** 2026-06-17
**Status:** Spec, awaiting plan
**Scope:** New section on `/project/:key` pages that renders the project's
non-mainline branches as a GitHub-style network diagram, with cost +
lifecycle status per branch.

## Goal

The project page tells you "this repo cost $X this window, broken down
by features and sessions." It does NOT show:

- Which branches diverged from master and when
- Which of those branches merged back, when, and at what cost
- Which branches are still alive (open or stale) and what they're costing

Engineers reason about work in terms of branches/PRs — that's the unit
of "a thing I'm building right now." Mapping cost onto that mental
model makes it immediately answerable: "the feat/onboarding branch took
3 sessions and cost $57 before merging" reads at a glance in a way
that a feature/session list does not.

The result is a small SVG chart at the bottom of each project page:

```
Branches · last 30d                              9 branches · $267 total

  may 18              jun 1              jun 17
  master ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
          ╲                                                          ╱
           ●━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━●
             feat/trail-map  $90 · 4 sessions · merged jun 16
                  ╲                                               ╱
                   ●━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━●
                    feat/onboarding  $57 · 3 sessions · merged jun 15
                          ╲                              ╱
                           ●━━━━━━━━━━━━━━━━━━━━━━━━━●
                            fix/menubar  $28 · merged jun 17
                                ╲                          ╱
                                 ●━━━━━━━━━━━━━━━━━━━━━━━○
                                  feat/wip  $12 · 1 session · open
```

## Non-goals

- A cross-project / global `/branches` tab. Per-project only for v1.
- Literal commit-by-commit network rendering (one node per commit).
  The arc is stylized — start = first cost event, end = merge or last
  cost event.
- Drag-to-zoom or time-range scrubbing. The 30-day window matches the
  project page's `?days=` param; if a user wants 7d/90d they change the
  page-level toggle and the chart re-renders.
- Multi-repo support in one chart. Each project page shows that
  repo's branches; the chart respects the project's repo scope.
- A chart library. Hand-rolled SVG, following the trail-elevation
  precedent in `dashboard.js` (see [Research](#research--why-no-chart-library)).

## Data shape

New module `src/dashboard/data/branches.ts` exports `buildBranchGraph()`:

```ts
type BranchLifecycle = {
  branch: string;                  // e.g. "feat/trail-map"
  firstEventAt: string;            // ISO timestamp, MIN(usage_events.timestamp)
  lastEventAt: string;             // ISO timestamp, MAX(usage_events.timestamp)
  mergedAt: string | null;         // ISO timestamp from session_prs, or null
  status: 'merged' | 'open' | 'stale';
  totalUsd: number;                // SUM(usage_events.estimated_cost_usd)
  sessionCount: number;            // COUNT(DISTINCT usage_events.session_id)
  prNumber: number | null;         // session_prs.pr_number, if matched
  prUrl: string | null;            // session_prs.pr_url, if matched
  featureKey: string | null;       // for click-through to /feature/:key
};

type BranchGraphVM = {
  trunk: string;                   // "master" | "main" | detected
  windowStart: string;             // ISO date
  windowEnd: string;               // ISO date
  branches: BranchLifecycle[];     // sorted by firstEventAt ascending
  totalBranches: number;
  totalUsd: number;                // SUM across all branches in window (incl. trunk)
};

export function buildBranchGraph(
  db: DatabaseType.Database,
  opts: { projectKey: string; days: number }
): BranchGraphVM | null;
```

**Trunk detection**: pick whichever of `master`/`main`/`trunk` has the
most rows in `usage_events` for this repo. Fall back to `master`.

**Source of truth**: `usage_events` (clean `branch` column, direct cost
attribution). Sample inspection of `session_commits.branch` revealed
formatting like `origin/foo, foo` CSV junk — NOT used here.

**Lifecycle resolution**:

- `firstEventAt`/`lastEventAt`: `MIN`/`MAX(timestamp)` from
  `usage_events` filtered by `(repo, branch)`.
- `mergedAt`: matched against `session_prs` where
  `repo=? AND (branch=? OR branch='origin/'||?)`. If multiple PRs match
  the branch and any has `pr_state='merged'`, use that PR's `merged_at`.
  Open PRs are recorded but don't set `mergedAt`.
- `status`:
  - `merged` if `mergedAt` is set.
  - `stale` if `mergedAt` is null AND `(now - lastEventAt) > 7 days`.
  - `open` otherwise.
- `featureKey`: looked up from `feature_rollups.branches` CSV by
  finding a row whose branches contain this branch name. First match
  wins; null if none.

**Mainline exclusion**: branches matching `^(master|main|trunk)$` are
excluded from `branches[]`. The trunk is drawn as a backdrop line, not
a data row.

**Window filter**: include branches where `lastEventAt >= windowStart`.
Branches that pre-date the window but extend into it (long-lived
branches) are clipped at `windowStart` for X-axis purposes (the arc
visually starts at the window's left edge with an inward chevron, see
below).

**No branches**: return `null` when there are zero non-mainline
branches in the window. Renderer treats `null` as "skip the section
entirely" — no empty card.

## Visual treatment

Pure SVG, inline in the project page template, JSON blob in a
`<script type="application/json">` tag — same pattern as the existing
trail-elevation chart.

**Canvas**: full-width container. Vertical layout, top-to-bottom:

- `0–24px` — date-axis ticks and labels
- `24–48px` — title row ("Branches · last 30d · N branches · $X total")
- `48px` — TRUNK_Y, where the trunk line sits
- `48 + (i+1) × 36px` — lane Y for branch index `i` (0-based)
- Total SVG height = `48 + 36 × N` for N branches, no internal
  scrolling; the page scrolls. At ~50 branches this is a 1800px chart,
  still manageable since real-world per-repo branch counts in a
  30-day window are typically 5–15.

**Trunk line**: 2px thick parchment-ink color (existing `--ink` token),
spans the chart's full inner width at `y = TRUNK_Y`.

**Branch arc** (one SVG `<path>` per row):

- Diverges from trunk at the branch's `firstEventAt` X-coord (a closed
  filled circle marker, 5px radius, at trunk Y).
- Cubic bezier downward to the branch's lane Y (lane Y = trunk Y +
  (laneIndex + 1) × LANE_HEIGHT).
- Horizontal line along lane Y.
- Cubic bezier back upward to trunk Y at:
  - `mergedAt` X-coord, ending in a closed circle marker (merged), OR
  - `lastEventAt` X-coord, ending in an OPEN circle marker (open or
    stale).

Path math:

```
const cp = (x2 - x1) * 0.15;  // bezier control-point offset
const d = `M${x1},${trunkY} C${x1+cp},${trunkY} ${x1+cp},${laneY}` +
          ` ${x1+30},${laneY}` +
          ` L${x2-30},${laneY}` +
          ` C${x2-cp},${laneY} ${x2-cp},${trunkY} ${x2},${trunkY}`;
```

**Color by status** (existing CSS tokens):
- `merged` → muted parchment (`--ink-muted`), stroke-width 1.5
- `open` → warm accent (`--accent`), stroke-width 2
- `stale` → neutral gray (`--ink-faded`), stroke-width 1.5

**Label per row**: `<text>` element placed at lane midpoint Y, centered
X within `[firstEventAt, endX]`. Content:

```
{branch}  ${totalUsd} · {sessionCount} sessions · {statusText}
```

Where `statusText` is `merged Mmm DD` / `open` / `last activity Mmm DD`.

Labels truncate at 56 chars with ellipsis. Full branch name surfaces
in a `<title>` child (native browser tooltip).

**Date axis**: top of chart, ticks via the existing `niceTimeTicks`
helper. Format: `Mmm DD` (or just `DD` for ticks within the same
month). 1px dashed gridlines drop down through the chart at each tick.

**Long-lived branches** (pre-date the window): the start marker is
replaced with an inward-pointing `«` chevron at `windowStart` X-coord.
Communicates "this branch existed before the window starts; its arc is
clipped left."

**Empty state**: section not rendered at all (the data layer returns
`null`). Avoids a "no branches" empty card on projects that legitimately
have no non-mainline activity (e.g. solo experiments on master).

## Interaction

**Click on a branch arc or label**:

1. If `featureKey` is set → navigate to `/feature/:featureKey`
2. Else if `prUrl` is set → open in new tab (`target="_blank"`)
3. Else → no-op (cursor stays default, no pointer)

**Hover**: native tooltip via `<title>` shows the full branch name +
status. The arc's stroke-width bumps 0.5px on hover for affordance.

## Architecture

### Files

- `src/dashboard/data/branches.ts` — NEW. ~120 lines. `buildBranchGraph()`
  + types. One responsibility: pull lifecycle records from
  `usage_events` + `session_prs` and assemble the VM.
- `src/dashboard/data/project.ts` — MODIFY. Call `buildBranchGraph()`
  and attach to `ProjectDetailVM.branchGraph` (nullable field).
- `src/dashboard/render/project.ts` — MODIFY. Emit the branch-graph
  section (HTML container + JSON `<script>` blob) when `branchGraph`
  is non-null. Drop between the trail-elevation card and the features
  card.
- `src/dashboard/static/dashboard.js` — MODIFY. Add `renderBranchGraph()`
  function (~180 lines per the research estimate). Wire it into the
  existing chart-initialization loop that already handles trail
  elevation.
- `src/dashboard/static/dashboard.css` — MODIFY. Add `.branch-graph`,
  `.branch-graph-trunk`, `.branch-graph-arc`, `.branch-graph-label`,
  `.branch-graph-marker` styles. ~40 lines.
- `tests/branches.test.ts` — NEW. Lifecycle classification, cost
  rollup, origin/-prefix matching, mainline exclusion, window
  filtering. No SVG/DOM tests.

### Boundaries

- `branches.ts` owns the SQL + lifecycle classification. Returns a
  pure VM, no rendering concerns.
- `project.ts` (data) owns the wiring; no SQL of its own beyond the
  one call to `buildBranchGraph()`.
- `project.ts` (render) owns the HTML structure; no math.
- `dashboard.js` owns the SVG drawing; reads VM from JSON blob, knows
  nothing about SQL.

No file added is over 200 lines.

## Failure modes

- **No usage_events for repo** → `buildBranchGraph()` returns `null`.
  Section skipped.
- **All branches are mainline** → `branches[]` is empty → return `null`.
- **Branch in `usage_events` but no matching PR** → `mergedAt` null,
  status classified as `open` or `stale` based on `lastEventAt`.
  Correct: from Tokentrail's POV the branch isn't merged.
- **PR with `pr_state='open'`** → `mergedAt` stays null, status `open`.
- **Branch name with weird chars** (slashes, colons) → labels render
  as-is (SVG `<text>` handles them). `featureKey` lookup uses exact
  string match against the CSV.
- **Many overlapping labels** → static lane-midpoint placement keeps
  each label inside its lane. Lanes are vertically separated, so the
  worst case is label clipping at lane edges (handled by truncation).
- **`session_commits.branch` CSV junk** (`origin/foo, foo`) → not
  consulted by this feature. Documented in the data section.

## Research — why no chart library

Investigated git-graph-specific libs (gitgraph.js, Mermaid `gitGraph`,
Mermaid `gantt`) and general chart libs (ECharts, Observable Plot,
uPlot, Chart.js, ApexCharts). Findings:

- **gitgraph.js**: archived 2021, dead.
- **Mermaid `gitGraph`**: sequential commit layout, no time axis.
- **Mermaid `gantt`**: bars, no arcs back to a trunk.
- **ECharts** with `custom` series + `renderItem`: the only general
  candidate that genuinely lets you return arbitrary SVG `path` shapes
  per data row. ~110–140 KB gzipped tree-shaken. Worth it ONLY if we
  also want zoomable axis, dataZoom slider, or brushable selection —
  none of which are in scope.
- **Observable Plot**, **uPlot**, **Chart.js**, **ApexCharts**: none
  can draw the trunk-to-trunk arc declaratively. All would require
  custom plugins/hooks that amount to hand-rolling.
- **Hand-rolled**: ~180–220 lines, same complexity profile as the
  existing 155-line trail-elevation chart. The three "hardest"
  sub-problems (date scaling, bezier path math, label placement) are
  ~10–20 lines each; no library helps with label placement anyway.

Decision: **hand-roll, zero new deps**. ECharts is the rescue option
if scope expands to include zoom/brush/timeline-scrubbing later.

## Testing strategy

`tests/branches.test.ts`:

1. `lastEventAt` classification: insert events on 2 branches, verify
   `lastEventAt = MAX(timestamp)` and `firstEventAt = MIN(timestamp)`.
2. Merged classification: insert events + a `session_prs` row with
   `pr_state='merged'` → `status = 'merged'`, `mergedAt` populated.
3. Open vs stale: insert events with `lastEventAt` 2 days ago (open)
   vs 14 days ago (stale), no PR → status correct.
4. Mainline exclusion: insert events on `master`/`main`/`trunk` →
   none appear in `branches[]`.
5. Origin/ prefix matching: insert PR with `branch='origin/feat/x'`
   and events with `branch='feat/x'` → matched, `mergedAt` populated.
6. Window filter: insert events 60 days old → branch excluded.
7. Cost rollup: insert 3 events on one branch → `totalUsd` is the sum.
8. Distinct session count: insert events from 2 sessions on one branch
   → `sessionCount = 2`.
9. featureKey lookup: insert `feature_rollups.branches` CSV containing
   the branch → `featureKey` populated.
10. Empty result: no non-mainline branches → `buildBranchGraph()` returns
    `null`.

No tests for SVG rendering — that's verified by eyeball iteration
against real data per the [Manual verification](#manual-verification)
rule in `CLAUDE.md`.

## Manual verification

After implementation, view `/project/repo:loschenbd/tokentrail` and
confirm:

1. Section renders below the trail-elevation card, above the features
   card.
2. Trunk line spans the chart width.
3. Each non-mainline branch with recent activity has an arc.
4. Merged branches show closed-circle markers; open branches show
   open-circle markers.
5. Labels are readable (no overlap, ellipsis works on long names).
6. Clicking a branch arc navigates to its feature page (when matched)
   or opens its PR (when matched) or does nothing (when neither).
7. Render against a project with 0 non-mainline branches → no section.
8. Render against a project with 20+ branches → no visual breakage.
