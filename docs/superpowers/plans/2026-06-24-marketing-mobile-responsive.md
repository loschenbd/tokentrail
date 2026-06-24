# Marketing Mobile Responsive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `marketing/index.html` legible and on-brand on phones (320–640 px viewports) by adding a portrait trail dataset, responsive chrome, an install-CTA fix, a screenshot lightbox, and reshot mobile screenshots — without breaking the single-file, no-build-step Vercel deploy.

**Architecture:** All CSS additions are scoped under a single `@media (max-width: 640px)` block appended to the existing `<style>` in `marketing/index.html`. All JS additions live inside the existing IIFE in the trailing `<script>` block. A second `BG_MOBILE` / `TRAIL_MOBILE` dataset is selected at runtime via `window.matchMedia`. Mobile screenshots are captured (or cropped) against the local dashboard and wired via `<picture>` `<source media>`.

**Tech Stack:** Plain HTML5 + CSS3 + vanilla JS (single file, no build), Playwright MCP for visual verification, local Python `http.server` for serving the file (already used in audit), `tsx src/index.ts dashboard` for the live dashboard when capturing screenshots.

## Global Constraints

- **Single-file landing page.** No build step, no framework, no SPA. Source: `marketing/index.html`. Deploys as a static drop via Vercel from `marketing/`.
- **External requests** stay limited to `./static/logo.png`, `./static/favicon.svg`, `./static/screenshots/*.png`. No CDN, no Google Fonts, no analytics, no remote JS.
- **Breakpoint** is `@media (max-width: 640px)` everywhere (aligns with existing `.feature-grid` rule at `marketing/index.html:119`).
- **Parchment aesthetic preserved** — no new colors, no new fonts. Reuse the existing `--tm-*` CSS variables defined at `marketing/index.html:10-27`.
- **Trail-map JS/CSS is duplicated** with `src/dashboard/static/trail-map.{css,js}` (`marketing/README.md` L20). New `BG_MOBILE` / `TRAIL_MOBILE` arrays are **marketing-only** and must NOT be mirrored to the dashboard.
- **Failures fail soft** — the lightbox script must not crash if the DOM is unexpected (project CLAUDE.md rule 6).
- **`prefers-reduced-motion`** must continue to skip the trail animation on both desktop and mobile datasets.

---

### Task 1: Capture before-state baseline screenshots

**Files:**
- Create: `marketing/.audit-before/375.png`, `marketing/.audit-before/375-full.png`, `marketing/.audit-before/414.png`, `marketing/.audit-before/640.png`, `marketing/.audit-before/768.png`, `marketing/.audit-before/1024.png`
- Modify: `marketing/.gitignore` — add `.audit-before/` and `.audit-after/`

**Interfaces:**
- Produces: a stable visual baseline so later tasks can diff against it.

- [ ] **Step 1: Verify a local server can serve the marketing file**

Run:
```bash
cd /Users/benjaminloschen/Projects/tokentrail/marketing
python3 -m http.server 8765 >/tmp/mktg-server.log 2>&1 &
sleep 1
curl -sI http://localhost:8765/ | head -3
```
Expected: `HTTP/1.0 200 OK`. Leave the server running for the duration of this task; kill at the end with `kill %1`.

- [ ] **Step 2: Add `.audit-before/` and `.audit-after/` to marketing's gitignore**

Edit `marketing/.gitignore` — append two lines:

```
.audit-before/
.audit-after/
```

- [ ] **Step 3: Capture baseline screenshots at six widths**

Using Playwright MCP (or local `playwright` if available), for each width in `[375, 414, 640, 768, 1024]`:
1. `browser_resize` to `width` × `812`
2. `browser_navigate` to `http://localhost:8765/`
3. `browser_take_screenshot` `fullPage: false` → `marketing/.audit-before/<width>.png`
4. `browser_take_screenshot` `fullPage: true` → `marketing/.audit-before/<width>-full.png`

Also capture 320 × 568 (smallest realistic phone) — same two screenshots.

- [ ] **Step 4: Commit the baseline gitignore (the screenshots are intentionally untracked)**

```bash
cd /Users/benjaminloschen/Projects/tokentrail
git add marketing/.gitignore
git commit -m "chore(marketing): ignore audit screenshot output dirs"
```

---

### Task 2: Add responsive chrome (CSS-only)

**Files:**
- Modify: `marketing/index.html` — append a new `@media (max-width: 640px)` block at the end of the existing `<style>` block (just before `</style>` at line 132).

**Interfaces:**
- Consumes: existing CSS classes `body`, `.frame-outer`, `.parchment`, `.inner-border`, `.stats`, `.stat`, `.map-wrap`, `.legend`, `.section-block`.
- Produces: no JS hooks. Pure CSS.

- [ ] **Step 1: Add the media block with chrome tightening**

