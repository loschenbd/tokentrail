# Marketing site — mobile responsive design

**Date:** 2026-06-24
**Target file(s):** `marketing/index.html`, `marketing/static/screenshots/*`, `marketing/README.md`
**Live URL:** <https://tokentrail.benjaminloschen.com>

## Goal

Make the marketing landing page legible and on-brand on phones
(320–640 px viewports) without breaking the current single-file,
no-build-step, static-Vercel-drop deployment. Tablet (≥768) and
desktop layouts are unchanged.

## Why now

Audit at 375 / 414 / 768 (Playwright, captured 2026-06-24) found three
critical breaks at phone widths:

1. **ASCII trail map is illegible.** The 78-col × 22-row dataset
   shrinks to sub-pixel coins; cost labels overlap; the reveal
   animation's storytelling is lost. This is the hero asset.
2. **Stats grid stays 4-wide.** `repeat(4, 1fr)` at 375 px cramps
   labels into 2-line wraps; "Sessions" gets clipped at 375 / 414.
3. **Install command ellipsizes** to `brew install loschenbd/toke…`.
   The user can copy via the tap-to-copy handler but can't see what
   they're about to run — the `$` glyph and the "copy" affordance
   both vanish. This is the page's conversion CTA.

Compounding issues (not critical alone):

4. Parchment padding `32px 36px 28px` eats 72 px of horizontal
   budget on a 375 viewport.
5. Product screenshots are landscape 1192×800 — scale to ~290 px wide
   on phone, text inside unreadable. They become pure ornament.
6. Body horizontal padding 20 px on each side compounds with #4.

## Constraints (preserved from current site)

- Single-file landing page. No build step. Deploys via Vercel as a
  static drop from `marketing/` (`marketing/README.md`).
- External requests stay limited to `./static/logo.png`,
  `./static/favicon.svg`, `./static/screenshots/*.png`.
- Parchment trail-map aesthetic (calm, lightly fantasy-coded; project
  CLAUDE.md "product identity").
- Project rule 6: GitHub/Notion-style failures should log cleanly,
  not crash. The lightbox script must fail soft if the DOM is
  unexpected.
- Trail-map CSS/JS in `marketing/index.html` is duplicated with
  `src/dashboard/static/trail-map.{css,js}` (`marketing/README.md`
  L20). This spec adds **marketing-only** mobile arrays; the dashboard
  retains only the desktop dataset. README updated to reflect that
  the "edit both" rule does not extend to the mobile dataset.

## Breakpoint

`@media (max-width: 640px)` — aligns with the existing feature-grid
breakpoint already in `marketing/index.html` (line 119).

## Components

### 1. Portrait trail dataset (the hero)

Add two new JS arrays inside the existing IIFE in
`marketing/index.html`:

- `BG_MOBILE` — a portrait grid roughly 32 cols × 50 rows, terrain
  flowing top-to-bottom (mountains at top, river bisecting, marsh /
  sand bands at bottom).
- `TRAIL_MOBILE` — same visual vocabulary as `TRAIL`:
  - `coin` token steps
  - `path` segments using box-drawing chars `─ │ ╱ ╲ ┬ ┼`
  - `cost` labels in the cost-tag style
  - `anom` `!` markers
  - `merge` PR markers
  - `trophy` `⚑` at the trail's end (bottom of the column)
  - `label` markers (`project*` at top, `v1.0✓` near the trophy)
- Same animation phases (reveal → hold → flash → reset) and same
  per-step delays.
- Same anomaly count / merged-PR count derivation — the existing
  `buildFrame()` already counts these from any dataset.

**Selection at runtime:**
- `const mq = window.matchMedia('(max-width: 640px)')`
- Pick `{BG, TRAIL} = mq.matches ? {BG_MOBILE, TRAIL_MOBILE} : {BG: BG_DESKTOP, TRAIL: TRAIL_DESKTOP}`
- `mq.addEventListener('change', ...)` — on change, cancel the pending
  `setTimeout`, reset `step=0, phase='reveal'`, and re-run with the
  new dataset.
- Reduced-motion path also picks the right dataset.

**Mobile font size:**
`.ascii-map { font-size: clamp(0.65rem, 2.4vw, 0.85rem); }` inside the
media query. With a ~32-col mobile dataset and ~14 px font size at
375 px viewport (3.7vw), the map renders at ~310 px wide and stays
inside the parchment frame.

### 2. Responsive chrome

All changes scoped inside the new `@media (max-width: 640px)` block:

| Selector | Desktop | Mobile |
|---|---|---|
| `body` padding | `32px 20px 48px` | `16px 8px 32px` |
| `.frame-outer` padding | `10px` | `6px` |
| `.parchment` padding | `32px 36px 28px` | `20px 14px 18px` |
| `.inner-border` inset | `20px` | `12px` |
| `.stats` grid-template-columns | `repeat(4, 1fr)` | `repeat(2, 1fr)` (2×2) |
| `.stat` padding | `8px 10px` | `10px 8px` |
| `.map-wrap` padding | `14px 16px 18px` | `8px 10px 12px` |
| `.legend` gap | `14px` | `8px` |
| `.legend` font-size | `10px` | `9px` |

Recovers ~50 px of horizontal content budget on a 375 viewport.

### 3. Install CTA — never ellipsize on mobile

Inside the `@media` block:

```css
.install-prompt {
  flex-direction: column;
  align-items: stretch;
  gap: 6px;
  padding: 12px 14px;
}
.install-cmd {
  white-space: normal;          /* override desktop nowrap */
  overflow: visible;             /* override desktop ellipsis */
  text-overflow: clip;
  word-break: break-all;        /* allow `loschenbd/tokentrail/tokentrail` to wrap */
  text-align: center;
}
.install-copy {
  border-left: none;             /* divider doesn't make sense vertical */
  border-top: 1px dashed rgba(196, 154, 58, 0.4);
  padding-left: 0;
  padding-top: 6px;
  text-align: center;
}
.install-dollar { display: none; } /* `$` glyph adds confusion when stacked */
```

Tap-to-copy handler is unchanged.

### 4. Screenshot lightbox

Zero-dep vanilla JS in the same `<script>` IIFE that already drives
the trail animation.

Behavior:
- On `.shot-img` click → create overlay element on demand,
  `position: fixed; inset: 0; background: rgba(0,0,0,0.85);
  display: flex; align-items: center; justify-content: center;
  z-index: 9999`.
- Inside: `<img>` with `max-width: 95vw; max-height: 95vh;
  object-fit: contain; cursor: zoom-out`.
- Dismiss on: click anywhere in overlay, Esc key, browser back
  button (history-state push so back works).
- Lock body scroll while open (`document.body.style.overflow =
  'hidden'`, restore on close).
- Respect `prefers-reduced-motion`: skip the 120 ms fade-in.
- Focus management: store `document.activeElement` on open, return
  focus to it on close. Overlay container gets `tabindex="-1"` and
  `focus()` on open.
- Add `cursor: zoom-in` and `aria-label="Open full size"` on
  `.shot-img` (works on all viewports — useful on desktop too).

Fail-soft: if `<img>` natural dimensions are 0 (broken image), the
overlay still opens but shows the alt text — does not crash.

### 5. Re-shot mobile screenshots

For each of the four `marketing/static/screenshots/*.png`, add a
mobile variant captured by serving the local dashboard and resizing
Playwright to ~390 px viewport:

| Desktop file | Mobile file |
|---|---|
| `welcome-wizard.png` | `welcome-wizard-mobile.png` |
| `daily-overview.png` | `daily-overview-mobile.png` |
| `worth-a-look.png` | `worth-a-look-mobile.png` |
| `feature-detail.png` | `feature-detail-mobile.png` |

If the dashboard pages don't render usable at 390 px (likely — the
dashboard CSS targets desktop), the mobile shot is a **focused
portrait crop** of the most informative region of the desktop view,
saved at native resolution (no upscaling). Crop targets per page:

- `welcome-wizard-mobile`: the install checklist column only (not
  the trail-map preview)
- `daily-overview-mobile`: the cost sparkline + week stat block
- `worth-a-look-mobile`: 2–3 anomaly rows
- `feature-detail-mobile`: the trail-elevation chart + a few session
  rows

Wired via `<picture>` (replaces the four existing `<img>` tags
inside `.shot-frame`):

```html
<picture>
  <source media="(max-width: 640px)"
          srcset="./static/screenshots/welcome-wizard-mobile.png">
  <img class="shot-img"
       src="./static/screenshots/welcome-wizard.png"
       alt="..."
       loading="lazy" width="1192" height="800">
</picture>
```

Lightbox handler from §4 keys off `.shot-img`, which sits on the
fallback `<img>` and resolves correctly in both viewports.

### 6. Marketing README update

Append a short note to `marketing/README.md` documenting:
- The mobile breakpoint (640 px) and where it lives in the file.
- That `BG_MOBILE` / `TRAIL_MOBILE` are marketing-only and do NOT
  need to be mirrored to `src/dashboard/static/trail-map.js`.
- That mobile screenshots are captured at ~390 px viewport (or
  cropped) and live alongside the desktop variants.

## Out of scope

- Rewriting the dashboard product itself (`src/dashboard/*`).
- Adding a framework, SPA, or build step.
- New fonts or external assets.
- Touch gestures beyond tap (no swipe-to-dismiss on lightbox; Esc /
  click-out is sufficient).
- A11y enhancements beyond focus return + Esc handler + aria-label.

## Testing

Manual via Playwright (the same tool that produced the audit):

- Capture screenshots at 320, 375, 414, 640, 768, 1024 widths before
  and after.
- Verify trail animation runs on **both** datasets and that
  resizing across the 640 px boundary triggers a clean re-bind.
- Verify `prefers-reduced-motion` still skips the animation and
  renders the final frame on both datasets.
- Verify tap-to-copy on the install CTA still writes
  `brew install loschenbd/tokentrail/tokentrail` to clipboard at
  ≤640 px.
- Lightbox: click thumbnail → opens; click overlay → closes; Esc
  → closes; browser-back → closes; focus returns to thumbnail.
- No new console errors at any viewport.

## Known risks

- **Trail-map duplication discipline.** Adding a second
  marketing-only dataset narrows but doesn't eliminate the
  CSS/JS duplication with `src/dashboard/`. Mitigation: README note
  in §6.
- **Mobile screenshot regeneration is fragile if the dashboard UI
  changes.** Same risk as the existing desktop screenshots — no new
  category of risk.
- **`word-break: break-all` on the install command** is aggressive
  but correct here: the brew tap path
  (`loschenbd/tokentrail/tokentrail`) has no natural break points
  and `break-word` would not break it. Mono font + tap-to-copy
  means the user never types the wrapped form.
