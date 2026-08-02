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
- Desktop rendering unchanged (all mobile rules behind `@media (max-width:700px)`).
- Reuse the existing Midori design system — no new colors, fonts, or deps. The
  calm/precise/lightly-fantasy voice is untouched.
- No data-layer changes.

## Non-goals

- Full installable PWA / web app manifest / standalone mode (deferred, YAGNI).
- Native app changes (the SwiftUI menu-bar app is out of scope).
- Redesigning views that already work at phone width beyond the shared shell.

## Design

### 1. Navigation — bottom tab bar

The desktop top tabs (`.nav-tabs` in `shell.ts`) stay on desktop but are
**hidden below 700px**. In their place a **fixed bottom tab bar** renders the
same four links (Overview · Today · Worth · Settings) as icon + label:

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

### 5. Home = Today on mobile

On `/` only, a tiny inline script in `shell.ts` (or served static) runs before
paint:

```js
try {
  if (window.matchMedia('(max-width: 700px)').matches &&
      !sessionStorage.getItem('tt-landed')) {
    sessionStorage.setItem('tt-landed', '1');
    location.replace('/today');
  }
} catch (e) {}
```

- Fires only on a **cold open** (first `/` hit of a session), guarded by a
  `sessionStorage` flag so tapping the Overview tab afterward does **not**
  bounce back to Today.
- `location.replace` (not `assign`) so Back doesn't loop.
- Desktop and deep links (`/today`, `/worth-a-look`, `/feature/...`) untouched.
- Only added on the Overview render path so it never runs elsewhere.

**Accepted tradeoff:** because the guard is per-session, closing and reopening
the tab cold-lands on Today again — which is the intended "Today is home"
behavior. A user who bookmarks `/` specifically wanting Overview on mobile will
be redirected on each fresh session; this is deemed acceptable and Overview is
one tab-tap away.

### 6. Lightweight PWA polish

- `theme-color` meta matched to the card background (light + dark variants).
- `apple-mobile-web-app-capable` / `apple-mobile-web-app-status-bar-style`.
- Safe-area insets top (sticky header) and bottom (tab bar).
- Existing `logo.png` already linked as `apple-touch-icon` — no change.
- No `manifest.json` / standalone mode (deferred).

## Technical shape

- **`src/dashboard/render/shell.ts`**: hide-on-mobile top tabs; add bottom-nav
  markup (shared link set with icons); restructure the top bar for the slim
  sticky layout; add PWA meta tags; add the Overview-only home-redirect script.
  (~30 lines.)
- **`src/dashboard/static/dashboard.css`**: one consolidated
  `@media (max-width: 700px)` block covering the bottom nav, slim sticky top
  bar, `.trend-layout` stack, `.anomaly-full` card flip, and safe-area padding.
  Plus the always-present bottom-nav element hidden by default on desktop.
- **No changes** to `src/dashboard/data/*`, no new dependencies, no build
  changes.
- **Desktop output is byte-for-byte unchanged** apart from the always-present
  (but `display:none` on desktop) bottom-nav element and the added `<head>`
  meta — all visual mobile rules live behind the media query.

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
- `/` cold-loads Today on mobile; tapping Overview stays on Overview.
- Desktop (>900px) is visually identical to before.