In `marketing/index.html`, append the following INSIDE the existing `<style>` block, immediately after the existing `@media (max-width:640px){.feature-grid{grid-template-columns:1fr;}}` rule at line 119 — replacing that one line with a consolidated block:

```css
@media (max-width: 640px) {
  body { padding: 16px 8px 32px; }
  .frame-outer { padding: 6px; }
  .parchment { padding: 20px 14px 18px; }
  .inner-border { inset: 12px; }
  .corner-glyph { font-size: 14px; }
  .corner-glyph.tl { top: 8px; left: 10px; }
  .corner-glyph.tr { top: 8px; right: 10px; }
  .corner-glyph.bl { bottom: 8px; left: 10px; }
  .corner-glyph.br { bottom: 8px; right: 10px; }
  .map-header { margin-bottom: 10px; }
  .map-wrap { padding: 8px 10px 12px; }
  .legend { gap: 8px; font-size: 9px; margin-bottom: 10px; }
  .stats { grid-template-columns: repeat(2, 1fr); }
  .stat { padding: 10px 8px; border-right: 1px dashed rgba(139,111,71,0.4); }
  .stat:nth-child(2n) { border-right: none; }
  .stat:nth-child(-n+2) { border-bottom: 1px dashed rgba(139,111,71,0.4); }
  .section-block { margin: 16px 0 4px; }
  .feature-grid { grid-template-columns: 1fr; }
  .ascii-map { font-size: clamp(0.65rem, 2.4vw, 0.85rem); letter-spacing: 0.02em; }
}
```

(Note: the previous `.feature-grid` rule is folded INTO this new block — delete the original `@media (max-width:640px){.feature-grid{grid-template-columns:1fr;}}` line at 119 to avoid two competing media queries.)

- [ ] **Step 2: Visually verify with Playwright**

Restart the local server if it isn't running (`python3 -m http.server 8765` from `marketing/`).

For each width in `[320, 375, 414, 640]`:
- `browser_resize` to `width` × `812`
- `browser_navigate` to `http://localhost:8765/`
- `browser_take_screenshot` `fullPage: false` → `marketing/.audit-after/<width>.png`

Open each `.audit-after/<width>.png` and confirm:
- Stats grid is 2×2 at ≤640 px
- "Sessions" is no longer clipped
- Parchment frame has visibly tighter padding
- Legend wraps cleanly without overflow
- At 768 px (Task 1 baseline), nothing has changed

- [ ] **Step 3: Commit**

```bash
cd /Users/benjaminloschen/Projects/tokentrail
git add marketing/index.html
git commit -m "feat(marketing): tighten chrome and stack stats 2x2 on ≤640px"
```

---

### Task 3: Fix install CTA so the command is always fully visible on mobile

**Files:**
- Modify: `marketing/index.html` — add four selector overrides INSIDE the `@media (max-width: 640px)` block created in Task 2.

**Interfaces:**
- Consumes: existing classes `.install-prompt`, `.install-cmd`, `.install-copy`, `.install-dollar`.
- Produces: no JS hooks; the existing tap-to-copy handler is unchanged.

- [ ] **Step 1: Append install-CTA overrides to the media block**

Inside the `@media (max-width: 640px)` block from Task 2, append:

```css
  .install-prompt {
    flex-direction: column;
    align-items: stretch;
    gap: 6px;
    padding: 12px 14px;
  }
  .install-cmd {
    white-space: normal;
    overflow: visible;
    text-overflow: clip;
    word-break: break-all;
    text-align: center;
  }
  .install-copy {
    border-left: none;
    border-top: 1px dashed rgba(196, 154, 58, 0.4);
    padding-left: 0;
    padding-top: 6px;
    text-align: center;
  }
  .install-dollar { display: none; }
```

- [ ] **Step 2: Visually verify the install zone at 375 px**

- `browser_resize` to `375 × 812`
- `browser_navigate` to `http://localhost:8765/`
- `browser_evaluate`: `() => { document.querySelector('.install-cta').scrollIntoView({block:'center'}); }`
- `browser_take_screenshot` → `marketing/.audit-after/375-install.png`

Open the file and confirm:
- The full command `brew install loschenbd/tokentrail/tokentrail` is visible (wrapped, no ellipsis)
- The "Copy" affordance appears below the command, not inline
- The leading `$` is hidden (it duplicates the wrapped mono command)

- [ ] **Step 3: Verify tap-to-copy still works**

`browser_evaluate`:

```js
async () => {
  document.querySelector('.install-prompt').click();
  await new Promise(r => setTimeout(r, 50));
  // navigator.clipboard.readText may be blocked in headless — instead inspect the visual state
  return document.querySelector('.install-prompt').classList.contains('copied');
}
```

Expected: `true`.

- [ ] **Step 4: Commit**

```bash
cd /Users/benjaminloschen/Projects/tokentrail
git add marketing/index.html
git commit -m "feat(marketing): stack install CTA and never ellipsize brew cmd on mobile"
```

