# Tokentrail SwiftBar Plugin — Design

> Date: 2026-06-16
> Status: approved (pending user review of this written spec)
> Scope: one branch, ~150 LOC, no new runtime dependencies

## Goal

Put today's Tokentrail spend in the macOS menu bar at all times, with a tiny
dropdown that shows the day's top spend buckets and links into the dashboard.
Lowest-maintenance possible: no Swift app, no code-signing cert, no Sparkle.

## Why SwiftBar

SwiftBar (and its predecessor xbar) is a free open-source menu bar host that
runs user scripts and displays their stdout in the menu bar. Each "plugin" is
a single executable file whose filename encodes the refresh interval
(`*.5m.js` = every 5 minutes). The script prints a SwiftBar-formatted
text block; SwiftBar handles the macOS-native menu bar UI, dropdown
rendering, click handlers, and link opening.

This means we ship a ~60-line script as the entire "menu bar app". No
binary to build, sign, notarize, or distribute. The user installs SwiftBar
once via Homebrew and symlinks our plugin into its plugin directory.

## Architecture

```
┌──────────────────────────────────┐      ┌──────────────────────────────┐
│  SwiftBar (Homebrew Cask)        │      │  Existing Tokentrail stack    │
│  hosts our plugin script         │ ───▶ │  Fastify @ 127.0.0.1:4920    │
│  re-runs it every 5 min          │ HTTP │  + new GET /api/today         │
│  renders stdout in the menu bar  │      │  SQLite ledger                │
└──────────────────────────────────┘      └──────────────────────────────┘
        ▲                                                ▲
        │ user clicks open-dashboard link                │ schedule
        └───── opens 127.0.0.1:4920 in default browser   └─── (user runs `tokentrail dashboard`)
```

Three pieces, each independently testable.

## Piece 1 — `GET /api/today` JSON endpoint

**Files:** `src/dashboard/server.ts` (route), `src/dashboard/data/api.ts`
(thin shaper), `tests/api.test.ts` (test).

**Shape:**

```typescript
type TodayResponse = {
  todayUsd: number;
  topFeatures: Array<{
    key: string;
    name: string;
    usd: number;
    href: string;          // absolute URL into the dashboard
  }>;                      // length 3
  anomalyCount: number;    // count of OPEN (non-dismissed) anomalies
  asOf: string;            // ISO 8601 with local offset
};
```

**Implementation notes:**

- Reuses the existing `buildOverview(db, { days: 1 })` view-model — same
  data layer as the HTML page, just a different presenter.
- "Today" means local-time today, matching the rest of the dashboard
  (existing SQLite queries use `date(..., 'localtime')`).
- `topFeatures` is the existing `topFeatures` array, truncated to 3 and
  decorated with absolute `href` URLs. If today has fewer than 3 features,
  the array is shorter (no padding).
- `anomalyCount` reuses the existing anomalies query (open + non-dismissed).
- `asOf` lets the plugin show a "last updated" hint if we ever want it.
- No auth — 127.0.0.1 only, same posture as the rest of the dashboard.

**Test:** seed an in-memory DB with two rollups dated today and one anomaly,
call the handler, assert each field of the JSON response.

## Piece 2 — SwiftBar plugin script

**File:** `scripts/menubar/tokentrail.5m.js`

**Runtime:** Node 20+, no dependencies beyond Node's built-in `fetch` and
`JSON`. The script is executable (`chmod +x`) with a `#!/usr/bin/env node`
shebang so SwiftBar can run it directly.

**Filename convention:** `tokentrail.5m.js` tells SwiftBar to refresh
every 5 minutes. (Variants: `.1m.`, `.10m.`, `.1h.` — we pick 5 min as a
balance between freshness and battery / network noise.)

**Output format (SwiftBar text protocol):**

Happy path:

```
$2.40 | font=Menlo size=12
---
TODAY · 3 features · 1 anomaly | color=#6b563d size=11
---
Sidebar redesign  $1.10 | href=http://127.0.0.1:4920/feature/sidebar-redesign
Auth refactor     $0.80 | href=http://127.0.0.1:4920/feature/auth-refactor
PR review loop    $0.50 | href=http://127.0.0.1:4920/feature/pr-review-loop
---
Open dashboard | href=http://127.0.0.1:4920/
Refresh | refresh=true
```

Header line pluralizes correctly (`1 feature` vs `2 features`,
`0 anomalies` vs `1 anomaly`). If `topFeatures` is empty, the feature
rows are omitted and the header reads `TODAY · no activity yet`.

Error path (server down, network failure):

```
$— | color=#8b6f47
---
Tokentrail dashboard not running | color=#8b6f47
---
Start it with `tokentrail dashboard` | shell=open href=https://github.com/loschenbd/tokentrail#dashboard
Refresh | refresh=true
```

**Fetch behavior:**

- Hard timeout 2s (`AbortController`) — SwiftBar plugins should never block
  the menu bar.
- Catch network errors, 4xx, 5xx, JSON parse errors → all fall to the
  error-path output above.
- No retries; SwiftBar will re-invoke on its own schedule.

## Piece 3 — README install docs

New subsection under **Dashboard** in `README.md`:

````markdown
### Menu bar widget (SwiftBar)

Put today's spend in your macOS menu bar:

```bash
brew install --cask swiftbar
mkdir -p ~/Library/Application\ Support/SwiftBar
ln -s "$PWD/scripts/menubar/tokentrail.5m.js" \
  ~/Library/Application\ Support/SwiftBar/
```

Open SwiftBar from Spotlight; it picks up the plugin automatically. The
widget shows today's spend and refreshes every 5 minutes. Click it to see
the top 3 features and open the full dashboard.

Requires `tokentrail dashboard` to be running on port 4920. If it isn't,
the widget shows `$—`.
````

## Out of scope (for this branch)

- launchd plist for keeping `tokentrail dashboard` alive at login. Separable
  follow-up; the plugin works fine when the user runs `tokentrail dashboard`
  manually.
- macOS notifications when anomalies fire. Adds `UserNotifications`
  framework complexity; ship later if wanted.
- A preferences UI. SwiftBar has its own per-plugin config; if we need
  user-tunable settings later we can use the SwiftBar metadata header.
- A native Swift app. Documented as a future option in conversation but
  explicitly traded away for the SwiftBar approach.

## Tradeoffs accepted

- Users install SwiftBar themselves (one-time `brew install --cask`).
- Visual design is constrained to SwiftBar's text + sub-menu protocol; no
  custom popover layouts.
- The dashboard server must be running for the widget to have data. The
  error state handles this gracefully but is itself a usability cost.

## Risks

- **None significant.** This branch adds one route, one script, one docs
  block. Worst case: the plugin doesn't work and the user removes the
  symlink — nothing in the existing stack is touched.

## Success criteria

- After install, the menu bar shows `$X.XX` reflecting today's actual spend.
- Clicking the widget shows a dropdown with the top 3 features as deep
  links.
- Clicking a feature opens the right `/feature/<key>` page in the browser.
- Stopping the dashboard server makes the widget show `$—` and a
  "not running" hint instead of crashing.
- The new `/api/today` test passes alongside the existing 37 tests.
