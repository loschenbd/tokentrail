# Feature page redesign — design spec

**Date:** 2026-08-02
**Route:** `/feature/:key` (`src/dashboard/render/feature.ts`, `src/dashboard/data/feature.ts`)
**Status:** approved (mockup signed off), building on `feat/feature-page-redesign`.

## Goal

Turn the Feature detail page from a thin header + a near-useless cumulative
step-chart + a raw monospace dump of every commit/PR into a **shipped-output-first
financial statement**: what did this feature's spend *buy*, structured as a
scannable ledger. Grounded in a deep-research pass (25 claims verified 3-0 across
Grafana / Datadog / Honeycomb / Vantage / Google Charts + peer-reviewed dataviz).

## Research → principles (what each zone honors)

1. **Event-annotated timeline.** Overlay commits (point marks) + merged PRs +
   releases (flags) on the cost timeline; markers carry payload on hover. Surface
   salient events (releases, merged PRs), not every commit.
2. **Efficiency = unit cost shown *with* its denominator** (cost-per-PR,
   cost-per-commit), never a cross-feature ranking (ratio fallacy, Royal Society
   2024). Safe here because it's one feature describing its own spend.
3. **Itemized ledger = APM trace-waterfall** — one row per session, a magnitude
   bar vs a full-width "= total" reference, identity/status inline, commits/PRs on
   expand (collapsed by default).
4. **Topics = part-to-whole**, 2–5 rows + "Other", horizontal bars (lengths beat
   pie angles).

## Layout

Full-width **statement header**, then a two-column grid (`1.5fr / 1fr`, mirrors
`.pp-*` on the project page; collapses to one column ≤820px, main-then-rail):

- **Left (main):** ② What shipped, ④ Sessions ledger — the itemized output story.
- **Right (rail):** ③ Cost & activity, ⑤ Topics — supporting visuals.

### ① Statement header (full width)
Eyebrow (`key · branch`), feature name + lifecycle glyph (◇ opened / ✓ closed /
☾ stale — same glyphs/derivation as the project page), big `$total` labeled
*estimated*, and a chip row of computed stats: **N PRs · N commits · N releases ·
N sessions · ~$X/merged-PR · ~$Y/commit**. The two efficiency chips get the accent
border. **Drop the fake "▲100% vs prior"**: show delta only when the prior window's
spend > 0 (`deltaPct: number | null`).

### ② What shipped (hero, main)
Merged PRs grouped under the **releases** they rode, newest first. Each group: a
`vX.Y.Z` tag, date, and change-commit count; under it the merged PR row(s)
(`#NN` link + title + `merged` badge) and a folded "+ N change commits" summary.
Squash-twins collapse (a PR `#64` and its `…(#64)` commit are one).

### ③ Cost & activity (rail, ADAPTIVE)
- **≥5 active days:** full daily-cost bar chart with commit ticks + merged-PR
  diamonds + release flags overlaid; hover a marker → its message/link.
- **<5 active days (sparse):** collapse to a single-row **event strip** (same
  markers on a bare time axis, no y-axis) + a legend.
- `activeDays` = count of days with cost in-window.

### ④ Sessions ledger (main, trace-waterfall)
One row per session, sorted by cost desc: caret + serif title, `$cost`, a
magnitude bar (`width = cost / featureTotal`, full-width bar = the total), and
inline `date · N commits · N PRs · shortid`. Collapsed by default; expand →
deduped commits **grouped by release** (squash-twins + release commits folded
out) + PRs with state. Reuses the existing `[data-expand-target]` handler.

### ⑤ Topics (rail, part-to-whole)
Existing clusters as horizontal bars; enforce ≤5 rows + a labeled "Other"
roll-up. Bar width = share of the leader; label = share of feature total.

## Data-layer contract (`data/feature.ts` + new pure helper `feature-shipped.ts`)

New/changed `FeatureDetailVM` fields (additive; existing consumers unaffected):

- `status: 'opened' | 'closed' | 'stale'` — closed if any of the feature's PRs is
  merged; else stale if `lastActive < now - STALE_DAYS`; else opened. `STALE_DAYS`
  imported from `data/branches.ts`.
- `mergedPrCount`, `commitCount` (deduped: non-release commits with squash-twin
  pairs collapsed → each PR counts once, each non-PR commit once), `releaseCount`.
- `costPerPr: number | null`, `costPerCommit: number | null` (null when denom 0).
- `deltaPct: number | null` (null when prior window spend is 0).
- `activeDays: number`.
- `releases: Array<{ version; date; prs: {repo,prNumber,title,url}[]; changeCommitCount }>`
  newest-first, plus a trailing `version:null` "Unreleased" group when trailing
  non-release commits exist.
- `events: Array<{ date; type:'commit'|'pr'|'release'; label; sha?; url?; prNumber? }>`
  for the chart/strip payload.
- `sessions[].commits` deduped (drop squash raw-twins), keep PR linkage.

**Pure helper `feature-shipped.ts`** (unit-tested in isolation):
- `dedupeCommits(commits)` → `{ changeCommits, releases, prNumbersBySubject }`;
  a squash commit matches `/\s\(#(\d+)\)$/`, its raw twin is the commit whose
  subject equals the squash subject minus the `(#NN)`.
- `deriveShipped(commits, prByNumber)` → the `releases[]` structure by walking
  commits chronologically and closing a group on each `release: vX.Y.Z` commit.

## Files

- `src/dashboard/data/feature-shipped.ts` — **new** pure derivation + types.
- `src/dashboard/data/feature.ts` — extend VM, call helper, add status/efficiency.
- `src/dashboard/render/feature.ts` — 5 zones + two-column.
- `src/dashboard/static/dashboard.css` — `.fp-*` classes (header chips, shipped,
  event-strip, ledger waterfall, topics). Reuse Midori tokens.
- `src/dashboard/static/dashboard.js` — replace `renderTrailElevation` with the
  adaptive `renderFeatureActivity` (daily chart ≥5d / event strip <5d, event
  markers with tooltips). Keep `setupRowExpanders`.
- Tests: `tests/feature-shipped.test.ts` (new, pure), extend
  `tests/feature-data.test.ts` + `tests/feature-render.test.ts`.

## Constraints honored
- Costs stay labeled *estimated* (CLAUDE.md rule 3). No schema changes / migrations
  (derive from existing tables). Attribution untouched (rule 5). Small tested
  phases (rule 10). Fantasy flavor stays out of the technical structure (rule 8) —
  "Trail elevation" microcopy retired in favor of plain "Cost & activity".