---

### Task 4: Add the screenshot lightbox (vanilla JS + CSS)

**Files:**
- Modify: `marketing/index.html` — add `.shot-lightbox`, `.shot-lightbox img`, `.shot-img:hover` rules to the main `<style>` block (outside any media query); add the lightbox IIFE to the existing `<script>` block.

**Interfaces:**
- Consumes: every `<img class="shot-img">` on the page (4 of them as of this writing).
- Produces: no exports. Self-contained.

- [ ] **Step 1: Write a Playwright verification test as a runnable JS expression**

This codebase has no JS unit-test framework for the marketing site — verification IS the Playwright sequence. Save the following sequence as the spec you'll run after implementation, then keep it as a comment block at the bottom of `marketing/index.html`:

```
LIGHTBOX VERIFICATION (Playwright):
1. browser_navigate http://localhost:8765/
2. browser_evaluate: () => document.querySelectorAll('.shot-lightbox').length  → 0
3. browser_evaluate: () => { document.querySelector('.shot-img').click(); }
4. browser_evaluate: () => document.querySelectorAll('.shot-lightbox').length  → 1
5. browser_press_key Escape
6. browser_evaluate: () => document.querySelectorAll('.shot-lightbox').length  → 0
7. browser_evaluate: () => document.body.style.overflow  → '' (restored)
```

- [ ] **Step 2: Add lightbox CSS to the main `<style>` block**

Append the following to `marketing/index.html` `<style>` (before the new `@media` block from Task 2, so it applies at all viewports):

```css
.shot-img { cursor: zoom-in; }
.shot-lightbox {
  position: fixed; inset: 0;
  background: rgba(0,0,0,0.85);
  display: flex; align-items: center; justify-content: center;
  z-index: 9999;
  padding: 16px;
  cursor: zoom-out;
  animation: shotFade 120ms ease-out;
}
.shot-lightbox img {
  max-width: 95vw; max-height: 95vh;
  object-fit: contain;
  border-radius: 3px;
  box-shadow: 0 8px 32px rgba(0,0,0,0.5);
  cursor: zoom-out;
}
@keyframes shotFade { from { opacity: 0; } to { opacity: 1; } }
@media (prefers-reduced-motion: reduce) {
  .shot-lightbox { animation: none; }
}
```

- [ ] **Step 3: Add lightbox JS to the existing IIFE in the `<script>` block**

Inside the existing IIFE in `marketing/index.html` (the one that starts `(function() {` around line 268), append the following BEFORE the closing `})();`:

```js
// ─── Screenshot lightbox ──────────────────────────────────────────────
(function attachLightbox() {
  const imgs = document.querySelectorAll('.shot-img');
  if (!imgs.length) return;
  let overlay = null;
  let lastTrigger = null;
  let prevOverflow = '';

  function close() {
    if (!overlay) return;
    overlay.remove();
    overlay = null;
    document.body.style.overflow = prevOverflow;
    document.removeEventListener('keydown', onKey);
    if (lastTrigger && typeof lastTrigger.focus === 'function') lastTrigger.focus();
    lastTrigger = null;
  }

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
  }

  function open(src, alt, trigger) {
    if (!src) return; // fail-soft
    lastTrigger = trigger;
    prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    overlay = document.createElement('div');
    overlay.className = 'shot-lightbox';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', alt || 'Screenshot');
    overlay.tabIndex = -1;
    const img = document.createElement('img');
    img.src = src;
    img.alt = alt || '';
    overlay.appendChild(img);
    overlay.addEventListener('click', close);
    document.body.appendChild(overlay);
    overlay.focus();
    document.addEventListener('keydown', onKey);
  }

  imgs.forEach(img => {
    img.setAttribute('aria-label', 'Open full size');
    img.addEventListener('click', () => {
      // Prefer the highest-resolution source available — desktop src is the fallback.
      const picture = img.closest('picture');
      const desktopSrc = img.getAttribute('src') || img.currentSrc;
      open(desktopSrc, img.getAttribute('alt'), img);
    });
  });
})();
```

Note: this opens the **desktop-resolution** image even on mobile (the fallback `<img src=...>`), which is the point — the lightbox is how mobile users see the full UI.

- [ ] **Step 4: Run the verification sequence from Step 1**

Using Playwright MCP, run steps 1–7 from the comment block. Confirm every expected output matches.

- [ ] **Step 5: Capture a lightbox-open screenshot**

- `browser_resize` to `375 × 812`
- `browser_navigate` to `http://localhost:8765/`
- `browser_evaluate`: `() => { document.querySelector('.shot-img').click(); }`
- `browser_take_screenshot` → `marketing/.audit-after/375-lightbox.png`

Open and confirm the full-resolution screenshot is centered with a dark overlay.

- [ ] **Step 6: Commit**

