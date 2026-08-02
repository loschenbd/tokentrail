# Project Page Redesign — Design

**Date:** 2026-08-02
**Status:** Approved (design + interactive mockup signed off)
**Mockup:** https://claude.ai/code/artifact/bdd3e354-8640-411c-aa04-447c29308502

## Goal

Restructure the project detail page (`/project/:key`) so the summary reads at
a glance and the page uses desktop width, without changing any data or route.
Pure presentation: `src/dashboard/render/project.ts` + `dashboard.css` (+ a
small branch-graph layout tweak). No view-model, query, or attribution change.

## Problems being solved

1. **Features list buries signal.** 24 rows at flat weight; rows 1–4 are ~67%
   of spend while ~14 rows are `$0–4 · 0%`. Six data points per row compete;
   the per-row sparklines are mostly flat noise. No relative-magnitude visual.
2. **Git-graph block is walled text.** "Open/Merged/Stale" render as
   slash-joined runs with `$` buried inline; long branch labels are hard to
   scan and overflow on mobile.
3. **Hero has flat hierarchy.** The real headline — down 54%, −$1,174 — is
   tiny muted text while `$992` gets all the size.
4. **Single-column layout wastes desktop width.** Eight stacked full-width
   cards; content sits ~550px wide in a ~1180px canvas.

## Current structure (for reference)

`renderProject()` emits, in order: `renderHero` → `renderVelocity` →
`renderFeatures` → `renderActiveWork` → `renderWorthReconciling`, all inside
`.project-page.single-col` as a vertical stack of `.card`s.

## Design

### Container — full-width hero strip + asymmetric 2-column

```
┌───────────────────────────────────────────────┐
│  HERO STRIP  (full width)                       │
├────────────────────────────┬───────────────────┤
│  MAIN (~1.5fr)             │  RAIL (~1fr)      │
│   Velocity                 │   Worth reconciling│
│   Active work (git graph)  │   Features         │
└────────────────────────────┴───────────────────┘
```

- New `renderProject` order: hero strip → `.pp-layout` grid wrapping a
  `.pp-main` column (velocity, active-work) and a `.pp-rail` column
  (worth-reconciling **first** — health before spend — then features).
- Grid: `grid-template-columns: 1.5fr 1fr; gap: var(--space-l);
  align-items: start`. Reuse the Overview mobile pattern: at `≤900px` the two
  columns become `display: contents` so all cards flatten into one flow.
- **Mobile stack order** (via `order`): hero → worth-reconciling → velocity →
  features → active-work last (most width-hostile, so it sinks).
- Width-hungry blocks (velocity, git graph) get the wide main column; the two
  vertical lists (worth-reconciling, features) get the rail, so their heights
  roughly balance and kill the dead space.

### Hero strip

Keep breadcrumb (`.label`, Spectral) + `.hero` title. Replace the stacked
metadata lines with a horizontal `.pp-statstrip` of cells separated by
hairline rules:

| Cell | Value | Treatment |
|---|---|---|
| Total · 30d | `$992` | serif, size ~22px |
| vs prior 30d | `▼54% · −$1,174` | **elevated** — serif ~22px, `--color-warm-deep` when down / `--color-accent` when up; the `−$1,174` a smaller sans muted suffix |
| Sessions | `10` | serif ~22px |
| Features | `24` | serif ~22px |
| Most active | `Budgets web menubar · $262` | sans ~15px, name links to feature |

- The delta cell is the promotion: it carries size + semantic color, no longer
  a tiny gray afterthought. Preserve existing edge cases: `(new project)` when
  `priorUsd === 0 && totalUsd > 0`; keep the up/down arrow + sign logic from
  `renderDeltaLine`.
- Empty state: when `features.length === 0`, omit the Most-active cell.

### Velocity (minor)

- Trim the empty left third: the chart should begin at the first day with
  spend rather than padding the full window with blank leading days. (Left
  faint baseline is acceptable; the goal is no large dead gap after the first
  axis label.)
- Add 2–3 faint y-gridline labels (e.g. peak, ⅔, ⅓) so bars other than the
  peak have a readable scale. Peak bar keeps its emphasis (warm inset ring).
- Keep the stat line and This week / Last week / Peak day rows unchanged.

