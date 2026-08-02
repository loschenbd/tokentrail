# Mobile dashboard redesign

**Date:** 2026-08-01
**Status:** Approved design — ready for implementation plan

## Problem

The Tokentrail web dashboard (the Homebrew daemon on `127.0.0.1:4920`) is
accessed on a phone over Tailscale, but it was built desktop-first. At 390px
the current responsive handling is two thin media queries (`@700px` wraps the
header, `@900px` collapses the layout to one column). The result:

1. **Header/nav eats ~320px** before any data appears — logo + tagline, then a
   stacked `Source` dropdown, then a stacked `Window` dropdown, then the theme
   button, then the nav tabs, all piled vertically. No mobile nav pattern.
2. **Overview trend chart is crippled.** `.trend-layout` is a flex row with the
   legend pinned at `flex: 0 0 200px`, so on a 390px screen the chart is
   starved to ~170px — unreadable.
3. **Worth a look is unusable.** `.anomaly-full` is a rigid
   `grid-template-columns: 100px 110px 1fr 2fr auto`. The two fixed columns eat
   210px, leaving ~30–50px each for the branch link and reason columns, which
   wrap **one letter per line**. This is the worst offender.
4. **Controls are scattered** — `Source` / `Window` render as stacked
   label-over-dropdown blocks consuming vertical space.

Today already reads well at phone width (burn-by-hour bars, burn paths, session
list all stack cleanly) — it is the model the other views should meet.

## Goals

- A genuine mobile-first experience for the web dashboard viewed on a phone.
- An installable, standalone PWA (add-to-home-screen).
- Desktop rendering unchanged except the nav tab order (Today leftmost); all
  mobile layout rules live behind `@media (max-width:700px)`.
- Reuse the existing Midori design system — no new colors, fonts, or deps. The
  calm/precise/lightly-fantasy voice is untouched.
- No data-layer changes.

## Non-goals

- Native app changes (the SwiftUI menu-bar app is out of scope).
- Redesigning views that already work at phone width beyond the shared shell.
- Offline caching of live financial data (the service worker never serves stale
  HTML/API responses — see §6).

## Design

### 1. Navigation — bottom tab bar

The desktop top tabs (`.nav-tabs` in `shell.ts`) stay on desktop but are
**hidden below 700px**. In their place a **fixed bottom tab bar** renders the
same four links as icon + label.

**Tab order — Today leftmost.** The shared nav order becomes
**Today · Overview · Worth · Settings** (Today moves to first position). This
applies to both the desktop top tabs and the mobile bottom bar, from one nav
source, so the two never diverge. The brand-mark still links to `/` (Overview),
which remains the home/root — leftmost tab (Today) and home (Overview) are
deliberately distinct.

- Fixed to viewport bottom, full width, thumb-reachable.
- Honors the iPhone home-indicator via `padding-bottom: env(safe-area-inset-bottom)`.
- Active tab reuses the existing `activeTab` flag from `ShellOptions`.
- One nav source of truth in `shell.ts`, styled two ways (desktop top / mobile
  bottom). Each item has a small inline SVG icon + text label.
- `<main>` gets bottom padding (bar height + safe-area) so the last card is
  never covered.

### 2. Top bar — slim & sticky

Below 700px the header collapses to **one sticky row**:

- Left: brand-mark + "Tokentrail".
- Right: `Window` select + theme toggle, compact.
- Hidden on mobile: the "· the trail so far" tagline and the top `.nav-tabs`
  (now in the bottom bar).
- The `Source` picker (Overview-only, rendered only when `scopes.length > 1`)
  drops **just below the bar as a single full-width control** when present.
- Sticky (`position: sticky; top: 0`) with `env(safe-area-inset-top)` so it
  clears the notch, and a background matching the card surface so content
  scrolls under it cleanly.
- Net: content starts ~64px down instead of ~320px.

### 3. Overview trend chart — legend below

Under 700px, `.trend-layout` switches to `flex-direction: column`:

- Chart goes **full-width** with a **taller fixed height (~220px)** so it is
  actually readable.
- The legend moves **below** the chart as a wrapped two-column list
  (name + amount), not a starved 200px sidebar.
- The existing "Other ▸" expand/collapse behavior (`.trend-legend.other-expanded`)
  is preserved.

### 4. Worth a look — rows become cards

Under 700px, `.anomaly-full` abandons the fixed grid; each `.anomaly-row`
becomes a **stacked card**:

- Top meta line: date + kind (`.anomaly-kind`, mono/muted).
- Branch/feature link (`.anomaly-target`) as a full-width tappable title.
- Reason (`.anomaly-reason`) on its own line, left-aligned on mobile
  (overriding the desktop `text-align: right`).
- `dismiss` / `restore` action as a right-aligned text button.
- Dismissed state (opacity + line-through) preserved.
- The `Show dismissed` toggle sits above the list.

No markup change required — this is a media-query override of the existing
spans. (If a cleaner DOM is warranted during implementation it stays within
`renderRow`, but the grid-to-card flip alone fixes the break.)

### 5. Home stays Overview