```bash
cd /Users/benjaminloschen/Projects/tokentrail
git add marketing/index.html
git commit -m "feat(marketing): vanilla-JS screenshot lightbox with Esc/click-out"
```

---

### Task 5: Build the portrait trail dataset and runtime selection

**Files:**
- Modify: `marketing/index.html` — add `BG_MOBILE` and `TRAIL_MOBILE` arrays inside the existing IIFE, rename the current `BG` → `BG_DESKTOP` and `TRAIL` → `TRAIL_DESKTOP`, add `matchMedia`-based selection and a `change` listener that resets the animation.

**Interfaces:**
- Consumes: existing `baseGrid()` and `buildFrame()` functions — they are already dataset-agnostic and accept whichever `BG` / `TRAIL` are in scope when called.
- Produces: no exports.

- [ ] **Step 1: Rename the existing dataset constants**

In `marketing/index.html`, inside the IIFE:
- Rename `const BG = [...]` → `const BG_DESKTOP = [...]`
- Rename `const TRAIL = [...]` → `const TRAIL_DESKTOP = [...]`

Update `baseGrid()` to take the dataset as a parameter:

```js
function baseGrid(BG) {
  return BG.map(l => l.padEnd(l.length, ' ').split(''));
}
```

Note: `BG_DESKTOP` rows are 78 characters and were previously padded to 80. Replace `l.padEnd(80, ' ')` with `l.padEnd(BG[0].length, ' ')` so it works for both datasets regardless of width.

Update `buildFrame()` similarly to take `(visible, flash, BG, TRAIL)` as parameters, and update every reference to `TRAIL` inside `buildFrame()` to use the passed parameter. Update the grid-width clamp (`s.c+1 < 80`, `s.c+ci < 80`, etc.) to use `BG[0].length` instead of `80`.

- [ ] **Step 2: Add the portrait dataset**

Inside the IIFE, after the existing `TRAIL_DESKTOP` declaration, add:

