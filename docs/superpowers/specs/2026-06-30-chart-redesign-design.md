# Dashboard trend chart redesign — feature-decomposed stacked area

**Date:** 2026-06-30
**Status:** Design / pre-implementation
**Owner:** Ben

## Problem

The dashboard's headline trend chart is a single line of daily total cost over
the last 30 days. It answers "how much have I spent" and "is spend trending
up", but it does NOT answer the question the user actually has when they open
Tokentrail:

> Which features are driving my cost, and when did each one spike?

The data to answer that lives in `feature_rollups`, keyed by
`(date, feature_key)`. The chart just doesn't expose it. Users have to
correlate a spike on the line chart with the "Top burn paths" sidebar,
mentally, on every visit.

## Goal

Redesign the trend chart so a glance answers "which features cost the most
this month, and when did each spike?" — without losing the daily-total
reading the existing chart provides.

## Non-goals

- Replacing the "Top burn paths" sidebar (still useful as a sortable list).
- Adding per-repo filtering inside the chart (existing repo filter still
  applies upstream).
- Adding a date-range picker (still 30 days like today).
- Animations, transitions, or "what changed since yesterday" callouts.
- A user-controllable toggle to switch back to the single-line chart.

## Design

### 1. Visual structure

A stacked area chart replacing the current single-line trend.

- X-axis: last 30 days (unchanged from today).
- Y-axis: daily cost in USD, built from stacked feature bands.
- The silhouette of the top edge equals the existing daily total — the old
  reading is preserved, just decomposed.

**Bands shown:**

1. **Top 6 features by total cost over the visible window** — each gets its
   own colored band.
2. **"Other"** — single neutral-gray band containing all features ranked
   7th and below (excluding `uncategorized-mainline`).
3. **`uncategorized-mainline`** — its own band, rendered with a diagonal-
   stripe pattern over a darker gray. Visually distinct so it reads as
   "unclassified spend, not a real feature".

**Stack order, bottom → top:**

1. Largest real feature (anchors the baseline — most readable trend).
2. → 6th-largest real feature.
3. "Other".
4. `uncategorized-mainline`.

Largest-at-bottom is conventional: the dominant band gets a stable baseline,
smaller bands stack above where their relative size is still legible against
the curve. Inverting would put the biggest band against a wavy baseline and
make it harder to read.

### 2. Color palette

**Stable color per feature, not ranked color.** A feature's color is derived
deterministically from its `feature_key` (hash → palette index). This means
`menubar` is always the same color across every page and every visit; when
rankings reshuffle inside the chart, a band keeps its hue as it slides up or
down the stack, so the eye can track it.

The same `feature_key → color` mapping is reused by:

- The chart (this redesign).
- The legend (Section 3).
- The existing "Top burn paths" sidebar.
- The `/feature/<key>` detail page.

**Palette:** an 8-color qualitative palette tuned for stacked areas
(Okabe-Ito family — high distinguishability for normal vision and the most
common color-blindness types):

```
['#0072B2', '#E69F00', '#009E73', '#CC79A7',
 '#56B4E9', '#D55E00', '#F0E442', '#000000']
```

**Reserved slots:**

- `__other__` → `#9CA3AF` (neutral gray).
- `uncategorized-mainline` → diagonal stripes over `#6B7280` (darker gray,
  same family as Other so the eye groups them as "non-feature buckets").

Collisions across visits are possible — only 6 real features fit in the
palette before the hash wraps. Acceptable trade-off: the chart only shows 6
real features at a time, and the same 6 features always produce the same 6
colors in the same chart.

### 3. Legend & labels

**Placement:** vertical, right of the chart. Preserves chart width and puts
the legend where the eye lands after scanning the top edge of the stack.

**Order — top to bottom, matching the stack from top:**

```
■ uncategorized-mainline   $12.40
▨ Other                    $8.91
■ menubar                  $34.20    (real features sorted by total $ desc)
■ infer-mainline           $28.55
■ ingest                   $19.12
■ dashboard                $11.03
■ rollup                   $7.44
■ enrich                   $4.18
```

