# Trail map — marketing site & in-app onboarding

## Purpose

Ship an animated parchment "trail map" hero in two places:

1. A new static **marketing site** at `marketing/index.html` (single file,
   no framework), served independently (Vercel / Netlify / GH Pages).
2. **In-app onboarding** inside the Tokentrail dashboard:
   - Replaces the existing empty state on `/` (`renderEmptyState()` in
     `src/dashboard/render/overview.ts`) when there's no ingested data.
   - Reachable at a dedicated `/welcome` route at any time (tour mode).

The trail map is the parchment ASCII illustration the user supplied: a
78×22 ASCII map with a project trail, branches, merged-PR ✕ markers,
token "coins", anomalies, and a final trophy. Data is illustrative
(hard-coded), not derived from the user's real DB rows.

## Non-goals

- No build step for the marketing site. Plain HTML/CSS/JS.
- No real-data-driven trail map. The trail data is fixed.
- No new top-nav tab for `/welcome` (it's a tour, not a primary view).
- No new color-token consolidation. The trail map's CSS variables stay
  inline in its own CSS file; matching the dashboard's `tokens.ts`
  palette by hand is acceptable for this work.
- No first-run redirect from `/` → `/welcome`. The empty state on `/`
  already covers the no-data case; `/welcome` is an always-available
  tour, not a guarded onboarding flow.

## Architecture

### Files to create

```
marketing/
  index.html                          # standalone — user-supplied HTML with asset paths fixed and `.label`/`.stat` renamed (see Risks)
  static/
    logo.png                          # copy of docs/logo.png
    favicon.svg                       # copy of src/dashboard/static/favicon.svg
  README.md                           # one-paragraph deploy instructions

src/dashboard/render/
  trail-map.ts                        # renderTrailMap({ mode }) → HTML body

src/dashboard/static/
  trail-map.css                       # parchment-frame + ASCII color classes
  trail-map.js                        # the animation script, lifted verbatim
```

### Files to modify

```
src/dashboard/server.ts               # + GET /welcome; + static whitelist entries
src/dashboard/render/overview.ts      # renderEmptyState() → renderTrailMap({ mode: 'onboarding' })
src/dashboard/render/shell.ts         # no change required; activeTab stays as-is
```

### Shared visual, two contexts

`renderTrailMap({ mode })` returns the parchment frame + ASCII map +
legend + stats + CTAs as a single HTML string. The body markup is
identical for both modes; only the CTA row differs:

| mode         | Primary CTA                          | Secondary CTA                |
| ------------ | ------------------------------------ | ---------------------------- |
| `onboarding` | "Run a session →" (shows command)    | "Read the scrolls" (README)  |
| `welcome`    | "Open the dashboard →" (→ `/`)       | "Read the scrolls" (README)  |

The marketing site's CTAs ("Begin the trail →" to repo, "Read the
scrolls" to README) stay as-shipped in the source HTML — those CTAs
aren't shared with the dashboard partial.

### Static-asset wiring

`src/dashboard/server.ts`'s `STATIC_ALLOW` set adds:

```
'trail-map.css'
'trail-map.js'
```

The partial references them via `<link rel="stylesheet"
href="/static/trail-map.css">` and `<script src="/static/trail-map.js"
defer></script>`.

### Marketing-site asset paths

The user-supplied HTML keeps everything inline. To preserve that, the
marketing version keeps `<style>` and `<script>` blocks inline (no
external file dependencies). Only the favicon + logo references switch
to relative paths under `marketing/static/`.

This means the trail map's CSS and JS exist in TWO places:
- Inline in `marketing/index.html`
- Externalized in `src/dashboard/static/trail-map.{css,js}`

Sync cost: the trail data + animation are locked. Future edits touch
both files. Documented in `marketing/README.md`.

## Data shape

`renderTrailMap` signature:

```ts
export type TrailMapMode = 'onboarding' | 'welcome';

export function renderTrailMap(opts: { mode: TrailMapMode }): string;
```

The function returns a string ready to inject into `renderShell(...,
body)`. It does NOT include `<html>`/`<head>` — the shell wraps it.

## Routes

### `GET /welcome`

```ts
app.get('/welcome', async (_req, reply) => {
  reply.type('text/html; charset=utf-8');
  return renderShell(
    { title: 'Welcome · Tokentrail', days: opts.defaultDays, showBack: true },
    renderTrailMap({ mode: 'welcome' })
  );
});
```

No `activeTab` is set; the shell's nav tabs remain reachable but none is
highlighted.

### `/` empty state

`overview.ts`'s `renderEmptyState()` currently returns a `<div
class="card empty-state">...</div>` block. It's replaced with
`renderTrailMap({ mode: 'onboarding' })`. The decision of when to show
the empty state (`isEmpty(vm)`) is unchanged.

The empty-state's prior helpful text (path to `claudeProjectsDir()`,
`CLAUDE_CONFIG_DIR` instructions, install-Claude-Code link) is preserved
underneath the trail map as a small "trouble seeing your trail?" toggle
block. Keeping it matters: troubleshooting copy is the difference
between a frustrated user closing the tab and one who finds the env
var. Implementation: a `<details>` element so it's collapsed by
default.

## CTA implementation details

### `onboarding` mode primary CTA

The text "Run a session →" is a normal button-styled link with
`href="#"` and a `data-copy="npm run tokentrail -- run-all"`
attribute. A small inline script (added to `trail-map.js`) copies the
command to the clipboard on click and briefly flashes
"Copied!" to confirm. If the script can't run (e.g., no clipboard
API), the click is a no-op and the visible command text remains
readable.

(The marketing site's primary CTA is just an `<a href="...">`. No
script needed there.)

### `welcome` mode primary CTA

Plain `<a href="/">`. No script.

## Animation cost / runtime behavior

`trail-map.js` runs a `setInterval` that ticks the stats grid every
700ms and a `setTimeout` chain that runs the trail reveal+flash+reset
cycle. Both are cheap (DOM string swaps on a small grid).

A `prefers-reduced-motion: reduce` check is honored: when set, the
fully-revealed trail renders once and the loops don't start. This
behavior is in the user-supplied HTML; preserved verbatim.

## Testing

- Manual: `npm run tokentrail -- dashboard`, visit `/welcome` — verify
  it renders the trail map and CTAs route to `/`.
- Manual: visit `/` on a fresh DB (or temporarily tweak `isEmpty` to
  force the empty state) — verify the trail map renders inline.
- Manual: `open marketing/index.html` in a browser — verify the file
  renders standalone, assets resolve, animation runs.
- Type: `npx tsc --noEmit` clean.
- No unit tests; existing dashboard render functions have none.

## Risks

- **Duplication drift.** Two copies of the trail data + animation
  (marketing inline vs dashboard static). Mitigated by docs in
  `marketing/README.md` and by the fact that the visual is locked.
  Worst case: marketing and onboarding visually diverge until someone
  notices. Acceptable.
- **CSS class collisions.** The trail-map CSS introduces classes like
  `.parchment`, `.btn`, `.btn-primary`, `.legend`, `.stats`, `.rule`,
  `.label` (already used by the dashboard!). Two of these — `.label`
  and `.stat` — collide with the dashboard's existing styles in
  `dashboard.css`. Resolution: rename the trail-map's colliding
  classes (`.label` → `.tm-label`, `.stat` → `.tm-stat`, etc.) before
  shipping, and scope the parchment styles under a `.trail-map`
  wrapper so nothing leaks. The marketing inline version gets the
  same renamed classes for parity.
- **Static-allow list regression.** Forgetting to add `trail-map.css`
  / `trail-map.js` to `STATIC_ALLOW` would 404 silently. Caught by
  manual test.

## Open question (resolved during brainstorm)

- Empty state: user confirmed BOTH — replace the empty state AND add
  a dedicated `/welcome` route.

## Out of scope (future work)

- Wiring a "first time here? →" link into the dashboard header so
  established users can revisit `/welcome` without typing the URL.
- Consolidating the marketing inline CSS/JS with the dashboard's
  external versions via a build step.
- Driving the trail map from real session/commit data.