```js
// ─── PORTRAIT GEOGRAPHY: 32 × 50 (mobile, top-to-bottom flow) ────────
const BG_MOBILE = [
  "▲ ▲▲   ▲▲▲   ▲ ▲ ▲▲   ▲▲▲▲ ▲ ▲▲",
  " ▲▲▲▲   ▲▲▲▲▲ ▲▲ ▲▲▲▲▲ ▲▲▲ ▲▲▲",
  "▲▲ ▲▲▲   ▲▲▲▲▲▲▲ ▲▲▲▲▲▲▲ ▲▲▲▲▲",
  " ▲▲▲▲     ▲▲▲ ▲    ▲▲▲▲ ▲▲▲▲▲ ",
  "  ▲▲                  ▲▲▲ ▲▲  ",
  "                                ",
  "♣ ♣ ♣                      ♣ ♣ ",
  " ♣♣♣♣                     ♣♣ ♣ ",
  "  ♣♣                       ♣ ♣ ",
  "                                ",
  "                                ",
  "                                ",
  "                                ",
  "                                ",
  "                                ",
  "≈ ≈ ≈ ≈ ≈ ≈ ≈ ≈ ≈ ≈ ≈ ≈ ≈ ≈ ≈ ",
  " ≈ ≈ ≈ ≈ ≈ ≈ ≈ ≈ ≈ ≈ ≈ ≈ ≈ ≈ ≈",
  "≈ ≈ ≈ ≈ ≈ ≈ ≈ ≈ ≈ ≈ ≈ ≈ ≈ ≈ ≈ ",
  "                                ",
  "                                ",
  "                                ",
  "                                ",
  "                                ",
  "                                ",
  "                                ",
  "                                ",
  "                                ",
  "                                ",
  "                                ",
  "                                ",
  "                                ",
  "                                ",
  "                                ",
  "                                ",
  "                                ",
  "                                ",
  "                                ",
  "                                ",
  "                                ",
  "                                ",
  "                                ",
  "                                ",
  "                                ",
  "                                ",
  "                                ",
  "                                ",
  "  ∿ ∿ ∿ ∿ ∿                    ",
  "   ∿ ∿ ∿ ∿                    ",
  "    ∿ ∿                       ",
  "                                ",
];

// ─── PORTRAIT TRAIL: trail flows downward, branches to the side ──────
const TRAIL_MOBILE = [
  { type: 'label',  r: 0,  c: 0,  text: 'project*' },
  { type: 'path',   r: 1,  c: 4,  ch: '│' },
  { type: 'path',   r: 2,  c: 4,  ch: '│' },
  { type: 'coin',   r: 3,  c: 4 },
  { type: 'cost',   r: 3,  c: 7,  text: '$12' },
  { type: 'path',   r: 4,  c: 4,  ch: '│' },
  { type: 'path',   r: 5,  c: 4,  ch: '│' },
  { type: 'branch', r: 6,  c: 4,  ch: '┬' },
  { type: 'path',   r: 6,  c: 5,  ch: '─' },
  { type: 'path',   r: 6,  c: 6,  ch: '─' },
  { type: 'coin',   r: 6,  c: 7 },
  { type: 'cost',   r: 6,  c: 10, text: '$47' },
  { type: 'path',   r: 7,  c: 4,  ch: '│' },
  { type: 'coin',   r: 8,  c: 4 },
  { type: 'cost',   r: 8,  c: 7,  text: '$35' },
  { type: 'path',   r: 9,  c: 4,  ch: '│' },
  { type: 'merge',  r: 10, c: 4,  pr: '#1' },
  { type: 'path',   r: 11, c: 4,  ch: '│' },
  { type: 'path',   r: 12, c: 4,  ch: '│' },
  { type: 'branch', r: 13, c: 4,  ch: '┼' },
  { type: 'path',   r: 13, c: 5,  ch: '─' },
  { type: 'path',   r: 13, c: 6,  ch: '─' },
  { type: 'coin',   r: 13, c: 7 },
  { type: 'cost',   r: 13, c: 10, text: '$32' },
  { type: 'path',   r: 14, c: 4,  ch: '│' },
  { type: 'coin',   r: 15, c: 4 },
  { type: 'cost',   r: 15, c: 7,  text: '$18' },
  { type: 'path',   r: 18, c: 4,  ch: '│' },
  { type: 'path',   r: 19, c: 4,  ch: '│' },
  { type: 'coin',   r: 20, c: 4 },
  { type: 'cost',   r: 20, c: 7,  text: '$24' },
  { type: 'path',   r: 21, c: 4,  ch: '│' },
  { type: 'merge',  r: 22, c: 4,  pr: '#2,3' },
  { type: 'path',   r: 23, c: 4,  ch: '│' },
  { type: 'branch', r: 24, c: 4,  ch: '┬' },
  { type: 'path',   r: 24, c: 5,  ch: '─' },
  { type: 'path',   r: 24, c: 6,  ch: '─' },
  { type: 'coin',   r: 24, c: 7 },
  { type: 'cost',   r: 24, c: 10, text: '$14' },
  { type: 'path',   r: 25, c: 4,  ch: '│' },
  { type: 'coin',   r: 26, c: 4 },
  { type: 'path',   r: 27, c: 4,  ch: '│' },
  { type: 'branch', r: 28, c: 4,  ch: '┼' },
  { type: 'path',   r: 28, c: 5,  ch: '─' },
  { type: 'path',   r: 28, c: 6,  ch: '─' },
  { type: 'coin',   r: 28, c: 7 },
  { type: 'cost',   r: 28, c: 10, text: '$83' },
  { type: 'anom',   r: 28, c: 14, text: '!' },
  { type: 'path',   r: 29, c: 4,  ch: '│' },
  { type: 'coin',   r: 30, c: 4 },
  { type: 'cost',   r: 30, c: 7,  text: '$61' },
  { type: 'path',   r: 31, c: 4,  ch: '│' },
  { type: 'merge',  r: 32, c: 4,  pr: '#6,7' },
  { type: 'path',   r: 33, c: 4,  ch: '│' },
  { type: 'coin',   r: 34, c: 4 },
  { type: 'path',   r: 35, c: 4,  ch: '│' },
  { type: 'branch', r: 36, c: 4,  ch: '┬' },
  { type: 'path',   r: 36, c: 5,  ch: '─' },
  { type: 'path',   r: 36, c: 6,  ch: '─' },
  { type: 'coin',   r: 36, c: 7 },
  { type: 'cost',   r: 36, c: 10, text: '$29' },
  { type: 'path',   r: 37, c: 4,  ch: '│' },
  { type: 'coin',   r: 38, c: 4 },
  { type: 'cost',   r: 38, c: 7,  text: '$74' },
  { type: 'anom',   r: 38, c: 11, text: '!' },
  { type: 'path',   r: 39, c: 4,  ch: '│' },
  { type: 'merge',  r: 40, c: 4,  pr: '#9,11' },
  { type: 'path',   r: 41, c: 4,  ch: '│' },
  { type: 'cost',   r: 41, c: 7,  text: 'total:$429' },
  { type: 'trophy', r: 42, c: 3,  text: '⚑' },
  { type: 'trophy', r: 42, c: 4,  text: '|' },
  { type: 'trophy', r: 42, c: 5,  text: '|' },
  { type: 'label',  r: 43, c: 1,  text: ' v1.0✓' },
];
```

(The dataset above is the starting design; the implementer should sanity-check that no two glyphs collide at the same `(r, c)` by sorting the array and asserting uniqueness. Adjust counts/positions if a clash appears — vocabulary and intent are what matters, not exact coordinates.)

- [ ] **Step 3: Add runtime selection and re-bind logic**