- Each row: color swatch + feature name + total $ over the visible window.
- "Other" and `uncategorized-mainline` pinned to the top of the legend,
  visually grouped by the gray family.
- Real features sorted by window-total cost descending.
- Hover a legend row → highlights the matching band (same as hovering the
  band itself).
- Click a legend row (real feature only) → navigates to `/feature/<key>`.
- "Other" and `uncategorized-mainline` rows are not clickable.

**No inline band labels** inside the chart. Adding labels to thin bands
creates collisions. The legend + hover-highlight does the work.

### 4. Tooltip & hover

**Hover anywhere over the chart:** vertical guide line drops on the nearest
day; tooltip anchors to the cursor.

```
Tue, Jun 23
─────────────────────
Total              $4.82
─────────────────────
■ menubar          $2.10  (44%)
■ infer-mainline   $1.21  (25%)
■ ingest           $0.62  (13%)
▨ uncategorized    $0.49  (10%)
■ rollup           $0.21  (4%)
■ Other            $0.19  (4%)
─────────────────────
3 commits · 1 PR
```

- Total at top — preserves the at-a-glance daily reading.
- Per-feature breakdown sorted by $ desc **for THAT day** (not window-total
  order) — on a day where `dashboard` spiked, it floats to the top.
- Only features with non-zero spend that day are listed.
- `uncategorized-mainline` keeps the stripe glyph (▨) for consistency.
- Commits / PRs from the existing `dailySeries` data — same as today's
  tooltip.

**Hover a specific band** (not just anywhere over the chart): that band
stays at full opacity, all other bands fade to ~25% opacity. The
highlighted band's silhouette becomes scannable across all 30 days,
answering "when did THIS feature spike?". Same effect on legend-row hover.

**Mouse-leave:** opacity restored, tooltip dismissed.

**Click a band:** navigates to `/feature/<key>` (same destination as legend-
row click). Not applicable to Other or `uncategorized-mainline`.

### 5. Data & implementation

**Query** — one round-trip, no joins. Same `feature_rollups` table the
existing chart already uses:

```sql
SELECT date, feature_key, feature_name, SUM(total_cost_usd) AS usd
FROM feature_rollups
WHERE date >= date('now', '-30 day', 'localtime')
GROUP BY date, feature_key, feature_name
ORDER BY date ASC;
```

**Shape transform** (in `src/dashboard/data/overview.ts`):

1. Compute window-totals per `feature_key`; sort descending.
2. Top 6 real features → kept as own bands.
3. Everything below rank 6 (excluding `uncategorized-mainline`) → folded
   into `__other__`.
4. `uncategorized-mainline` → kept as its own band regardless of rank.
5. Pivot to per-day rows:
   `{ date, bands: { menubar: 2.10, ingest: 0.62, __other__: 0.19,
   'uncategorized-mainline': 0.49 } }`. Missing values default to 0.
6. Attach commits/PRs counts from `dailySeries` (already there).
7. Return payload:
   ```ts
   {
     days: Array<{
       date: string;
       total: number;
       bands: Record<string, number>;
       commits: number;
       prs: number;
     }>;
     features: Array<{
       key: string;           // feature_key, or '__other__', or 'uncategorized-mainline'
       name: string;          // display name
       color: string;         // hex, or '__striped__' sentinel for uncategorized
       totalUsd: number;
       clickable: boolean;    // false for Other and uncategorized-mainline
       stackPosition: number; // 0 = bottom band
     }>;
   }
   ```
   `features` drives the legend, stack order, and per-band colors.

**Rendering.** Keep uPlot (already in the project). uPlot supports stacked
series natively via the `bands` config. Hatched fill for `uncategorized-
mainline` via a canvas pattern applied in that series' draw call.

**Color module** — new `src/dashboard/lib/feature-colors.ts`:

```ts
const PALETTE = [
  '#0072B2', '#E69F00', '#009E73', '#CC79A7',
  '#56B4E9', '#D55E00', '#F0E442', '#000000',
];
export const STRIPED_SENTINEL = '__striped__';
export const OTHER_COLOR = '#9CA3AF';
export const UNCATEGORIZED_BASE = '#6B7280';

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

export function colorFor(featureKey: string): string {
  if (featureKey === '__other__') return OTHER_COLOR;
  if (featureKey === 'uncategorized-mainline') return STRIPED_SENTINEL;
  return PALETTE[hash(featureKey) % PALETTE.length];
}
```

Reused by the chart, the legend, the "Top burn paths" sidebar, and the
`/feature/<key>` page.

**Files touched:**

- `src/dashboard/data/overview.ts` — extend payload (`features`,
  `days[].bands`). Existing single-series `dailySeries` is replaced by the
  new shape; downstream readers update accordingly.
- `src/dashboard/render/overview.ts` — replace single-series chart markup
  with stacked-area + right-side legend.
- `src/dashboard/static/dashboard.js` — new uPlot config for stacked area;
  hover-highlight wiring; tooltip; click-through.
- `src/dashboard/static/dashboard.css` — legend styles; striped fill
  pattern.
- `src/dashboard/lib/feature-colors.ts` — new module.
- Top burn paths sidebar and `/feature/<key>` page — updated to use
  `colorFor()` so their swatches match the chart.

**No schema changes. No migrations.**

### 6. Edge cases

| Case | Behavior |
|---|---|
| Zero-cost day | Row exists with all bands = 0. Chart shows a gap; tooltip shows "Total $0.00 — no activity". |
| Fewer than 6 features in window | Render however many exist. No empty bands. Legend collapses. |
| Only `uncategorized-mainline` has data | Single striped band. Empty-state copy "Run `infer-mainline` to classify these" appears under the chart. |
| Feature renamed (key changed) | Treated as two separate features. Bands don't merge retroactively — the rename IS a real attribution change. |
| >100 features in tail | All collapse into Other. No perf concern. |
| Sparse feature (1 day of spend in 30) | Gets a band; 29 days are zero-height (invisible). Hover-highlight surfaces the spike. |
| Timezone | Uses the same `date` column the existing chart uses (local TZ via `tz` setting). No new TZ logic. |

### 7. Testing

- **Unit:** `feature-colors.ts` — stable hash, palette wraparound, special-
  case sentinels (`__other__`, `uncategorized-mainline`).
- **Unit:** data transform in `overview.ts` — top-6 selection, Other
  folding, uncategorized preservation, zero-day handling, fewer-than-6
  case, missing-band fill.
- **Integration:** dashboard route returns expected shape with seeded
  fixtures (1 feature; 7 features; only-uncategorized; all-zero).
- **Manual:** Playwright spot-check — hover-highlight visible, tooltip
  contents match, click-through to feature page works, color stable across
  reloads.

## Open questions / risks

- **uPlot striped fill.** uPlot's series fill takes a CanvasPattern, but
  binding a pattern that adapts to dimming opacity (hover-highlight) needs
  verification. If the pattern can't be re-stroked with reduced alpha at
  hover time, fallback: solid `#6B7280` with a small "uncategorized" badge
  near the band — visually weaker but functionally fine.
- **Color collisions.** With 8 palette slots and 6 real features, the hash
  may pick the same color for two of them. The chart still renders
  correctly (stack order disambiguates), but the legend could show two near-
  identical swatches. If this becomes a real problem, switch to a greedy
  assignment: walk the palette in order, skipping colors already taken by
  higher-ranked features. Adds determinism inside a single chart but
  weakens cross-chart stability. Hold off unless observed.

## Out of scope (YAGNI)

- Toggle to switch back to old single-line view.
- Custom feature pinning / hiding from the legend.
- Date-range picker.
- Per-repo filter inside the chart.
- First-paint or refresh animations.
- Drag-to-zoom on X-axis.