Implementation note: this touches `renderVelocityChart` (the SVG/bars
generator) for the left-trim + gridlines; leave `renderVelocity`'s surrounding
markup otherwise intact.

### Features — magnitude bars + folded tail (primary win)

Per row, replace the sparkline with a horizontal **share bar**:

```
1  Budgets web menubar         ████████████████████  $262 · 26%
   2 sess · Aug 2
…
10 Worktree drift fix…         █                     $23 · 2%
   ──────────────────────────────────────────────────────────
   + N more under $10 · $M total                             ›
```

- **Bar width = share of the leader** (`f.totalUsd / features[0].totalUsd`),
  min ~1.5% so a nonzero row is always visible. This maximizes visual
  contrast. The numeric **label keeps the true share-of-total %** already
  computed as `Math.round(f.totalUsd / totalUsd * 100)` — bar basis and label
  basis differ intentionally (leader for shape, total for honesty).
- Bar color: the feature shade already used for the sparkline
  (`shadeForFeature(color, f.featureKey)`), on a `--color-fill-track` trough.
- Drop the per-row sparkline entirely.
- Keep rank, name (existing 40-char truncation + `title` tooltip), and the
  `N sess · last <date>` meta.
- **Fold the tail.** Show rows above a threshold; collapse the rest behind a
  single toggle row. Threshold: features with `totalUsd >= $10` stay expanded;
  everything below folds. (If that leaves fewer than ~5 visible, fall back to
  top-8 expanded so the block never collapses to almost nothing.) The toggle
  label states the count and summed dollars of the hidden tail: `+ N more
  under $10 · $M total`; clicking reveals them (same row markup) and flips the
  label to `Collapse long tail`. Progressive enhancement: with JS off, render
  the tail visible (no worse than today).

### Active work — de-wall, keep the real graph

- **Keep** the existing JS-rendered branch-divergence graph
  (`#branch-graph` + `#branch-graph-data`); it is the page's most distinctive
  element. Only fix its container so labels stop truncating and it survives
  mobile: wrap it in an `overflow-x: auto` scroller (same pattern as the uPlot
  charts) and give it room in the wide main column. (If the branch labels
  themselves are clipped by the graph JS, widen the label allotment there; do
  not replace the graph with the mockup's schematic rail — that was a mockup
  shortcut only.)
- Replace `renderBranchSummary`'s slash-joined runs with **aligned lists**.
  Keep all three buckets — **Open / Merged / Stale** (the mockup showed only
  Open/Stale; Merged must stay). Each bucket becomes a titled list with a
  count chip; each row is `branch-name … $amount` with the `$` right-aligned
  (`justify-content: space-between`, `tabular-nums`) so amounts scan
  vertically. `$0` branches render the amount in muted. Buckets with zero
  items stay omitted (current behavior).
- On desktop, lay the non-empty buckets as columns (`Open | Merged | Stale`);
  on mobile they stack.
- Keep the **Recent commits** inline list as-is.
- Keep the `$<totalBranchUsd>` amount tag in the card header.

### Worth reconciling — unchanged behavior, rail placement

Move to the top of the rail; no behavior change. Preserve **both**
unattributed states: the `✓ $0 · all sessions attributed` empty state and the
populated state (grey sparkline + `Run tokentrail infer-mainline →` CTA button
with its `data-project-cta` status wiring). Keep anomaly rows and their
session/label cause links.

## Non-goals

- No changes to `data/project.ts` view-model, queries, attribution, or routes.
- No new dependencies.
- Not touching the menubar app or Overview page.
- Sparkline module stays (still used by worth-reconciling); only the
  per-feature-row sparkline call is removed.

## Testing

- Existing `tests/project-render.test.ts` assertions updated for new markup
  (statstrip cells, share-bar rows, folded-tail toggle, aligned branch lists).
- New assertions: delta cell carries `down`/`up` class; tail toggle names the
  hidden count + summed dollars; Merged bucket still renders when present;
  unattributed CTA still emitted in the populated state.
- Both themes verified via headless screenshots (light + dark) at desktop and
  mobile widths before release.

## Rollout

Single dashboard-only release (no menubar bundle rebuild). Re-capture the
`feature-detail` marketing screenshots afterward since this is that page.
