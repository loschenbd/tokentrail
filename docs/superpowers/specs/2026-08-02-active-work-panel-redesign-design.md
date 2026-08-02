# Active Work Panel Redesign — Design

**Date:** 2026-08-02
**Status:** Approved (design + interactive mockup + research signed off)
**Mockup:** https://claude.ai/code/artifact/1d108a39-4f8d-42c1-a987-25b61d9a6c64
**Research basis:** deep-research report (21 sources, 19/25 claims adversarially confirmed). Verdict: the git-topology "railroad" serves only 1 of the panel's 4 jobs and cannot encode time or magnitude; replace it with a ranked table-with-encodings where each of the four jobs maps to a distinct visual channel (Cleveland-McGill / Mackinlay: magnitude → bar length; category → hue).

## Goal

Gut the SVG swimlane/railroad branch graph in the "Active work · last 30d" panel and replace it with a **ranked branch table** where each row is one branch. Pure presentation over existing `BranchGraphVM` data — no new queries or view-model change.

## The four jobs → four channels

| Job | Channel |
|---|---|
| Spend per branch | **Bar length** off a shared zero baseline (share of the top branch's spend) |
| Lifecycle over time (when) | **A compact 30-day activity-window track**: a segment spanning first-activity → last-activity/merge, positioned on the fixed window |
| Active / merged / stale status | **Dot hue + row ghosting**: open = filled accent dot; merged = ringed dot + `✓`; stale = hollow dot + the whole row at reduced opacity |
| Git topology (diverge/merge) | **Demoted** to just the merge `✓` marker — no rendered graph |

## Layout

Per-row grid (in the wide main column): `[status dot] [branch name, mono, ellipsized] [activity track] [spend bar + $amount] [sessions]`. A column-header row above carries the window endpoints (`Jul 12` … `Aug 2`) over the track and `spend` / `sess` labels.

- **Sort:** branches by `totalUsd` descending. **Stale stays in spend order** (ghosted in place — not sunk to the bottom).
- **Fold:** show the top 10 rows; fold the remainder behind a toggle labeled `+ N more · $M total` (same pattern/handler as the Features tail). Progressive enhancement: tail is `hidden` by default, revealed by JS; with JS off it stays collapsed.
- **Keep** the existing "Recent commits" inline list below the table unchanged.
- **Keep** the `$<totalBranchUsd>` amount tag in the card header.

## Activity-window track

A thin full-width track per row representing the fixed 30-day window (`branchGraph.windowStart` → `windowEnd`). A segment is drawn from `firstEventAt` to `mergedAt ?? lastEventAt`, positioned by fraction of the window:
`left% = clamp01((first − start)/(end − start))`, `width% = max(clamp01((end − first)/(end − start)), ~4%)` so a single-day branch is still visible. Timestamps parse with `new Date(iso).getTime()`; window bounds are `YYYY-MM-DD`. Computed **server-side in `project.ts`** (static HTML, no JS needed to draw the track). Merged segments end flush at the merge point; stale segments render dashed/ghosted (they inherit the row's reduced opacity).

## What's removed

- The `#branch-graph` mount + its `<script type="application/json" id="branch-graph-data">` payload in `renderActiveWork`.
- `renderBranchSummary` (the Open/Merged/Stale bucket columns) — superseded by the per-row status encoding.
- The `renderBranchGraph()` function in `dashboard.js` (≈ lines 671–872) and its invocation (≈ line 1203). **Do NOT** remove the shared helpers `niceTimeTicks`, `fmtTickDate`, `truncate` — `renderTrailElevation` still uses them.
- The `jsonForScriptTag` import in `project.ts` **iff** it has no other user after the mount is gone (verify by grep).

## Non-goals

- No change to `src/dashboard/data/branches.ts` / `project.ts` view-model, queries, or routes. The redesign consumes existing `BranchLifecycle` fields (`branch`, `firstEventAt`, `lastEventAt`, `mergedAt`, `status`, `totalUsd`, `sessionCount`) and `BranchGraphVM` (`windowStart`, `windowEnd`, `days`, `totalUsd`).
- No new dependencies. No charting library — the mockup proves plain inline HTML/CSS suffices.
- Not touching the menubar app.

## Constraints

- Every color a `var(--color-*)` token; both themes correct. Magnitude → bar length only (never area/color); status → hue (never cost). Stale reinforced by opacity, not carried by color saturation alone.
- Branch name in `var(--font-mono)`; card/section labels in the Spectral naming voice.
- The fold toggle should share the Features tail's mechanism (one generic `[data-tail-toggle]` handler over a `.tail-body[hidden]` sibling), not a second copy-pasted handler.

## Testing

- `tests/project-render.test.ts` active-work assertions rewritten: rows carry branch name + `$` + a spend-fill + an activity segment; merged rows carry `✓`; stale rows carry a `stale` class; the fold toggle names count + summed dollars; the `#branch-graph` mount and `branch-graph-data` payload are **gone**; recent commits still render.
- A test that the activity segment's `left`/`width` are within 0–100% for a branch whose window is known.
- Both themes verified via headless screenshots at desktop + mobile before release.

## Rollout

Single dashboard-only release (no menubar bundle). Re-capture the `feature-detail` marketing screenshots afterward (this panel is on that page).
