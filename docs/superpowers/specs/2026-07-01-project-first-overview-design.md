# Project-first overview redesign

**Date:** 2026-07-01
**Status:** approved for planning
**Supersedes portions of:** [`2026-06-30-chart-redesign-design.md`](2026-06-30-chart-redesign-design.md)

## Goal

Invert the overview's primary framing from **feature-driven** to
**project-driven**, matching the natural hierarchy of a codebase (project) →
work-within-the-codebase (feature). At a glance the overview answers "which
codebase is driving cost right now"; features become a drill-down concern
accessible via hover, inline sub-bars, and existing feature detail pages.

Also introduces a persistent **unattributed** surface that both quantifies
unlabeled mainline work and prompts the user to run classification tools.

## Motivation

The chart redesign shipped in PR #38 (merged 2026-07-01) picked
**feature-first** stacked bands. Immediate user feedback: features are
children of projects; a feature has exactly one parent project. Showing
features as top-level bands ignores hierarchy and doesn't answer the more
budget-relevant question ("which codebase should get more or less of my
attention?").

Additionally, `uncategorized-mainline` occupied a permanent striped band at
the top of the previous chart — a passive reminder that some work is
unlabeled but no clear next action. Users want an explicit affordance to
run the labeling tools.

## Non-goals

- Delete `/feature/<key>`. Feature detail pages stay; they are still valid
  drill destinations from hovers and project pages.
- Change the underlying attribution rollup model. `feature_rollups` and
  session→project→feature attribution are unchanged. Only the presentation
  layer flips.
- Redesign the header, sidebar cards other than the new unattributed card,
  Worth-a-look, or Recent commits.

---

## A. Trend chart — project-first stacked area

### Data

- **Bands** = top **6** projects by 30-day $ + `Other` (rank 7+).
- `uncategorized-mainline` **is dissolved into each project's total**. It
  does NOT get a top-level band. Individual project rows on the trend chart
  contain their own unattributed portion silently.
- `Other` band aggregates ranks 7+ across all projects.

### Ordering and stack

- Stack **bottom-up** by descending 30d total: largest real project at the
  bottom of the stack, then next-largest above it, up to rank 6.
- `Other` sits **above** all six real projects at the top of the stack.
- No striped/hatched band on the trend chart at all (`__striped__` sentinel
  usage moves entirely to the burn paths sub-bar in Section C and the
  unattributed card in Section D).

### Colors

- Add `colorForProject(projectKey: string): string` to
  `src/dashboard/lib/feature-colors.ts`. Same 8-color Okabe-Ito palette as
  `colorFor(featureKey)`. Same Murmur3-style finalizer hash.
- `colorFor(featureKey)` keeps its current behavior; feature colors continue
  to appear on `/feature/<key>` and in trend-chart hover tooltips (Section B).
- `Other` band uses a stable neutral (`#9CA3AF`, unchanged from previous
  design).
- No striped fill anywhere on the trend chart itself.

### Legend

- Right-side vertical list, same shell as today.
- **Rows** = two-tier sort matching the previous design's convention:
  non-clickable buckets first by descending `stackPosition` (so `Other`
  pins to the top of the legend), then clickable real projects by
  descending `totalUsd` (largest-first, standard scannability). Matches
  the sort helper landed in PR #38 for feature bands.
- Each row = `swatch · project name · $total`.
- Real-project rows are clickable and link to `/project/<key>`. `Other` is
  non-clickable.
- Reuse existing legend hover / click semantics from the feature-first
  design (active row lights, others dim).

### Click behavior

- Click a real-project **band** on the chart → `/project/<key>`.
- Click a real-project **legend row** → `/project/<key>`.
- Click `Other` band or legend row → no navigation.

### Empty state

- If no project has spend in the window, render the existing empty state
  shell (`renderEmptyState()`) — unchanged.
- If exactly one project has spend, render a single band. Legend has one
  row. Tooltip works normally.

---

## B. Trend chart hover — per-project feature breakdown

The hover tooltip has two blocks:

**Top block: per-project totals for the day**
- Header: date (localized, weekday + month + day).
- Rows: every project with non-zero spend for that day, sorted by $
  descending. Row = swatch (project color) · project name · $daily.
- If a project has spend on the day but its band isn't in the top 6, it
  aggregates into the `Other` row (as elsewhere).

**Bottom block: features inside the ACTIVE band's project**
- Only rendered when the cursor is over a specific band (i.e., a project
  is "active").
- Header line: `Inside <project-name>:`.
- Rows (up to 3): swatch (feature color, from existing `colorFor`) ·
  feature name · $daily-inside-project. Sorted by $ desc.
- If the project has unattributed spend for the day, it appears as one
  row: no swatch (or the previous striped swatch, for consistency with
  Section C sub-bars) · `unattributed` · $.
- `+ N more` line if truncated.
- If the project has zero features and only unattributed work, show only
  the `unattributed` row.

**Click behavior**
- Click a project band → `/project/<key>`.
- Feature swatches in the bottom block are NOT clickable in v1 (kept simple;
  users can navigate to `/project/<key>` first, then click into `/feature/<key>`).

**Zero-cost days**
- Cursor over a zero-cost day (`total === 0`) shows only the date; both
  blocks omitted.

---

## C. Burn paths — rows with inline feature sub-bar

Each row now has two horizontal bars stacked vertically:

**Row shape (top to bottom):**
```
[rank]  [project swatch]  [project name]  [$total · %]
        [main bar — % of grand total]                     ← existing
        [feature sub-bar — 100% of THIS project's total]  ← new
```

**Main bar (existing)**
- Unchanged. `% of grand total` width, single project color fill.

**Feature sub-bar (new)**
- Height ~8px, width matches the row's content column.
- Represents 100% of the project's total; each segment is a feature
  proportional to its share of the project.
- Segments colored by `colorFor(featureKey)` — feature colors are still
  meaningful here.
- Unattributed spend inside the project renders as a **striped segment**
  (`__striped__` fill pattern from the existing design) at the segment's
  natural sort position by $ desc.
- Segments are sorted **by $ desc** within the sub-bar (not by category
  type).
- Minimum visible segment width = 2px; below that, aggregate into an
  `Other-features` neutral segment on the right.

**Project swatch (new — replaces old dominant-feature swatch)**
- Column showing the project's own color (`colorForProject`) — 12px round
  or square swatch to the left of the project name.
- Ensures the trend chart, its legend, and the burn paths swatches all
  agree on what color a given project is.
- **This is a visible change on the current view.** Every swatch in burn
  paths recolors.

**Legibility**
- If a project row is heavy on unattributed (e.g., 80%+ striped), the row
  still reads as a clear stacked bar because the striped color is a
  neutral gray. No special-case rendering.
- If a project has zero features and only unattributed, the sub-bar is
  100% striped.

**Sort**
- Rows sorted by project total $ desc (same as today).

---

## D. Unattributed card (new sidebar card)

**Placement**
- Sidebar column, between "This week" and "Worth a look."

**Content**
1. **Big number line:** `$X unattributed  ·  N% of trail`. Uses the same
   typographic scale as "This week" hero number.
2. **Sparkline:** 30d daily unattributed $, ~60px tall. Uses the striped
   pattern fill for consistency with the sub-bar in Section C. No axes or
   labels — the big number sets the scale.
3. **Top 3 projects by unattributed $ in the window.** Each item = project
   swatch + project name + `$unattributed / $projectTotal` progress bar.
   Sorted by unattributed $ desc.
4. **CTA button:** `Run tokentrail infer-mainline →`. On click, copies the
   string `tokentrail infer-mainline` to clipboard using
   `navigator.clipboard.writeText`. On success, briefly changes the button
   label to `Copied ✓` for 1.5s. No execution, no shelling out.

**Empty state**
- If total unattributed $ in the window is 0, **the card is not rendered
  at all**. No placeholder, no "0 unattributed" state. When there's
  nothing to label, the card gets out of the way.

**Data**
- Reuse the same query that today's chart uses to compute
  `uncategorized-mainline` totals, but pivoted per-project instead of
  aggregated.

---

## E. Colors module — `feature-colors.ts` changes

### Additions

- Export `colorForProject(projectKey: string): string`. Same palette,
  same hash strategy as `colorFor`. Independent hash keyspace (so a project
  and a feature with the same slug do not necessarily collide — desired,
  because they inhabit different visual layers).
- Consider extracting a shared internal `pickFromPalette(key)` helper so
  the two exports share hash logic. Not required; both can inline the same
  finalizer.

### Unchanged

- `PALETTE` array (8-color Okabe-Ito).
- `colorFor(featureKey)`.
- `OTHER_KEY`, `OTHER_NAME`, `OTHER_COLOR` (still used for the trend
  chart's `Other` band and the burn paths sub-bar's `Other-features`
  segment).
- `UNCATEGORIZED_KEY`, `UNCATEGORIZED_BASE_COLOR`, `STRIPED_SENTINEL`
  (still used for the striped fill in burn paths sub-bars and the
  unattributed card sparkline).

### Tests

- New test file `tests/feature-colors.test.ts` gains 3 assertions:
  1. `colorForProject('foo')` is deterministic (same input → same output).
  2. `colorForProject` returns a value from `PALETTE`.
  3. `colorForProject` and `colorFor` may return different colors for the
     same slug (independent keyspaces).

---

## Data / query changes

### `overview.ts` payload

Replace the current `features[]` and `days[].bands` shape with a
**project-centric** payload:

```ts
{
  windowDays: number;
  totalUsd: number;
  weekUsd: number;
  weekSessions: number;
  deltaPct: number;

  // Project-first bands for the trend chart
  projects: Array<{
    key: string;              // project key (repo/user slug)
    name: string;             // display name
    color: string;            // colorForProject(key)
    totalUsd: number;
    clickable: boolean;       // false for Other, true for real projects
    stackPosition: number;    // 0 = bottom, larger = higher
  }>;

  // Per-day breakdown
  days: Array<{
    date: string;             // YYYY-MM-DD
    total: number;
    // project-first bands for the stacked area
    bands: Record<string, number>;  // projectKey → $ for this day
    // per-project feature breakdown for the hover bottom block
    featureBands: Record<string, Record<string, number>>;
    // projectKey → featureKey → $ for this day
    // "__unattributed__" is a reserved featureKey inside featureBands
    unattributedTotal: number;      // total unattributed across all projects this day (for sparkline)
    commits: number;
    prs: number;
  }>;

  // Burn paths sub-bar payload (per-project feature mix, window totals)
  projectFeatureMix: Array<{
    projectKey: string;
    features: Array<{
      key: string;            // featureKey or "__unattributed__"
      name: string;
      color: string;          // colorFor(featureKey) or STRIPED_SENTINEL
      totalUsd: number;
    }>;
  }>;

  // Unattributed card payload
  unattributed: {
    totalUsd: number;
    pctOfTrail: number;
    sparkline: Array<{ date: string; usd: number }>;  // 30 items
    topProjects: Array<{
      key: string;
      name: string;
      color: string;
      unattributedUsd: number;
      projectTotalUsd: number;
    }>;                        // up to 3, sorted desc
  } | null;                    // null when totalUsd === 0

  topProjects: Array<...>;    // existing burn paths ranked list, unchanged shape except swatches
  anomalies: Array<...>;      // unchanged
  recentCommits: Array<...>;  // unchanged
}
```

### DB queries

Two new aggregations against `feature_rollups`:
1. Per-day per-project totals (for the trend chart bands).
2. Per-day per-project per-feature totals (for the hover bottom block +
   burn paths sub-bar). One query result set can drive both.

Reuse existing indices; no schema migration.

---

## Rendering / JS changes

- `dashboard.js` `renderTrend()` rewrite:
  - Bands = projects, not features.
  - Tooltip has two blocks (top: project totals; bottom: features inside
    active project).
  - No striped fill for any band on the trend chart.
  - Click on band → `/project/<key>`.
- `dashboard.js` gains `renderUnattributedCard()`:
  - Reads a JSON payload embedded in the sidebar card.
  - Draws sparkline via uPlot in single-series line mode (or plain SVG —
    lighter weight is fine).
  - Wires the clipboard CTA.
- `dashboard.js` gains `renderBurnPathsSubBars()`:
  - Reads per-project feature mix from the payload.
  - Draws sub-bars as inline `<div>` segments with % widths (no canvas
    needed at this size).
- `overview.ts` render layer:
  - Emits the new payload shapes.
  - Adds the unattributed card node with its own `<script
    type="application/json">` payload.
  - Adjusts burn paths markup to include the sub-bar row.

---

## Edge cases

- **No spend at all** → existing empty state, unchanged.
- **Exactly one project** → single band on trend chart, single legend row,
  single burn paths row with sub-bar. Unattributed card follows its own
  rules independently.
- **All spend unattributed** → trend chart still shows one band per
  project (unattributed folds into project total silently). Hover shows
  100% of each project as unattributed. Burn paths sub-bars are 100%
  striped. Unattributed card is prominent.
- **Zero unattributed** → unattributed card is hidden.
- **Fewer than 6 projects** → no `Other` band or row.
- **Project has spend but exactly zero features and zero unattributed** →
  impossible by construction (unattributed captures all otherwise-tagged
  work), but if it occurs, the burn paths sub-bar renders a single
  striped `unattributed` segment.

---

## Testing

- **Feature colors module** — 3 new assertions per Section E.
- **Overview payload** — extend `tests/dashboard-data.test.ts`:
  - New `projects[]` shape asserts (top 6 + Other, stack positions,
    colors from palette, correct totals).
  - `days[].bands` keyed by project (not feature).
  - `days[].featureBands` per-project-per-feature totals sum to `total`.
  - `projectFeatureMix` shape assertions.
  - `unattributed` payload:
    - null when total = 0.
    - Correct totals and pct when > 0.
    - Sparkline is 30 items covering the window.
    - Top projects sorted by unattributed $ desc, capped at 3.
- **Overview render** — extend `tests/overview-render.test.ts`:
  - Trend legend uses `data-project-key` (renamed from `data-feature-key`).
  - Burn paths rows include a sub-bar with correct `data-feature-key`
    attrs.
  - Unattributed card renders when total > 0, hidden when total = 0.
  - CTA button has the correct `data-clipboard` attr.
- **Dashboard.js** — light DOM-level assertions:
  - Sub-bar segments sum to 100% width.
  - Tooltip active-band detection uses project keys, not feature keys.
  - Clipboard copy handler wires up.

---

## YAGNI list (explicitly OUT of scope)

- Any per-user color customization / palette override UI.
- Sparkline on the trend chart itself (the sparkline is only on the
  unattributed card).
- Toggle between project-first and feature-first views. Project-first is
  the primary framing; a toggle would create two ways to hold the tool and
  neither would get polish.
- Feature swatches on the trend chart hover being clickable (v2 could add;
  v1 leaves them as labels).
- Server-side execution of `tokentrail infer-mainline` from the button
  click. Clipboard copy only; user runs it in their terminal.
- Historical / trended unattributed reduction ("you labeled 20% more this
  week"). Might be a "Worth a look" trigger later.
- Per-user session / recency weighting for project ranking (top 6 is
  window-total-$ based only).
- Sub-bar hover / click behavior on burn paths. Sub-bar is decorative in
  v1; click goes through the row's existing link to `/project/<key>`.

---

## Migration

- No DB migration.
- Homebrew tap version bump required for shipped users; local dev picks
  up on next `pnpm build`.
- The just-merged chart-redesign PR (#38) code will be substantially
  rewritten — `dashboard.js renderTrend`, `overview.ts` payload builder,
  and `feature-colors.ts`. `dashboard.css` gets new classes for the
  sub-bar and unattributed card. Two files not touched by the previous
  redesign will be touched here: `overview.ts` render adds the
  unattributed card markup, and a new module for the sparkline draw.

---

## Coverage mapping (spec section → sub-plan tasks)

To be produced by writing-plans; sketching here to prove no section is
implicit-only:

- A (trend chart) → new bands + colors + click behavior in `renderTrend`
  and the overview payload.
- B (hover) → tooltip rewrite in `dashboard.js`.
- C (burn paths sub-bar) → new markup in `overview.ts` render + JS
  drawing helper + CSS.
- D (unattributed card) → new render function in `overview.ts`, new JS
  helper (sparkline + clipboard), payload builder.
- E (colors module) → single-file diff in `feature-colors.ts` + tests.