`/` remains the Overview (home). **No redirect** — the previous
Today-on-mobile redirect is dropped. Today is instead surfaced as the
**leftmost tab** in the nav (see §1), one tap away and visually primary,
without hijacking the root URL. Simpler, no `sessionStorage` guard, no
bookmark/back-button edge cases.

### 6. Full PWA (installable, standalone)

Make the dashboard an installable, standalone-capable PWA — "Add to Home
Screen" on iOS/Android launches it chromeless like a native app.

**Web app manifest** — served at `/manifest.webmanifest` (new Fastify route,
`Content-Type: application/manifest+json`), linked via `<link rel="manifest">`:

```json
{
  "name": "Tokentrail",
  "short_name": "Tokentrail",
  "description": "The trail-map and ledger for AI spend.",
  "start_url": "/",
  "scope": "/",
  "display": "standalone",
  "orientation": "portrait",
  "background_color": "<Midori paper bg>",
  "theme_color": "<Midori card bg>",
  "icons": [
    { "src": "/static/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/static/icon-512.png", "sizes": "512x512", "type": "image/png" },
    { "src": "/static/icon-512-maskable.png", "sizes": "512x512",
      "type": "image/png", "purpose": "maskable" }
  ]
}
```

**Icons** — generated from the canonical 1024×1024 `logo.png`:
`icon-192.png`, `icon-512.png` (standard), and `icon-512-maskable.png` (with
~15% safe-zone padding so Android's mask doesn't clip the mark). Written to
`src/dashboard/static/` and added to the static-serving allowlist. Generated via
`sips` (standard sizes) and a padded composite for the maskable variant.

**Service worker** — served at **`/sw.js`** (root scope; new Fastify route,
`Content-Type: text/javascript`), registered from an inline script guarded by
`'serviceWorker' in navigator`:

- **App-shell precache, cache-first** for versioned static assets only — CSS,
  JS (uPlot + dashboard.js), fonts, logo, icons. Cache name carries the app
  version so a release busts it.
- **Network-only pass-through** for HTML pages (`/`, `/today`, …) and every
  `/api/*` route — live spend data is **never** served stale. This is the
  deliberate boundary: installability + fast static loads, without ever showing
  outdated financial figures.
- No offline fallback page for MVP (the daemon is local/Tailscale; offline has
  little value). The SW exists to satisfy installability and speed static
  delivery, not offline browsing.

**iOS/meta** (also covers browsers that ignore the manifest):

- `theme-color` meta (light + dark variants) matched to the card background.
- `apple-mobile-web-app-capable` = yes / `apple-mobile-web-app-status-bar-style`.
- `apple-mobile-web-app-title` = "Tokentrail".
- Existing `logo.png` stays as `apple-touch-icon`.
- Safe-area insets top (sticky header) and bottom (tab bar).

## Technical shape

- **`src/dashboard/render/shell.ts`**: reorder shared nav (Today leftmost);
  hide-on-mobile top tabs; add bottom-nav markup (shared link set with icons);
  restructure the top bar for the slim sticky layout; add PWA/manifest/meta tags
  and the service-worker registration script.
- **`src/dashboard/static/dashboard.css`**: one consolidated
  `@media (max-width: 700px)` block covering the bottom nav, slim sticky top
  bar, `.trend-layout` stack, `.anomaly-full` card flip, and safe-area padding.
  Plus the always-present bottom-nav element hidden by default on desktop.
- **`src/dashboard/server.ts`**: two new routes — `/manifest.webmanifest` and
  `/sw.js` — plus the three new icon files added to the static allowlist.
- **New static files**: `manifest.webmanifest` content (inline or file),
  `sw.js`, `icon-192.png`, `icon-512.png`, `icon-512-maskable.png`.
- **No changes** to `src/dashboard/data/*`, no new dependencies. The `build`
  script already `cp -R`s `static/` so new assets ship automatically.
- **Desktop rendering** is unchanged except the nav tab order (Today now
  leftmost) and the added `<head>` meta/manifest link; the bottom-nav element is
  `display:none` on desktop and all other mobile rules live behind the media
  query.

## Verification

Per the project constitution's manual-verification rule: after implementation,
view the live daemon dashboard at `127.0.0.1:4920` at 390px width across all
four views (Overview, Today, Worth a look, Settings) plus a feature drill-down,
in both light and dark themes, and confirm:

- Content starts near the top (no ~320px chrome).
- Bottom tab bar is fixed, thumb-reachable, clears the home indicator, and
  highlights the active tab.
- Trend chart is full-width and legible; legend reads below it.
- Worth a look renders as clean stacked cards — no letter-per-line wrapping.
- Nav shows Today leftmost; brand-mark still lands on Overview (`/`).
- `/manifest.webmanifest` and `/sw.js` return 200 with correct content-types;
  the service worker registers (DevTools → Application → Service Workers) and
  precaches static assets; HTML/`/api` responses are **not** cached.
- "Add to Home Screen" installs a standalone icon (correct maskable icon, no
  browser chrome on launch, portrait).
- Desktop (>900px) is visually identical to before apart from Today being the
  leftmost tab.