Inside the IIFE, immediately after both datasets are declared and `baseGrid` / `buildFrame` are defined (parameterized per Step 1), replace the existing `tick` / `tickStats` initialization with:

```js
const mq = window.matchMedia('(max-width: 640px)');
let activeBG = mq.matches ? BG_MOBILE : BG_DESKTOP;
let activeTRAIL = mq.matches ? TRAIL_MOBILE : TRAIL_DESKTOP;
let pendingTimeout = null;

function tick() {
  let delay;
  if (phase === 'reveal') {
    const { html, mergedCount, anomCount } = buildFrame(step, false, activeBG, activeTRAIL);
    el.innerHTML = html;
    prsEl.textContent = mergedCount;
    anomEl.textContent = anomCount || '—';
    anomSubEl.textContent = anomCount === 2 ? '1 hot_session · 1 spike_day' : anomCount === 1 ? '1 active' : 'none detected';
    step++;
    if (step > activeTRAIL.length) { phase = 'hold'; delay = HOLD_MS; }
    else delay = STEP_MS;
  } else if (phase === 'hold') {
    const { html, mergedCount, anomCount } = buildFrame(activeTRAIL.length, true, activeBG, activeTRAIL);
    el.innerHTML = html; prsEl.textContent = mergedCount; anomEl.textContent = anomCount;
    phase = 'flash'; delay = FLASH_MS;
  } else if (phase === 'flash') {
    const { html, mergedCount } = buildFrame(activeTRAIL.length, false, activeBG, activeTRAIL);
    el.innerHTML = html; prsEl.textContent = mergedCount;
    phase = 'flash2'; delay = FLASH_MS;
  } else if (phase === 'flash2') {
    const { html, mergedCount } = buildFrame(activeTRAIL.length, true, activeBG, activeTRAIL);
    el.innerHTML = html; prsEl.textContent = mergedCount;
    phase = 'reset'; delay = FLASH_MS;
  } else {
    const { html } = buildFrame(0, false, activeBG, activeTRAIL);
    el.innerHTML = html; prsEl.textContent = 0;
    anomEl.textContent = '—'; anomSubEl.textContent = 'active';
    step = 0; phase = 'reveal'; delay = RESET_MS;
  }
  pendingTimeout = setTimeout(tick, delay);
}

function rebindForViewport() {
  if (pendingTimeout) clearTimeout(pendingTimeout);
  activeBG = mq.matches ? BG_MOBILE : BG_DESKTOP;
  activeTRAIL = mq.matches ? TRAIL_MOBILE : TRAIL_DESKTOP;
  step = 0; phase = 'reveal';
  if (reduced) {
    const { html, mergedCount, anomCount } = buildFrame(activeTRAIL.length, false, activeBG, activeTRAIL);
    el.innerHTML = html;
    prsEl.textContent = mergedCount;
    anomEl.textContent = anomCount;
  } else {
    tick();
  }
}

mq.addEventListener('change', rebindForViewport);
```

Update the existing `const reduced = window.matchMedia(...)` block and its branches to use `activeBG` / `activeTRAIL` (the snippet above already does this for the runtime path; the reduced-motion initial path needs the same swap).

- [ ] **Step 4: Visually verify the mobile trail at 320, 375, 414, 640**

Restart the server if needed, then for each width:
- `browser_resize` to `width × 812`
- `browser_navigate` to `http://localhost:8765/`
- `browser_take_screenshot` `fullPage: false` → `marketing/.audit-after/<width>-trail.png`

Open each and confirm:
- The trail flows top-to-bottom
- Coins, branches, cost tags, and `⚑` trophy are all legible (clearly distinguishable individual glyphs)
- No glyph overlap or `undefined` text leaking through
- At 768 px (above the breakpoint), the original horizontal trail still renders

- [ ] **Step 5: Verify the viewport-resize re-bind**

`browser_resize` to `1024 × 800`, navigate, then resize to `375 × 812` without re-navigating. Take a screenshot. Confirm the trail has switched to the portrait dataset. Resize back to `1024 × 800` — confirm it switches back.

- [ ] **Step 6: Verify reduced-motion still works**

`browser_evaluate`:

```js
() => {
  // emulate reduced motion via a CSS-level patch since matchMedia is read at IIFE init time
  // — just confirm by directly checking whether the final-state frame is rendered when matchMedia returns true.
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
```

If the host honors `prefers-reduced-motion`, also use Playwright's emulation: `browser.emulateMedia({ reducedMotion: 'reduce' })` if available, navigate, and confirm the final frame is shown without animation.

- [ ] **Step 7: Commit**

```bash
cd /Users/benjaminloschen/Projects/tokentrail
git add marketing/index.html
git commit -m "feat(marketing): portrait trail dataset for ≤640px with matchMedia rebind"
```

---

### Task 6: Capture mobile screenshots and wire them via `<picture>`

