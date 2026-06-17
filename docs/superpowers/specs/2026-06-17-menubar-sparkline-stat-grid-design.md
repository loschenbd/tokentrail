# Menubar redesign — sparkline + stat grid

**Date:** 2026-06-17
**Status:** Spec, awaiting plan
**Scope:** Replace the current SwiftBar dropdown layout with a denser, more
glanceable design inspired by CodexBar. Ship only the layout + data
changes; the dropdown stays a SwiftBar plugin script.

## Goal

Today's menubar dropdown surfaces a header amount + a flat list of
projects nested with features. It answers "how much today" and "which
project" but not "how does today compare to recent days," "where in the
month are we trending," or "what's hot right now."

CodexBar's dropdown crams quotas, costs, and a 30-day mini-chart into a
single glance. The vocabulary doesn't translate (Tokentrail tracks
spend, not quotas) but the *information density* does. This spec brings
two CodexBar patterns to Tokentrail:

1. **A sparkline** in the header — last 14 days of daily spend as block
   glyphs.
2. **A 4-cell stat grid** — Today / 7d / 30d / Worth-a-look counts.

The existing project + feature breakdown stays, below the new header.

## Non-goals

- Time-window tabs (Today / 7d / 30d) like CodexBar's tabbed nav.
  SwiftBar tabs require multi-state plugin trickery; skip for now.
- Color-coded warning bars for usage limits. Tokentrail tracks spend,
  not quotas. The closest equivalent is anomaly count, which gets a
  ⚠ glyph in the grid.
- The "Burn rate + story" treatment from idea B in brainstorming. That's
  a follow-up.
- Trail-elevation rendered inside the dropdown (idea C). Stretch goal.
- Multi-provider tabs (Cursor / Claude / Codex). Out of scope —
  Tokentrail is Claude Code only.
- Pause / snooze affordances. Out of scope.

## Data shape

`/api/today` currently returns:

```ts
{
  todayUsd: number;
  topProjects: Array<{ key, name, usd, href, features: [...] }>;
  anomalyCount: number;
  asOf: string;
}
```

Extend with a `menubar` field — additive, doesn't break the existing
SwiftBar plugin's read path:

```ts
{
  todayUsd: number;
  topProjects: [...],
  anomalyCount: number;
  asOf: string;
  menubar: {
    sparkline: number[];          // last 14 days of daily $ (oldest first,
                                  // including today, zero-filled)
    last7Usd: number;             // sum over last 7 calendar days (incl today)
    last30Usd: number;            // sum over last 30 calendar days (incl today)
    deltaVsYesterday: number;     // signed % vs yesterday's total
    yesterdayUsd: number;
  };
}
```

**Implementation:** the new fields all come from `feature_rollups`
filtered by date. One additional query per request (cheap, indexed).

The renamed `/api/today` response stays backward-compatible — old
clients that don't read `menubar.*` keep working.

## Dropdown layout

```
┌─────────────────────────────────────────────────────────────┐
│  $88.63 today          ▲ 2.4×    ▁▂▁▃▂▅▇▃▅▂▇▃▁▂            │ ← hero row
│  Updated 12s ago                                            │
├─────────────────────────────────────────────────────────────┤
│  Today        7d         30d        Worth-a-look            │ ← stat grid
│  $88.63       $456.20    $1,247.45  ⚠ 2 active              │
├─────────────────────────────────────────────────────────────┤
│  By project today                                           │
│  tokentrail                                          $66.48 │
│    ├ Trail map                                       $29.24 │
│    ├ Trail map onboarding                            $19.02 │
│    ├ tokentrail (master)                             $11.40 │
│    └ Fix: Lazy rollup F&F                             $4.94 │
│                                                             │
│  Projects (root)                                     $22.15 │
├─────────────────────────────────────────────────────────────┤
│  ⚠ Worth a look → 2 active                                  │
│  Open dashboard                                             │
│  Today  ·  Worth a look                                     │
│  Refresh                                                    │
└─────────────────────────────────────────────────────────────┘
```

### Hero row

- Left: `$88.63 today`. Monospace, size 13.
- Right: `▲ 2.4×` delta vs yesterday (▲ if positive, ▼ if negative,
  `—` if delta is zero or yesterday was zero). Size 11, muted.
- Far right: sparkline of 14 cells. Each cell is one of
  ` ▁▂▃▄▅▆▇█` mapped to 0..max(sparkline). Today is the rightmost
  cell. Size 11, monospace.
- Second line: `Updated <N> ago` where N is `(now − asOf)` formatted
  as `12s` / `3m` / `1h`. Size 11, muted.

### Stat grid

Four cells in a single SwiftBar row using `\t` separators and a
fixed-width column trick. Each cell is two lines:

- Line 1: small label (`Today`, `7d`, `30d`, `Worth-a-look`), muted.
- Line 2: big value (monospace, bold for the first three; ⚠ glyph + N
  for the fourth when N > 0, otherwise "—" muted).

If SwiftBar's column alignment proves janky, fall back to a single
row of labeled stats: `Today $88.63 · 7d $456 · 30d $1,247 · ⚠ 2`.
This is a known SwiftBar limitation — see Risks.

