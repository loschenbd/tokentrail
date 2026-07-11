# Today Page: Hover Tooltips for Charts

**Date:** 2026-07-11
**Status:** Approved

## Problem

The Today page's two chart surfaces have no real hover information:

1. **Burn-by-hour bars** rely on a native `title` attribute — slow to
   appear, unstyled, and invisible on touch-adjacent trackpads with quick
   sweeps.
2. **Burn-path share bars** render a static single-color fill with no
   tooltip, while Overview's identical-looking bars carry feature-segmented
   fills with hover tooltips.

Key discovery: Overview's segmentation + tooltips hydrate from a
`#burn-paths-data` JSON script tag (`dashboard.js#renderBurnPathsSubBars`,
keyed on the tag's existence). `buildTodayVM` already computes the needed
`projectFeatureMix` via its internal `buildOverview({ days: 1 })` call and
discards it. Emitting the tag on Today lights up the existing machinery
unchanged.

## Design (Approach A: embedded JSON + shared-tooltip pattern)

### Data layer — `src/dashboard/data/today.ts`

- `TodayVM.hourly` entries gain a breakdown:
  `{ hour: number; usd: number; projects: { name: string; usd: number; color: string }[] }`
  (still always 24 entries, zero-filled; `projects: []` for empty hours).
- One new query: today's `usage_events` grouped by hour + project bucket,
  using the same `bucketProject` helper Overview uses on `project_dir`.
  Within each hour, projects sorted by usd descending.
- Colors from the same 30-day `projectColors` reference already fetched for
  top-project color re-mapping; unknown keys fall back to `#9CA3AF`.
- `TodayVM.projectFeatureMix: OverviewVM['projectFeatureMix']` — passed
  through from the internal day-1 overview build (currently discarded).

### Render — `src/dashboard/render/today.ts`

- Emit two JSON script tags in the non-empty layout, using the same
  `jsonForScriptTag` escaping Overview uses:
  - `<script type="application/json" id="burn-paths-data">` —
    `vm.projectFeatureMix`
  - `<script type="application/json" id="hour-burn-data">` — only hours
    with `usd > 0`: `[{ hour, usd, projects: [{ name, usd, color }] }]`
- Each `.hour-bar` gains `data-hour="<n>"`. The native `title` attribute is
  removed (would double up with the JS tooltip).
- The static solid `subbar-segment` fill stays — it is the no-JS fallback;
  the hydrator overwrites `container.innerHTML` when JS runs.

### Client — `src/dashboard/static/dashboard.js`

- `renderBurnPathsSubBars()` — no changes; it now finds its tag on Today.
- New `renderHourBarTips()`, called from the same init path:
  - Parse `#hour-burn-data`; bail silently if absent/malformed (same
    guard style as `renderBurnPathsSubBars`).
  - For each `.hour-bar[data-hour]` with an entry: `mouseenter` fills a
    shared body-level tooltip; `mouseleave` hides it. Bars for zero-spend
    hours get no listeners.
  - Tooltip content: header `HH:00–HH+1:00 · $<usd, 2dp>`, then one row
    per project (swatch, name, `$` amount — 2dp under $1, else 0dp),
    capped at 6 rows with a final muted `+n more` row.
  - Positioning: centered above the bar, clamped to `[8px, viewport−8px]`
    horizontally — same math as `attachSubbarSegmentTip`. Display before
    measuring (offsetWidth is 0 while `display:none`).
  - The shared element is a second singleton (`.chart-tooltip
    .hour-tooltip`) so the single-row subbar tip's flex layout is
    untouched.

### CSS — `src/dashboard/static/dashboard.css`

- `.hour-tooltip { flex-direction: column; align-items: stretch; }` plus
  header and row styles matching the parchment tooltip look. Inherits
  `pointer-events: none` from `.chart-tooltip` (required: the tip sits
  directly above the hovered bar and would otherwise eat the hover that
  opened it).

## Error handling

- Malformed/absent JSON tags: hydrators return silently (existing
  convention); the page still shows the static fills and bare bars.
- All names in JSON pass through `jsonForScriptTag` (server) and `esc`/
  `escapeAttr` (client) — same as Overview.
- Hours 0–2 and 21–23: viewport clamping keeps the tooltip on-screen.

## Testing

- Data: per-hour breakdown rows sum to that hour's `usd`; ordering desc;
  empty hours have `projects: []`; `projectFeatureMix` present and keyed
  by `topProjects.key`.
- Render: both script tags emitted with expected JSON content; `data-hour`
  on all 24 bars; no `title` attribute on bars; static subbar fill still
  present.
- Client JS: no DOM test rig exists in the repo — verified live in a
  browser at the end (tooltip on hover, breakdown rows, clamping at the
  strip's edges, subbar segments + tips on Today).

## Out of scope

- Touch/tap support for tooltips.
- Any Overview changes.
- Touch/tap support was the only cut; note that `jsonForScriptTag`
  consolidation is IN scope (below), resolving a parked review finding
  rather than adding a fourth copy.

## Targeted cleanup folded in

`jsonForScriptTag` exists as three identical private copies
(`overview.ts:120`, `project.ts:92`, `feature.ts:122`). This change moves
it to `render/shell.ts` as an export; `today.ts` imports it, and the three
existing copies are deleted in favor of the import. Behavior unchanged —
covered by the existing render tests for those pages.