**Files:**
- Create: `marketing/static/screenshots/welcome-wizard-mobile.png`, `daily-overview-mobile.png`, `worth-a-look-mobile.png`, `feature-detail-mobile.png`
- Modify: `marketing/index.html` — wrap each of the four `<img class="shot-img">` inside a `<picture>` with a mobile `<source>`.

**Interfaces:**
- Consumes: the running local dashboard (`tsx src/index.ts dashboard --port 9876 --no-open`) for source frames.
- Produces: four new PNG assets under `marketing/static/screenshots/`.

- [ ] **Step 1: Run the local dashboard with a seeded DB**

The marketing screenshots were originally captured against the developer's real local DB. Use whatever DB is already present at the default tokentrail data path:

```bash
cd /Users/benjaminloschen/Projects/tokentrail
tsx src/index.ts dashboard --port 9876 --no-open >/tmp/tt-dash.log 2>&1 &
sleep 2
curl -sI http://127.0.0.1:9876/ | head -3
```
Expected: `HTTP/1.1 200 OK` (or 302/200 redirect chain). Leave it running.

- [ ] **Step 2: Capture each mobile screenshot**

For each `(route, output_filename)` in:

```
('/',                         'daily-overview-mobile.png')
('/wizard',                   'welcome-wizard-mobile.png')   # adjust route if different
('/anomalies',                'worth-a-look-mobile.png')     # adjust route if different
('/feature/tokentrail',       'feature-detail-mobile.png')   # adjust feature slug if different
```

(Discover actual routes by `curl -s http://127.0.0.1:9876/ | grep -i 'href='` and inspecting `src/dashboard/server.ts` route registrations.)

- `browser_resize` to `390 × 844` (iPhone 13/14 dimensions)
- `browser_navigate` to `http://127.0.0.1:9876/<route>`
- `browser_take_screenshot` `fullPage: false` → `marketing/static/screenshots/<output_filename>`

If a captured page is clearly desktop-only and doesn't compose well at 390 px (text overlapping, horizontal scroll, etc.):
- Take a desktop-sized screenshot instead (`browser_resize 1280 × 800`)
- Use ImageMagick or any image tool to crop to a portrait region (~390 × 800 px) of the most informative section per the spec (`docs/superpowers/specs/2026-06-24-marketing-mobile-responsive-design.md` §5)
- Example crop commands using `magick`:
  ```bash
  magick marketing/static/screenshots/_raw-daily.png -crop 700x1400+250+100 -resize 390x marketing/static/screenshots/daily-overview-mobile.png
  ```

Verify each output file is non-zero and `file` reports `PNG image`:
```bash
ls -la marketing/static/screenshots/*-mobile.png
file marketing/static/screenshots/*-mobile.png
```

- [ ] **Step 3: Wire `<picture>` elements**

In `marketing/index.html`, replace each of the four `<img class="shot-img" ...>` blocks with a `<picture>` wrapper. Example for the welcome wizard at line ~199:

```html
<picture>
  <source media="(max-width: 640px)" srcset="./static/screenshots/welcome-wizard-mobile.png">
  <img class="shot-img" src="./static/screenshots/welcome-wizard.png" alt="Tokentrail welcome wizard: a five-item install checklist on a parchment-themed page, with an ASCII trail map preview rendering on the right." loading="lazy" width="1192" height="800">
</picture>
```

Repeat for daily-overview, worth-a-look, and feature-detail at their respective `<img>` sites. Preserve every existing attribute on the `<img>` (the `alt`, `loading`, `width`, `height`) — those still drive the lightbox and accessibility.

- [ ] **Step 4: Visually verify at 375 and 768**

- `browser_resize` to `375 × 812`, navigate, scroll through, screenshot `marketing/.audit-after/375-shots.png`
- `browser_resize` to `768 × 1024`, navigate, scroll through, screenshot `marketing/.audit-after/768-shots.png`

Confirm:
- At 375, the mobile-cropped/captured screenshots appear (more legible than the original landscape)
- At 768, the original landscape screenshots appear unchanged
- Lightbox still works at both widths (click a thumbnail → desktop-resolution image opens)

- [ ] **Step 5: Stop the dashboard server**

```bash
kill %1   # or kill the dashboard process by PID from /tmp/tt-dash.log
```

- [ ] **Step 6: Commit**

```bash
cd /Users/benjaminloschen/Projects/tokentrail
git add marketing/static/screenshots/ marketing/index.html
git commit -m "feat(marketing): mobile-cropped product screenshots via <picture>"
```

---

### Task 7: Update marketing README and final verification

**Files:**
- Modify: `marketing/README.md` — append a "Mobile breakpoint" section.
- Create: `marketing/.audit-after/diff-summary.md` (untracked, ignored by gitignore from Task 1) — engineer's own notes for the PR description.