### Project list

Unchanged from today. Same logic for single-feature suppression
(omit feature sub-row when project has exactly 1 feature).

### Footer actions

- `⚠ Worth a look → N active` — link to `/worth-a-look`. Only rendered
  when `anomalyCount > 0`. Uses muted color, no warning hue.
- `Open dashboard` — link to `/`.
- `Today  ·  Worth a look` — single-row deep-links separated by `·`.
- `Refresh` — SwiftBar's built-in refresh.

## Sparkline rendering

The block glyphs:

```js
const BLOCKS = [' ', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
function spark(values) {
  const max = Math.max(...values, 1);
  return values.map((v) => BLOCKS[Math.min(8, Math.round((v / max) * 8))]).join('');
}
```

A 14-day sparkline gives ~5 characters of context per work-week. Days
with zero spend render as a single space (the empty glyph). Today is
always the rightmost cell.

If the user wants a different window (7 / 30 / 90), expose it as
`?spark=N` on `/api/today`. Skip for v1.

## Why 14 days, not 7 or 30

- 7 is too short to show a trend ("am I trending up?")
- 30 compresses each cell to <1 char of meaning at SwiftBar's font size
- 14 fits in ~14 character columns and shows ~2 work-weeks of context.
  Matches what the eye can scan in the dropdown's width without
  competing with the dollar amount

## Color

SwiftBar's `color=` palette pulls from the menubar's contrast. Keep
the existing palette:

- `#8b6f47` for accents (anomaly glyph)
- `#6b563d` for muted labels
- Default text color (system) for primary values

No new colors. Anomaly glyph is a single warning emoji, not a colored
pill, to avoid OS dark/light-mode mismatch.

## Backward compatibility

- `/api/today` response is additive: `menubar.*` is a new optional
  field. Old clients ignore it.
- The plugin's `renderError()` fallback path is unchanged.
- The plugin still hits the same endpoint on the same port, same
  2s timeout. (Lazy rollup is fire-and-forget per PR #14, so the
  response is always fast.)

## Testing

### Automated

- `tests/api-today.test.ts` — add cases that exercise the new
  `menubar.sparkline`, `menubar.last7Usd`, `menubar.last30Usd`,
  `menubar.deltaVsYesterday`, `menubar.yesterdayUsd` fields.
- No new tests for the SwiftBar plugin itself — it's a bash + inline
  Node script, and the existing convention is no plugin tests.

### Manual

1. Reload the SwiftBar plugin: `swiftbar://refresh?name=tokentrail.1m`
2. Click the menubar icon — hero row shows `$X today`, delta arrow,
   sparkline of 14 cells, "Updated Ns ago".
3. The stat grid renders four cells with the right values.
4. The project list renders unchanged.
5. ⚠ Worth a look row appears only when there are active anomalies.
6. Click each action — it opens the right URL in the user's browser.

### Edge cases

| Case                            | Expected                                                     |
|---------------------------------|--------------------------------------------------------------|
| No data today (empty trail)     | Hero shows `$0.00 today  —  ` (empty sparkline = 14 spaces) |
| First day of use                | sparkline = 13 spaces + 1 cell                              |
| Yesterday $0, today > $0        | delta = `▲ ∞×` rendered as `▲ first day`                    |
| Yesterday > 0, today = $0       | `▼ −100%`                                                   |
| Sparkline max < 1¢              | All cells render as space (no warning)                      |
| 0 anomalies                     | Stat grid cell 4 = `—`, no footer warning row              |
| dashboard daemon down           | Plugin's existing error fallback (unchanged)                |

## Risks / open questions

- **SwiftBar column alignment is jank.** Bash plugins emit one line per
  menu row, separated by `\n`. Multi-column grid layouts within a
  single row don't render predictably. **Mitigation:** the stat grid
  starts as 4 separate menu rows stacked vertically — looks like a
  list, not a grid. The "grid" name is aspirational. If we need a
  true grid we can switch the plugin to emit `image=<base64-png>`
  rendered via `sips` or a tiny canvas script — but that's a follow-up.
- **Sparkline cell count.** 14 might be too wide for narrower
  menubars (laptop screen, lots of menubar apps competing). If it
  pushes the dropdown wider than expected, drop to 10 or 7.
- **Delta calculation when yesterday = $0.** Math gives `Infinity`.
  Render as `first day` muted instead of a number.
- **Multiplier vs percent for the delta.** CodexBar shows percentages.
  Tokentrail's voice ("2.4× yesterday") feels more on-brand than
  "+140%". Pick one; spec assumes multiplier with sign-arrow.
  Decision deferred to implementer if a few-line UX prototype reveals
  ambiguity.

## Open follow-ups (not in scope)

- "Hot trail right now" — most recently active feature with last
  session timestamp (idea B from brainstorming).
- ASCII trail-elevation in the dropdown (idea C).
- Option-modifier alternates for 7d / 30d quick-peek (idea D).
- Snooze / pause anomaly alerts.
- Multi-account or multi-provider support.