**Interfaces:**
- Produces: documentation entry pointing the next maintainer to the breakpoint, the mobile dataset, and the screenshot pipeline.

- [ ] **Step 1: Append the README note**

Append the following to `marketing/README.md`:

```markdown
## Mobile breakpoint

The page targets `@media (max-width: 640px)` for phones. Inside the
single `@media` block at the bottom of the `<style>` element you'll
find: chrome padding tightens, the 4-column stats grid stacks 2×2,
the install CTA wraps without ellipsis, and the trail map switches
to a portrait dataset.

The mobile trail (`BG_MOBILE` + `TRAIL_MOBILE` in the IIFE) is
**marketing-only** — it does NOT need to be mirrored to
`src/dashboard/static/trail-map.js`. The desktop dataset
(`BG_DESKTOP` + `TRAIL_DESKTOP`) still mirrors the dashboard.

Mobile product screenshots are captured at ~390 px viewport against
the local dashboard (`tsx src/index.ts dashboard --port 9876`) and
saved as `<name>-mobile.png` alongside their desktop counterparts.
The `<picture>` blocks in `index.html` swap them in below 640 px.
```

- [ ] **Step 2: Final cross-width verification sweep**

Restart the local marketing server. For each width in `[320, 375, 414, 640, 768, 1024]`:
- `browser_resize` to `width × 812`
- `browser_navigate` to `http://localhost:8765/`
- `browser_take_screenshot` `fullPage: true` → `marketing/.audit-after/<width>-final-full.png`

Compare each against `marketing/.audit-before/<width>-full.png`. Confirm:
- ≤640 px widths show: portrait trail, 2×2 stats, full install command, mobile-screenshot variants
- 768 and 1024 are visually identical to baseline
- No console errors at any width (check via `browser_console_messages`)

- [ ] **Step 3: Confirm no regressions in the existing animation**

Run the page at 1024 px for ~15 seconds. Confirm the reveal/hold/flash/reset cycle still completes. Run at 375 px for ~15 seconds. Confirm the portrait dataset cycles cleanly.

- [ ] **Step 4: Confirm the existing tap-to-copy + lightbox both work at all widths**

At 375 px and at 1024 px:
- Click install CTA → confirm `.copied` class toggles
- Click a screenshot → confirm lightbox opens, Esc dismisses it

- [ ] **Step 5: Commit the README update**

```bash
cd /Users/benjaminloschen/Projects/tokentrail
git add marketing/README.md
git commit -m "docs(marketing): document 640px breakpoint and mobile trail dataset"
```

- [ ] **Step 6: Stop the local server**

```bash
kill %1   # or `pkill -f "http.server 8765"`
```

---

## Verification summary (post-implementation)

After all tasks merge, the marketing site at `https://tokentrail.benjaminloschen.com` (post-deploy) should satisfy:

- ✅ Renders cleanly at 320 / 375 / 414 / 640 / 768 / 1024 widths.
- ✅ ASCII trail map is legible at every width.
- ✅ Stats grid never clips.
- ✅ Install command is always fully visible and tap-to-copy works.
- ✅ Product screenshots are tappable (lightbox) at all widths.
- ✅ Mobile-cropped screenshots appear ≤640 px; desktop landscape appears ≥641 px.
- ✅ `prefers-reduced-motion` skips the animation on both datasets.
- ✅ No new external requests, no build step introduced, file count change is +4 PNGs.
- ✅ Marketing README documents the breakpoint and the dataset split.

---

## Self-review

**Spec coverage check:**
- Portrait trail dataset → Task 5 ✓
- Responsive chrome → Task 2 ✓
- Install CTA never ellipsizes → Task 3 ✓
- Screenshot lightbox → Task 4 ✓
- Reshot mobile screenshots → Task 6 ✓
- README update → Task 7 ✓
- Breakpoint 640 px throughout → ✓
- No build step / single file / external-request limit → preserved (Global Constraints) ✓
- Trail-map duplication note → Task 7 README ✓
- `prefers-reduced-motion` preserved → Task 5 Step 6 + Task 7 Step 3 ✓

**Placeholder scan:** No "TBD" / "implement later" / "similar to Task N" patterns. Each step includes the actual code, command, or screenshot path.

**Type consistency:** `BG_DESKTOP` / `BG_MOBILE` / `TRAIL_DESKTOP` / `TRAIL_MOBILE` used consistently across Task 5. `buildFrame` signature `(visible, flash, BG, TRAIL)` consistent. `baseGrid` takes `(BG)` consistently. `.shot-img` selector used in Task 4 (lightbox) and Task 6 (`<picture>` fallback) — preserved on the fallback `<img>`.

**One known fuzz:** Task 6 Step 2 lists dashboard routes as best-guess (`/wizard`, `/anomalies`, `/feature/tokentrail`). The implementer discovers the real routes from `src/dashboard/server.ts` and the live HTML. Resolved inline with discovery commands.
