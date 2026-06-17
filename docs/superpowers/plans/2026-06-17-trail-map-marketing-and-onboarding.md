# Trail Map (Marketing + Onboarding) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the animated parchment trail map in three places — a new static marketing site at `marketing/`, the dashboard's empty state on `/`, and a dedicated `/welcome` route.

**Architecture:** Extract the user-supplied HTML's CSS and JS into two new dashboard static files (`trail-map.css`, `trail-map.js`). Build a server-rendered partial `renderTrailMap({ mode })` that emits the parchment body markup; the partial is used by `GET /welcome` and by the dashboard's empty state. The marketing site is a separate standalone `marketing/index.html` with the same CSS/JS inlined.

**Tech Stack:** TypeScript, Fastify, plain HTML/CSS/JS for marketing.

**Spec:** `docs/superpowers/specs/2026-06-17-trail-map-marketing-and-onboarding-design.md`

## Global Constraints

- The ASCII map data (`BG` array) and trail data (`TRAIL` array) are lifted from the user-supplied HTML VERBATIM — no edits to those data structures.
- All trail-map CSS rules are nested under a `.trail-map` wrapper to prevent leakage in/out of the dashboard.
- The internal class `.label` is renamed to `.tm-label` in both the dashboard CSS file and the marketing inline copy — `.label` collides with `dashboard.css:81` which sets a different font/spacing for the dashboard's eyebrow text. No other class names collide.
- Trail data is illustrative (hard-coded). No DB queries from the trail map partial.
- Honor `prefers-reduced-motion: reduce` — render the fully-revealed trail without starting any loops.
- File-edit policy from `CLAUDE.md`: idempotent SQL only (N/A here); no API keys in code (N/A here).
- Don't introduce new dependencies.

---

## Task 1: Extract trail-map CSS and JS as dashboard static assets

**Files:**
- Create: `src/dashboard/static/trail-map.css`
- Create: `src/dashboard/static/trail-map.js`
- Modify: `src/dashboard/server.ts:95-102` (the `STATIC_ALLOW` set)

**Interfaces:**
- Consumes: nothing — first task.
- Produces: two static assets served at `/static/trail-map.css` and `/static/trail-map.js`. The CSS scopes everything under `.trail-map`. The JS expects a `<pre id="ascii">`, a `#prs`, `#anom-count`, `#anom-sub`, `#cost-today`, `#cost-sub`, `#sess-count` in the DOM, plus an optional `[data-copy]` button that copies its `data-copy` value to the clipboard on click.

- [ ] **Step 1: Create `src/dashboard/static/trail-map.css`**

Write this file with the exact content below. The selectors are scoped under `.trail-map`. The `.label` class from the source HTML is renamed to `.tm-label`. Otherwise this is the source HTML's `<style>` block adapted for external serving.

```css
/* Trail map — used by /welcome, the dashboard empty state, and the
   marketing site (the marketing copy lives inline in marketing/index.html
   and must stay in sync with this file). */

.trail-map {
  --tm-ink:         #3d2f1f;
  --tm-ink-muted:   #6b563d;
  --tm-ink-subtle:  #8b6f47;
  --tm-parch-top:   #fdf6e3;
  --tm-parch-mid:   #f5e6c8;
  --tm-parch-bot:   #ede0bb;
  --tm-card-border: #c9b48d;
  --tm-green:       #5d7a3e;
  --tm-amber:       #8b6f47;
  --tm-coin:        #7a4f1a;
  --tm-coin-rim:    #c49a3a;
  --tm-red:         #8b2020;
  --tm-red-bright:  #cc3333;
  --tm-gold:        #b8860b;
  --tm-font-serif:  Georgia, "Times New Roman", serif;
  --tm-font-mono:   ui-monospace, "SF Mono", Menlo, monospace;

  font-family: var(--tm-font-serif);
  color: var(--tm-ink);
  display: flex;
  justify-content: center;
  padding: 20px 0;
}
.trail-map *, .trail-map *::before, .trail-map *::after { box-sizing: border-box; }
.trail-map .frame-outer {
  background: #b8a070;
  padding: 10px;
  border-radius: 3px;
  box-shadow: 0 20px 64px rgba(0,0,0,0.35), 0 4px 12px rgba(0,0,0,0.2);
  width: min(980px, 100%);
}
.trail-map .parchment {
  position: relative;
  background:
    radial-gradient(ellipse at 8% 12%, rgba(210,175,100,0.25) 0%, transparent 45%),
    radial-gradient(ellipse at 92% 88%, rgba(160,120,50,0.22) 0%, transparent 45%),
    radial-gradient(ellipse at 50% 50%, var(--tm-parch-top) 0%, var(--tm-parch-mid) 55%, var(--tm-parch-bot) 100%);
  border: 1px solid rgba(139,111,71,0.5);
  padding: 32px 36px 28px;
  overflow: hidden;
}
.trail-map .parchment::before {
  content:""; position:absolute; inset:0;
  background-image: radial-gradient(circle at 1px 1px, rgba(61,47,31,0.05) 1px, transparent 0);
  background-size: 10px 10px; pointer-events: none; z-index: 0;
}
.trail-map .parchment::after {
  content:""; position:absolute; inset:0;
  background: radial-gradient(ellipse at 50% 50%, transparent 52%, rgba(100,70,30,0.2) 100%);
  pointer-events: none; z-index: 0;
}
.trail-map .parchment > * { position: relative; z-index: 1; }
.trail-map .corners { position: absolute; inset: 0; pointer-events: none; z-index: 2; }
.trail-map .corner-glyph { position: absolute; font-family: var(--tm-font-mono); font-size: 18px; color: var(--tm-amber); opacity: 0.55; line-height: 1; }
.trail-map .corner-glyph.tl { top: 12px; left: 14px; }
.trail-map .corner-glyph.tr { top: 12px; right: 14px; }
.trail-map .corner-glyph.bl { bottom: 12px; left: 14px; }
.trail-map .corner-glyph.br { bottom: 12px; right: 14px; }
.trail-map .inner-border { position: absolute; inset: 20px; border: 1px dashed rgba(139,111,71,0.22); border-radius: 2px; pointer-events: none; z-index: 1; }
.trail-map .map-header { text-align: center; margin-bottom: 16px; }
.trail-map .map-eyebrow { font-size: 9px; text-transform: uppercase; letter-spacing: 3.5px; color: var(--tm-ink-muted); margin-bottom: 5px; }
.trail-map .map-title { font-size: clamp(24px,4.5vw,38px); font-weight: 600; color: var(--tm-ink); letter-spacing: -0.02em; line-height: 1; }
.trail-map .map-tagline { font-style: italic; font-size: 12px; color: var(--tm-ink-muted); margin-top: 5px; }
.trail-map .rule { border: none; border-top: 1px dashed rgba(139,111,71,0.5); margin: 12px 0; }
.trail-map .map-wrap {
  position: relative;
  background: rgba(255,255,255,0.15);
  border: 1px solid rgba(139,111,71,0.3);
  border-radius: 2px;
  padding: 14px 16px 18px;
  box-shadow: inset 0 2px 10px rgba(61,47,31,0.06);
  margin-bottom: 14px;
  overflow: hidden;
}
.trail-map .scale { position: absolute; bottom: 7px; left: 14px; font-size: 8px; text-transform: uppercase; letter-spacing: 1.5px; color: var(--tm-ink-muted); opacity: 0.6; user-select: none; }
.trail-map .ascii-map {
  font-family: var(--tm-font-mono);
  font-size: clamp(0.55rem, 1.05vw, 0.67rem);
  line-height: 1.44;
  white-space: pre;
  color: var(--tm-ink);
  letter-spacing: 0.035em;
  user-select: none;
  display: block;
  margin: 0;
}
/* terrain */
.trail-map .tree  { color: rgba(80,110,50,0.38); }
.trail-map .mtn   { color: rgba(110,85,55,0.35); }
.trail-map .water { color: rgba(60,90,110,0.38); }
.trail-map .plain { color: rgba(100,80,55,0.28); }
.trail-map .marsh { color: rgba(60,100,80,0.32); }
.trail-map .sand  { color: rgba(160,130,70,0.32); }
/* trail */
.trail-map .tok-rim  { color: var(--tm-coin-rim); font-weight: bold; }
.trail-map .tok-face { color: var(--tm-coin); font-weight: bold; text-shadow: 0 0 3px rgba(196,154,58,0.55); }
.trail-map .path     { color: var(--tm-amber); }
.trail-map .branch   { color: #4a7a35; font-weight: bold; }
.trail-map .merged   { color: var(--tm-red); font-weight: bold; }
.trail-map .tm-label { color: var(--tm-ink-muted); font-style: italic; }
.trail-map .cost-tag { color: #6b4f2a; font-size: 0.82em; }
.trail-map .spark-rim  { color: #7db85a; font-weight: bold; }
.trail-map .spark-face { color: #5d7a3e; font-weight: bold; text-shadow: 0 0 5px rgba(93,122,62,0.9); }
/* anomaly */
.trail-map .anom { color: var(--tm-red-bright); font-weight: bold; animation: tmAnomPulse 1.8s ease-in-out infinite; }
@keyframes tmAnomPulse {
  0%,100% { opacity: 1; text-shadow: 0 0 4px rgba(204,51,51,0.5); }
  50%     { opacity: 0.45; text-shadow: none; }
}
/* trophy */
.trail-map .trophy { color: var(--tm-gold); font-weight: bold; }
.trail-map .trophy-flash { color: var(--tm-gold); font-weight: bold; animation: tmTrophyGlow 1.2s ease-in-out infinite; text-shadow: 0 0 6px rgba(184,134,11,0.7); }
@keyframes tmTrophyGlow {
  0%,100% { opacity: 1; text-shadow: 0 0 8px rgba(184,134,11,0.9), 0 0 14px rgba(196,154,58,0.5); }
  50%     { opacity: 0.75; text-shadow: 0 0 3px rgba(184,134,11,0.4); }
}
.trail-map .legend { display: flex; gap: 14px; flex-wrap: wrap; justify-content: center; font-size: 10px; color: var(--tm-ink-muted); margin-bottom: 14px; letter-spacing: 0.02em; }
.trail-map .leg { display: flex; align-items: center; gap: 4px; }
.trail-map .leg-g { font-family: var(--tm-font-mono); font-size: 11px; min-width: 14px; text-align: center; }
.trail-map .stats { display: grid; grid-template-columns: repeat(4, 1fr); border: 1px dashed rgba(139,111,71,0.4); border-radius: 3px; overflow: hidden; margin-bottom: 16px; }
.trail-map .stat { padding: 8px 10px; border-right: 1px dashed rgba(139,111,71,0.4); text-align: center; font-size: 9px; text-transform: uppercase; letter-spacing: 1.5px; color: var(--tm-ink-muted); }
.trail-map .stat:last-child { border-right: none; }
.trail-map .stat-val { display: block; font-size: clamp(13px, 2.3vw, 17px); font-weight: 600; color: var(--tm-ink); text-transform: none; letter-spacing: 0; margin-top: 2px; font-variant-numeric: tabular-nums; }
.trail-map .stat-val.green { color: var(--tm-green); }
.trail-map .stat-val.red { color: var(--tm-red-bright); }
.trail-map .stat-sub { display: block; font-size: 8px; color: var(--tm-ink-muted); margin-top: 1px; letter-spacing: 0.5px; font-variant-numeric: tabular-nums; }
.trail-map .cta-row { display: flex; gap: 10px; justify-content: center; flex-wrap: wrap; }
.trail-map .btn { font-family: var(--tm-font-serif); font-size: 12px; font-weight: 600; padding: 8px 22px; border-radius: 3px; border: 1px solid var(--tm-card-border); cursor: pointer; text-decoration: none; letter-spacing: 0.02em; transition: background 120ms; display: inline-block; }
.trail-map .btn-primary { background: var(--tm-ink); color: #fdf6e3; border-color: var(--tm-ink); }
.trail-map .btn-primary:hover { background: #2a1f12; }
.trail-map .btn-ghost { background: rgba(255,255,255,0.38); color: var(--tm-ink-muted); }
.trail-map .btn-ghost:hover { background: rgba(255,255,255,0.6); color: var(--tm-ink); }
.trail-map .btn-copied { background: var(--tm-green) !important; border-color: var(--tm-green) !important; color: #fdf6e3 !important; }
```

- [ ] **Step 2: Create `src/dashboard/static/trail-map.js`**

Write this file with the exact content below. This is the user-supplied script with two changes:
1. All DOM lookups are scoped to a `[data-trail-map]` root so multiple trail maps on a page (unlikely but safe) don't collide.
2. A small `data-copy` click handler is added so the onboarding CTA can copy the install command to the clipboard.

The `BG` array and `TRAIL` array are LIFTED VERBATIM from the user's HTML. Do not edit them.

```javascript
(function() {
  const root = document.querySelector('[data-trail-map]');
  if (!root) return;

  // ═══════════════════════════════════════════════════════════════════
  //  GEOGRAPHY: 78 × 22  (lifted from user-supplied HTML — do not edit)
  // ═══════════════════════════════════════════════════════════════════
  const BG = [
    "♣♣♣ ♣♣♣  ♣♣♣   ♣♣  ▲  ▲ ▲                        ▲  ▲ ▲  ▲▲   ▲▲▲  ▲ ▲▲",
    "♣♣♣♣♣♣♣ ♣♣♣♣  ♣♣♣  ▲▲  ▲▲         · · ·           ▲▲ ▲▲▲  ▲▲   ▲▲▲▲ ▲▲▲",
    " ♣♣♣♣♣♣ ♣♣♣♣  ♣♣   ▲▲▲  ▲         · · · ·          ▲▲▲ ▲▲   ▲    ▲▲▲▲ ▲▲",
    "  ♣♣♣♣♣  ♣♣♣  ♣♣    ▲▲            · · · ·                              ▲  ",
    "   ♣♣♣♣  ♣♣♣  ♣      ▲            · · · ·                                 ",
    "    ♣♣♣   ♣♣          ▲           · · · · ·         ≈ ≈ ≈ ≈               ",
    "     ♣♣   ♣            ·          · · · · ·        ≈ ≈ ≈ ≈ ≈ ≈            ",
    "      ♣               · ·        · · · · · ·      ≈ ≈ ≈   ≈ ≈ ≈ ≈",
    "                      · · ·     · · · · · · ·   ≈ ≈ ≈       ≈ ≈ ≈ ≈",
    "   ♣ ♣                · · · ·  · · · · · ·     ≈ ≈ ≈ ≈         ≈ ≈ ≈",
    "  ♣♣ ♣♣               · · · · · · · · ·       ≈ ≈ ≈ ≈ ≈          ≈ ≈ ≈",
    "   ♣♣ ♣                · · · · · · · ·       ≈ ≈ ≈ ≈ ≈ ≈            ≈",
    "    ♣♣                  · · · · · · ·       ≈ ≈ ≈ ≈ ≈ ≈ ≈",
    "     ♣                   · · · · · ·       ≈ ≈ ≈ ≈ ≈",
    "                          · · · · ·       ≈ ≈ ≈ ≈ ≈                       ",
    "  ∿ ∿ ∿ ∿                  · · · ·       ≈ ≈ ≈                  ~ ~ ~ ~   ",
    " ∿ ∿ ∿ ∿ ∿ ∿               · · ·                              ~ ~ ~ ~ ~ ~ ",
    "  ∿ ∿ ∿ ∿ ∿ ∿               · ·                              ~ ~ ~ ~ ~ ~  ",
    "   ∿ ∿ ∿ ∿ ∿                 ·             ▲ ▲             ~ ~ ~ ~ ~ ~    ",
    "    ∿ ∿ ∿ ∿                              ▲ ▲ ▲ ▲         ~ ~ ~ ~ ~ ~      ",
    "     ∿ ∿ ∿                             ▲ ▲ ▲ ▲ ▲ ▲     ~ ~ ~ ~ ~         ",
    "      ∿ ∿                            ▲ ▲ ▲ ▲ ▲ ▲ ▲ ▲ ~ ~ ~ ~             ",
  ];

  // ── TRAIL (lifted from user-supplied HTML — do not edit) ─────────────
  const TRAIL = [
    {type:'label', r:11, c:0, text:'project*'},
    {type:'path',  r:11, c:8, ch:'─'},
    {type:'path',  r:11, c:9, ch:'─'},
    {type:'coin',  r:11, c:10},
    {type:'cost',  r:10, c:8,  text:'$12'},
    {type:'path',  r:11, c:11, ch:'─'},
    {type:'path',  r:11, c:12, ch:'─'},
    {type:'path',  r:11, c:13, ch:'─'},
    {type:'branch',r:11, c:14, ch:'┬'},
    {type:'label', r:12, c:15, text:'feat/swiftbar'},
    {type:'path',  r:10, c:14, ch:'│'},
    {type:'path',  r:9,  c:14, ch:'│'},
    {type:'path',  r:8,  c:13, ch:'╱'},
    {type:'path',  r:7,  c:14, ch:'─'},
    {type:'coin',  r:7,  c:15},
    {type:'path',  r:6,  c:18, ch:'─'},
    {type:'coin',  r:6,  c:19},
    {type:'cost',  r:5,  c:17, text:'$47'},
    {type:'path',  r:5,  c:22, ch:'╲'},
    {type:'merge', r:4,  c:23, pr:'#1'},
    {type:'path',  r:11, c:14, ch:'─'},
    {type:'path',  r:11, c:15, ch:'─'},
    {type:'coin',  r:11, c:16},
    {type:'cost',  r:12, c:14, text:'$35'},
    {type:'path',  r:11, c:19, ch:'─'},
    {type:'path',  r:11, c:20, ch:'─'},
    {type:'branch',r:11, c:21, ch:'┼'},
    {type:'label', r:10, c:22, text:'feat/swiftbar-projects'},
    {type:'path',  r:12, c:21, ch:'│'},
    {type:'path',  r:13, c:21, ch:'╲'},
    {type:'path',  r:14, c:22, ch:'─'},
    {type:'coin',  r:14, c:23},
    {type:'path',  r:14, c:26, ch:'─'},
    {type:'coin',  r:14, c:27},
    {type:'cost',  r:13, c:25, text:'$32'},
    {type:'path',  r:15, c:28, ch:'╲'},
    {type:'path',  r:16, c:29, ch:'─'},
    {type:'coin',  r:16, c:30},
    {type:'cost',  r:15, c:29, text:'$18'},
    {type:'path',  r:16, c:33, ch:'─'},
    {type:'merge', r:17, c:34, pr:'#2,3'},
    {type:'path',  r:11, c:22, ch:'─'},
    {type:'path',  r:11, c:23, ch:'─'},
    {type:'coin',  r:11, c:24},
    {type:'path',  r:11, c:27, ch:'─'},
    {type:'path',  r:11, c:28, ch:'─'},
    {type:'coin',  r:11, c:29},
    {type:'path',  r:11, c:32, ch:'─'},
    {type:'path',  r:11, c:33, ch:'─'},
    {type:'branch',r:11, c:34, ch:'┬'},
    {type:'label', r:10, c:35, text:'fix/mainline-stale'},
    {type:'path',  r:10, c:34, ch:'│'},
    {type:'path',  r:9,  c:34, ch:'╱'},
    {type:'path',  r:8,  c:35, ch:'─'},
    {type:'coin',  r:8,  c:36},
    {type:'cost',  r:7,  c:35, text:'$24'},
    {type:'path',  r:7,  c:39, ch:'╲'},
    {type:'merge', r:6,  c:40, pr:'#4'},
    {type:'path',  r:11, c:35, ch:'─'},
    {type:'path',  r:11, c:36, ch:'─'},
    {type:'coin',  r:11, c:37},
    {type:'cost',  r:12, c:36, text:'$14'},
    {type:'path',  r:11, c:40, ch:'─'},
    {type:'path',  r:11, c:41, ch:'─'},
    {type:'coin',  r:11, c:42},
    {type:'path',  r:11, c:45, ch:'─'},
    {type:'path',  r:11, c:46, ch:'─'},
    {type:'branch',r:11, c:47, ch:'┼'},
    {type:'label', r:10, c:48, text:'feat/claude-integrations'},
    {type:'path',  r:12, c:47, ch:'│'},
    {type:'path',  r:13, c:47, ch:'╲'},
    {type:'path',  r:14, c:48, ch:'─'},
    {type:'coin',  r:14, c:49},
    {type:'path',  r:14, c:52, ch:'─'},
    {type:'coin',  r:14, c:53},
    {type:'cost',  r:13, c:51, text:'$83'},
    {type:'anom',  r:13, c:55, text:'!'},
    {type:'label', r:12, c:56, text:'hot_session'},
    {type:'path',  r:15, c:54, ch:'╲'},
    {type:'path',  r:16, c:55, ch:'─'},
    {type:'coin',  r:16, c:56},
    {type:'cost',  r:15, c:55, text:'$61'},
    {type:'path',  r:16, c:59, ch:'─'},
    {type:'merge', r:17, c:60, pr:'#6,7'},
    {type:'path',  r:11, c:48, ch:'─'},
    {type:'path',  r:11, c:49, ch:'─'},
    {type:'coin',  r:11, c:50},
    {type:'path',  r:11, c:53, ch:'─'},
    {type:'path',  r:11, c:54, ch:'─'},
    {type:'coin',  r:11, c:55},
    {type:'path',  r:11, c:58, ch:'─'},
    {type:'path',  r:11, c:59, ch:'─'},
    {type:'branch',r:11, c:60, ch:'┬'},
    {type:'label', r:12, c:61, text:'feat/anomalies-cmd'},
    {type:'path',  r:10, c:60, ch:'│'},
    {type:'path',  r:9,  c:60, ch:'╱'},
    {type:'path',  r:8,  c:61, ch:'─'},
    {type:'coin',  r:8,  c:62},
    {type:'path',  r:7,  c:65, ch:'╲'},
    {type:'path',  r:6,  c:66, ch:'─'},
    {type:'coin',  r:6,  c:67},
    {type:'cost',  r:5,  c:66, text:'$29'},
    {type:'path',  r:5,  c:70, ch:'─'},
    {type:'coin',  r:5,  c:71},
    {type:'cost',  r:4,  c:70, text:'$74'},
    {type:'anom',  r:4,  c:68, text:'!'},
    {type:'label', r:3,  c:67, text:'spike_day'},
    {type:'path',  r:4,  c:74, ch:'╲'},
    {type:'merge', r:3,  c:75, pr:'#9,11'},
    {type:'path',  r:11, c:61, ch:'─'},
    {type:'path',  r:11, c:62, ch:'─'},
    {type:'coin',  r:11, c:63},
    {type:'path',  r:11, c:66, ch:'─'},
    {type:'path',  r:11, c:67, ch:'─'},
    {type:'coin',  r:11, c:68},
    {type:'path',  r:11, c:71, ch:'─'},
    {type:'path',  r:11, c:72, ch:'─'},
    {type:'path',  r:11, c:73, ch:'─'},
    {type:'cost',  r:10, c:68, text:'total:$429'},
    {type:'trophy', r:9,  c:74, text:'⚑'},
    {type:'trophy', r:10, c:74, text:'|'},
    {type:'trophy', r:11, c:74, text:'|'},
    {type:'label',  r:12, c:73, text:'v1.0✓'},
  ];

  // ─── BUILD FRAME ──────────────────────────────────────────────────────
  function baseGrid() {
    return BG.map(l => l.padEnd(80, ' ').split(''));
  }
  function buildFrame(visible, flash) {
    const grid = baseGrid();
    let mergedCount = 0, anomCount = 0;
    for (let i = 0; i < visible && i < TRAIL.length; i++) {
      const s = TRAIL[i];
      const f = flash ? 'F' : 'N';
      if (s.type === 'coin') {
        if (s.c > 0)    grid[s.r][s.c-1] = `\x01CL${f}\x01`;
        grid[s.r][s.c]  = `\x01CM${f}\x01`;
        if (s.c+1 < 80) grid[s.r][s.c+1] = `\x01CR${f}\x01`;
      } else if (s.type === 'path') {
        grid[s.r][s.c] = `\x01PA${s.ch}\x01`;
      } else if (s.type === 'branch') {
        grid[s.r][s.c] = `\x01BR${s.ch}\x01`;
      } else if (s.type === 'label') {
        for (let ci = 0; ci < s.text.length && s.c+ci < 80; ci++)
          grid[s.r][s.c+ci] = `\x01LA${s.text[ci]}\x01`;
      } else if (s.type === 'cost') {
        for (let ci = 0; ci < s.text.length && s.c+ci < 80; ci++)
          grid[s.r][s.c+ci] = `\x01CO${s.text[ci]}\x01`;
      } else if (s.type === 'anom') {
        grid[s.r][s.c] = `\x01AN${s.text}\x01`;
        anomCount++;
      } else if (s.type === 'trophy') {
        const glyph = flash ? 'TF' : 'TN';
        for (let ci = 0; ci < s.text.length && s.c+ci < 80; ci++)
          grid[s.r][s.c+ci] = `\x01${glyph}${s.text[ci]}\x01`;
      } else if (s.type === 'merge') {
        grid[s.r][s.c] = `\x01ME${f}X\x01`;
        const pr = s.pr || '';
        for (let ci = 0; ci < pr.length && s.c+2+ci < 80; ci++)
          grid[s.r][s.c+2+ci] = `\x01LA${pr[ci]}\x01`;
        mergedCount++;
      }
    }
    const lines = grid.map(row => {
      let line = row.join('')
        .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      line = line.replace(/▲/g, '<span class="mtn">▲</span>');
      line = line.replace(/♣/g, '<span class="tree">♣</span>');
      line = line.replace(/≈/g, '<span class="water">≈</span>');
      line = line.replace(/·/g, '<span class="plain">·</span>');
      line = line.replace(/∿/g, '<span class="marsh">∿</span>');
      line = line.replace(/~/g, '<span class="sand">~</span>');
      line = line.replace(/\x01CL(.)\x01/g, (_, f) =>
        `<span class="${f==='F'?'spark-rim':'tok-rim'}">(</span>`);
      line = line.replace(/\x01CM(.)\x01/g, (_, f) =>
        `<span class="${f==='F'?'spark-face':'tok-face'}">⊙</span>`);
      line = line.replace(/\x01CR(.)\x01/g, (_, f) =>
        `<span class="${f==='F'?'spark-rim':'tok-rim'}">)</span>`);
      line = line.replace(/\x01PA(.)\x01/g, (_, ch) => `<span class="path">${ch}</span>`);
      line = line.replace(/\x01BR(.)\x01/g, (_, ch) => `<span class="branch">${ch}</span>`);
      line = line.replace(/\x01LA(.)\x01/g, (_, ch) => `<span class="tm-label">${ch}</span>`);
      line = line.replace(/\x01CO(.)\x01/g, (_, ch) => `<span class="cost-tag">${ch}</span>`);
      line = line.replace(/\x01AN(.)\x01/g, (_, ch) => `<span class="anom">${ch}</span>`);
      line = line.replace(/\x01TF(.)\x01/g, (_, ch) => `<span class="trophy-flash">${ch}</span>`);
      line = line.replace(/\x01TN(.)\x01/g, (_, ch) => `<span class="trophy">${ch}</span>`);
      line = line.replace(/\x01ME(.)(.)\x01/g, (_, f, ch) => {
        if (ch === ' ') return ' ';
        if (ch === 'X') return `<span class="merged" style="font-size:1.4em;line-height:1;vertical-align:middle">X</span>`;
        return `<span class="merged">${ch}</span>`;
      });
      return line;
    });
    return { html: lines.join('\n'), mergedCount, anomCount };
  }

  // ─── DOM hooks (scoped to root) ──────────────────────────────────────
  const el = root.querySelector('#ascii');
  const prsEl = root.querySelector('#prs');
  const anomEl = root.querySelector('#anom-count');
  const anomSubEl = root.querySelector('#anom-sub');
  const costTodayEl = root.querySelector('#cost-today');
  const costSubEl = root.querySelector('#cost-sub');
  const sessCountEl = root.querySelector('#sess-count');

  // ─── Clipboard CTA (onboarding only) ─────────────────────────────────
  root.querySelectorAll('[data-copy]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      const text = btn.getAttribute('data-copy') || '';
      try { await navigator.clipboard.writeText(text); } catch (_) { /* no-op */ }
      const original = btn.textContent;
      btn.classList.add('btn-copied');
      btn.textContent = 'Copied!';
      setTimeout(() => {
        btn.classList.remove('btn-copied');
        btn.textContent = original;
      }, 1200);
    });
  });

  // ─── ANIMATION ────────────────────────────────────────────────────────
  let step = 0, phase = 'reveal';
  const STEP_MS = 100, HOLD_MS = 2400, FLASH_MS = 220, RESET_MS = 1100;
  function tick() {
    let delay;
    if (phase === 'reveal') {
      const { html, mergedCount, anomCount } = buildFrame(step, false);
      el.innerHTML = html;
      prsEl.textContent = mergedCount;
      anomEl.textContent = anomCount || '—';
      anomSubEl.textContent = anomCount === 2 ? '1 hot_session · 1 spike_day' : anomCount === 1 ? '1 active' : 'none detected';
      step++;
      if (step > TRAIL.length) { phase = 'hold'; delay = HOLD_MS; }
      else delay = STEP_MS;
    } else if (phase === 'hold') {
      const { html, mergedCount, anomCount } = buildFrame(TRAIL.length, true);
      el.innerHTML = html; prsEl.textContent = mergedCount;
      anomEl.textContent = anomCount;
      phase = 'flash'; delay = FLASH_MS;
    } else if (phase === 'flash') {
      const { html, mergedCount } = buildFrame(TRAIL.length, false);
      el.innerHTML = html; prsEl.textContent = mergedCount;
      phase = 'flash2'; delay = FLASH_MS;
    } else if (phase === 'flash2') {
      const { html, mergedCount } = buildFrame(TRAIL.length, true);
      el.innerHTML = html; prsEl.textContent = mergedCount;
      phase = 'reset'; delay = FLASH_MS;
    } else {
      const { html } = buildFrame(0, false);
      el.innerHTML = html; prsEl.textContent = 0;
      anomEl.textContent = '—'; anomSubEl.textContent = 'active';
      step = 0; phase = 'reveal'; delay = RESET_MS;
    }
    setTimeout(tick, delay);
  }

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced) {
    const { html, mergedCount, anomCount } = buildFrame(TRAIL.length, false);
    el.innerHTML = html;
    prsEl.textContent = mergedCount;
    anomEl.textContent = anomCount;
  } else {
    tick();
  }

  // ─── STATS animation ──────────────────────────────────────────────────
  let costToday = 0, sessToday = 4;
  costTodayEl.textContent = '—';
  sessCountEl.textContent = sessToday;
  function tickStats() {
    costToday = Math.min(74.30, costToday + (Math.random() * 0.25 + 0.08));
    if (Math.random() < 0.012) sessToday++;
    costTodayEl.textContent = '$' + costToday.toFixed(2);
    costSubEl.textContent = 'of $429 total · all time';
    sessCountEl.textContent = sessToday;
  }
  if (!reduced) setTimeout(() => setInterval(tickStats, 700), 500);
})();
```

- [ ] **Step 3: Add the new statics to the whitelist in `src/dashboard/server.ts`**

Locate the `STATIC_ALLOW` set (currently around lines 95-102) and add the two new entries:

```ts
const STATIC_ALLOW = new Set([
  'dashboard.css',
  'dashboard.js',
  'uPlot.iife.min.js',
  'uPlot.min.css',
  'logo.png',
  'favicon.svg',
  'trail-map.css',
  'trail-map.js',
]);
```

- [ ] **Step 4: Verify the statics are served**

Start the dashboard (or restart if running):

```bash
# If a dashboard is already running on 4920, stop it first:
PID=$(lsof -ti :4920 | head -1); [ -n "$PID" ] && kill "$PID"; sleep 1
npm run tokentrail -- dashboard --port 4920 --no-open &
DASHBOARD_PID=$!
until curl -fsS -o /dev/null http://127.0.0.1:4920/; do sleep 0.5; done
```

Check both statics return 200 with non-empty bodies:

```bash
curl -fsS -o /dev/null -w "css=%{http_code} size=%{size_download}\n" http://127.0.0.1:4920/static/trail-map.css
curl -fsS -o /dev/null -w "js=%{http_code} size=%{size_download}\n" http://127.0.0.1:4920/static/trail-map.js
```

Expected: `css=200 size>1000` and `js=200 size>5000`.

Leave the dashboard running for the next task. (If you want to stop it: `kill $DASHBOARD_PID`.)

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/static/trail-map.css src/dashboard/static/trail-map.js src/dashboard/server.ts
git commit -m "feat(dashboard): trail-map CSS and JS as static assets"
```

---

## Task 2: Build `renderTrailMap` partial and wire `GET /welcome`

**Files:**
- Create: `src/dashboard/render/trail-map.ts`
- Modify: `src/dashboard/server.ts` (add the `GET /welcome` handler)

**Interfaces:**
- Consumes: `escapeHtml` from `./shell.js`; the two statics added in Task 1.
- Produces:
  - `export type TrailMapMode = 'onboarding' | 'welcome';`
  - `export function renderTrailMap(opts: { mode: TrailMapMode }): string;`
  Returns the parchment-frame `<div class="trail-map" data-trail-map>...</div>` body markup. Includes `<link rel="stylesheet" href="/static/trail-map.css">` and `<script src="/static/trail-map.js" defer></script>`.

- [ ] **Step 1: Create `src/dashboard/render/trail-map.ts`**

```ts
import { escapeHtml } from './shell.js';

export type TrailMapMode = 'onboarding' | 'welcome';

export function renderTrailMap(opts: { mode: TrailMapMode }): string {
  const cta = renderCta(opts.mode);
  return `
<link rel="stylesheet" href="/static/trail-map.css">
<div class="trail-map" data-trail-map>
  <div class="frame-outer">
    <div class="parchment">
      <div class="inner-border"></div>
      <div class="corners">
        <span class="corner-glyph tl">✦</span>
        <span class="corner-glyph tr">✦</span>
        <span class="corner-glyph bl">✦</span>
        <span class="corner-glyph br">✦</span>
      </div>
      <div class="map-header">
        <p class="map-eyebrow">Chart of Token Lands · branch: project</p>
        <h1 class="map-title">Tokentrail</h1>
        <p class="map-tagline">Every token a footstep — every branch a fork in the road</p>
      </div>
      <hr class="rule">
      <div class="map-wrap">
        <div class="scale">1 coin ≈ 1.2k tokens · $ = cumulative branch cost</div>
        <pre class="ascii-map" id="ascii" aria-hidden="true"></pre>
      </div>
      <div class="legend">
        <div class="leg"><span class="leg-g tok-rim">(</span><span class="leg-g tok-face">⊙</span><span class="leg-g tok-rim">)</span> Token step</div>
        <div class="leg"><span class="leg-g path" style="letter-spacing:-1px">────</span> Trail</div>
        <div class="leg"><span class="leg-g branch">─┬─</span> Branch</div>
        <div class="leg"><span class="leg-g merged">✕</span> Merged PR</div>
        <div class="leg"><span class="leg-g anom" style="animation:none;color:#cc3333">!</span> Anomaly</div>
        <div class="leg"><span class="leg-g trophy" style="font-family:serif">⚑</span> Feature complete</div>
        <div class="leg"><span class="leg-g tree">♣</span> Forest</div>
        <div class="leg"><span class="leg-g mtn">▲</span> Mtns</div>
        <div class="leg"><span class="leg-g water">≈</span> River</div>
      </div>
      <div class="stats">
        <div class="stat">Cost Today<span class="stat-val green" id="cost-today">—</span><span class="stat-sub" id="cost-sub">of this week</span></div>
        <div class="stat">Merged PRs<span class="stat-val" id="prs">0</span><span class="stat-sub">11 total · all time</span></div>
        <div class="stat">Anomalies<span class="stat-val red" id="anom-count">—</span><span class="stat-sub" id="anom-sub">active</span></div>
        <div class="stat">Sessions<span class="stat-val" id="sess-count">—</span><span class="stat-sub">today</span></div>
      </div>
      <hr class="rule">
      <div class="cta-row">${cta}</div>
    </div>
  </div>
</div>
<script src="/static/trail-map.js" defer></script>
  `;
}

function renderCta(mode: TrailMapMode): string {
  if (mode === 'welcome') {
    return `
      <a href="/" class="btn btn-primary">Open the dashboard →</a>
      <a href="https://github.com/loschenbd/tokentrail#readme" target="_blank" rel="noopener noreferrer" class="btn btn-ghost">Read the scrolls</a>
    `;
  }
  const cmd = 'npm run tokentrail -- run-all';
  return `
    <a href="#" class="btn btn-primary" data-copy="${escapeHtml(cmd)}">Run a session → (copy command)</a>
    <a href="https://github.com/loschenbd/tokentrail#readme" target="_blank" rel="noopener noreferrer" class="btn btn-ghost">Read the scrolls</a>
  `;
}
```

- [ ] **Step 2: Wire `GET /welcome` in `src/dashboard/server.ts`**

Add the import at the top of the file (after the existing render imports):

```ts
import { renderTrailMap } from './render/trail-map.js';
```

Add the route handler in `buildServer(opts)` — place it next to the existing `/today` route so related routes cluster:

```ts
app.get('/welcome', async (_req, reply) => {
  reply.type('text/html; charset=utf-8');
  return renderShell(
    { title: 'Welcome · Tokentrail', days: opts.defaultDays, showBack: true },
    renderTrailMap({ mode: 'welcome' })
  );
});
```

- [ ] **Step 3: Typecheck**

```bash
npx tsc --noEmit
```

Expected: no output (clean).

- [ ] **Step 4: Verify `/welcome` renders**

Restart the dashboard so the new TS is loaded (`tsx` watches the source but a fresh boot is more predictable):

```bash
PID=$(lsof -ti :4920 | head -1); [ -n "$PID" ] && kill "$PID"; sleep 1
npm run tokentrail -- dashboard --port 4920 --no-open &
until curl -fsS -o /dev/null http://127.0.0.1:4920/; do sleep 0.5; done
```

Smoke-test the response:

```bash
curl -s http://127.0.0.1:4920/welcome | grep -c '<div class="trail-map"'
curl -s http://127.0.0.1:4920/welcome | grep -c 'Open the dashboard'
curl -s http://127.0.0.1:4920/welcome | grep -c '/static/trail-map.js'
```

Expected: each `grep -c` returns `1`.

Optional: open `http://127.0.0.1:4920/welcome` in a browser and confirm the animation runs and the "Open the dashboard →" link routes to `/`.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/render/trail-map.ts src/dashboard/server.ts
git commit -m "feat(dashboard): renderTrailMap partial and /welcome route"
```

---

## Task 3: Replace the dashboard empty state with the trail map

**Files:**
- Modify: `src/dashboard/render/overview.ts` (`renderEmptyState()` function)

**Interfaces:**
- Consumes: `renderTrailMap` from Task 2.
- Produces: nothing new — the public `renderOverview` signature is unchanged.

- [ ] **Step 1: Update `renderEmptyState` in `src/dashboard/render/overview.ts`**

Add the import near the other render imports at the top of the file:

```ts
import { renderTrailMap } from './trail-map.js';
```

Replace the entire `renderEmptyState()` function. The trail map renders first; the existing troubleshooting copy moves into a collapsed `<details>` so users who actually need it can still find it:

```ts
function renderEmptyState(): string {
  const path = claudeProjectsDir();
  return `
${renderTrailMap({ mode: 'onboarding' })}
<div class="single-col">
<div class="card empty-state">
  <details>
    <summary class="label">Don't see your trail?</summary>
    <p>Tokentrail follows Claude Code's session logs out of
       <code>${escapeHtml(path)}</code>.</p>
    <p>If you've used Claude Code before and don't see anything here:</p>
    <ul>
      <li>Check that the path above contains <code>.jsonl</code> files</li>
      <li>Re-run <code>npm run tokentrail -- run-all --skip-sync --skip-enrich</code> to ingest</li>
      <li>If Claude Code is installed elsewhere, set <code>CLAUDE_CONFIG_DIR</code> in <code>.env</code></li>
    </ul>
    <p>If you haven't installed Claude Code yet,
       <a href="https://docs.anthropic.com/en/docs/agents/claude-code" target="_blank" rel="noopener">install it</a>,
       run a session, and refresh this page.</p>
  </details>
</div>
</div>
  `;
}
```

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit
```

Expected: clean.

- [ ] **Step 3: Force the empty state and verify**

The Overview only shows the empty state when `isEmpty(vm)` returns true. To verify without wiping data, use Fastify's `inject` with a temporarily-forced empty VM. Write a small one-shot script:

```bash
cat > /tmp/empty-state-smoke.mjs <<'EOF'
import { renderShell } from '/Users/benjaminloschen/Projects/tokentrail/src/dashboard/render/shell.ts';
import { renderOverview } from '/Users/benjaminloschen/Projects/tokentrail/src/dashboard/render/overview.ts';
const emptyVm = {
  windowDays: 30,
  totalUsd: 0, priorUsd: 0, deltaPct: 0,
  weekUsd: 0, weekSessions: 0,
  topFeatures: [], topProjects: [],
  dailySeries: [], anomalies: [], recentCommits: [],
};
const body = renderOverview(emptyVm);
const html = renderShell({ title: 'Tokentrail · Overview', activeTab: 'overview', days: 30 }, body);
console.log('has trail-map div=', html.includes('<div class="trail-map"'));
console.log('has details summary=', html.includes('Don&#39;t see your trail') || html.includes("Don't see your trail"));
console.log('has Run a session=', html.includes('Run a session'));
console.log('still uses single-col=', html.includes('single-col'));
EOF
npx tsx /tmp/empty-state-smoke.mjs
rm /tmp/empty-state-smoke.mjs
```

Expected: all four `console.log` lines print `true`.

- [ ] **Step 4: Commit**

```bash
git add src/dashboard/render/overview.ts
git commit -m "feat(dashboard): trail map replaces overview empty state"
```

---

## Task 4: Marketing site — `marketing/index.html` standalone

**Files:**
- Create: `marketing/index.html`
- Create: `marketing/static/logo.png` (copy from `docs/logo.png`)
- Create: `marketing/static/favicon.svg` (copy from `src/dashboard/static/favicon.svg`)
- Create: `marketing/README.md`

**Interfaces:**
- Consumes: nothing from the dashboard. Fully standalone.
- Produces: deployable static site at `marketing/`.

- [ ] **Step 1: Create the asset folder and copy assets**

```bash
mkdir -p marketing/static
cp docs/logo.png marketing/static/logo.png
cp src/dashboard/static/favicon.svg marketing/static/favicon.svg
```

- [ ] **Step 2: Create `marketing/index.html`**

This is the user-supplied HTML with three edits applied:
1. Asset paths repointed to `marketing/static/` (relative: `./static/logo.png`, `./static/favicon.svg`) and a `<link rel="icon">` for the favicon added.
2. The internal class `.label` is renamed to `.tm-label` (the source has it as `.label`).
3. The whole layout wrapped in `<div class="trail-map" data-trail-map>` so its CSS variables and any future external JS scope correctly (consistent with the dashboard copy).

Save the file with the content below. Note: the `BG` and `TRAIL` arrays must match Task 1's `trail-map.js` exactly. If you have any doubt, copy them from that file.

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Tokentrail — The Trail Map</title>
<link rel="icon" type="image/svg+xml" href="./static/favicon.svg">
<link rel="apple-touch-icon" href="./static/logo.png">
<style>
:root {
  --tm-ink:         #3d2f1f;
  --tm-ink-muted:   #6b563d;
  --tm-ink-subtle:  #8b6f47;
  --tm-parch-top:   #fdf6e3;
  --tm-parch-mid:   #f5e6c8;
  --tm-parch-bot:   #ede0bb;
  --tm-card-border: #c9b48d;
  --tm-green:       #5d7a3e;
  --tm-amber:       #8b6f47;
  --tm-coin:        #7a4f1a;
  --tm-coin-rim:    #c49a3a;
  --tm-red:         #8b2020;
  --tm-red-bright:  #cc3333;
  --tm-gold:        #b8860b;
  --tm-font-serif:  Georgia, "Times New Roman", serif;
  --tm-font-mono:   ui-monospace, "SF Mono", Menlo, monospace;
}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body {
  font-family: var(--tm-font-serif);
  color: var(--tm-ink);
  background: #b8a070;
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
}
.trail-map { display: contents; }
.frame-outer { background:#b8a070; padding:10px; border-radius:3px; box-shadow:0 20px 64px rgba(0,0,0,0.35), 0 4px 12px rgba(0,0,0,0.2); width:min(980px,100%); }
.parchment { position:relative; background: radial-gradient(ellipse at 8% 12%, rgba(210,175,100,0.25) 0%, transparent 45%), radial-gradient(ellipse at 92% 88%, rgba(160,120,50,0.22) 0%, transparent 45%), radial-gradient(ellipse at 50% 50%, var(--tm-parch-top) 0%, var(--tm-parch-mid) 55%, var(--tm-parch-bot) 100%); border:1px solid rgba(139,111,71,0.5); padding:32px 36px 28px; overflow:hidden; }
.parchment::before { content:""; position:absolute; inset:0; background-image:radial-gradient(circle at 1px 1px, rgba(61,47,31,0.05) 1px, transparent 0); background-size:10px 10px; pointer-events:none; z-index:0; }
.parchment::after { content:""; position:absolute; inset:0; background:radial-gradient(ellipse at 50% 50%, transparent 52%, rgba(100,70,30,0.2) 100%); pointer-events:none; z-index:0; }
.parchment > * { position:relative; z-index:1; }
.corners{position:absolute;inset:0;pointer-events:none;z-index:2;}
.corner-glyph{position:absolute;font-family:var(--tm-font-mono);font-size:18px;color:var(--tm-amber);opacity:0.55;line-height:1;}
.corner-glyph.tl{top:12px;left:14px} .corner-glyph.tr{top:12px;right:14px}
.corner-glyph.bl{bottom:12px;left:14px} .corner-glyph.br{bottom:12px;right:14px}
.inner-border{position:absolute;inset:20px;border:1px dashed rgba(139,111,71,0.22);border-radius:2px;pointer-events:none;z-index:1;}
.map-header{text-align:center;margin-bottom:16px;}
.map-eyebrow{font-size:9px;text-transform:uppercase;letter-spacing:3.5px;color:var(--tm-ink-muted);margin-bottom:5px;}
.map-title{font-size:clamp(24px,4.5vw,38px);font-weight:600;color:var(--tm-ink);letter-spacing:-0.02em;line-height:1;}
.map-tagline{font-style:italic;font-size:12px;color:var(--tm-ink-muted);margin-top:5px;}
.rule{border:none;border-top:1px dashed rgba(139,111,71,0.5);margin:12px 0;}
.map-wrap { position:relative; background:rgba(255,255,255,0.15); border:1px solid rgba(139,111,71,0.3); border-radius:2px; padding:14px 16px 18px; box-shadow:inset 0 2px 10px rgba(61,47,31,0.06); margin-bottom:14px; overflow:hidden; }
.scale{position:absolute;bottom:7px;left:14px;font-size:8px;text-transform:uppercase;letter-spacing:1.5px;color:var(--tm-ink-muted);opacity:0.6;user-select:none;}
.ascii-map { font-family:var(--tm-font-mono); font-size:clamp(0.55rem,1.05vw,0.67rem); line-height:1.44; white-space:pre; color:var(--tm-ink); letter-spacing:0.035em; user-select:none; display:block; }
.tree  { color: rgba(80,110,50,0.38); }
.mtn   { color: rgba(110,85,55,0.35); }
.water { color: rgba(60,90,110,0.38); }
.plain { color: rgba(100,80,55,0.28); }
.marsh { color: rgba(60,100,80,0.32); }
.sand  { color: rgba(160,130,70,0.32); }
.tok-rim  { color: var(--tm-coin-rim); font-weight:bold; }
.tok-face { color: var(--tm-coin); font-weight:bold; text-shadow:0 0 3px rgba(196,154,58,0.55); }
.path     { color: var(--tm-amber); }
.branch   { color:#4a7a35; font-weight:bold; }
.merged   { color: var(--tm-red); font-weight:bold; }
.tm-label { color: var(--tm-ink-muted); font-style:italic; }
.cost-tag { color:#6b4f2a; font-size:0.82em; }
.spark-rim  { color:#7db85a; font-weight:bold; }
.spark-face { color:#5d7a3e; font-weight:bold; text-shadow:0 0 5px rgba(93,122,62,0.9); }
.anom { color: var(--tm-red-bright); font-weight:bold; animation:anomPulse 1.8s ease-in-out infinite; }
@keyframes anomPulse { 0%,100% { opacity:1; text-shadow:0 0 4px rgba(204,51,51,0.5); } 50% { opacity:0.45; text-shadow:none; } }
.trophy { color: var(--tm-gold); font-weight:bold; }
.trophy-flash { color: var(--tm-gold); font-weight:bold; animation:trophyGlow 1.2s ease-in-out infinite; text-shadow:0 0 6px rgba(184,134,11,0.7); }
@keyframes trophyGlow { 0%,100% { opacity:1; text-shadow:0 0 8px rgba(184,134,11,0.9), 0 0 14px rgba(196,154,58,0.5); } 50% { opacity:0.75; text-shadow:0 0 3px rgba(184,134,11,0.4); } }
.legend{display:flex;gap:14px;flex-wrap:wrap;justify-content:center;font-size:10px;color:var(--tm-ink-muted);margin-bottom:14px;letter-spacing:0.02em;}
.leg{display:flex;align-items:center;gap:4px;}
.leg-g{font-family:var(--tm-font-mono);font-size:11px;min-width:14px;text-align:center;}
.stats{display:grid;grid-template-columns:repeat(4,1fr);border:1px dashed rgba(139,111,71,0.4);border-radius:3px;overflow:hidden;margin-bottom:16px;}
.stat{padding:8px 10px;border-right:1px dashed rgba(139,111,71,0.4);text-align:center;font-size:9px;text-transform:uppercase;letter-spacing:1.5px;color:var(--tm-ink-muted);}
.stat:last-child{border-right:none;}
.stat-val{display:block;font-size:clamp(13px,2.3vw,17px);font-weight:600;color:var(--tm-ink);text-transform:none;letter-spacing:0;margin-top:2px;font-variant-numeric:tabular-nums;}
.stat-val.green{color:var(--tm-green);}
.stat-val.red{color:var(--tm-red-bright);}
.stat-sub{display:block;font-size:8px;color:var(--tm-ink-muted);margin-top:1px;letter-spacing:0.5px;font-variant-numeric:tabular-nums;}
.cta-row{display:flex;gap:10px;justify-content:center;flex-wrap:wrap;}
.btn{font-family:var(--tm-font-serif);font-size:12px;font-weight:600;padding:8px 22px;border-radius:3px;border:1px solid var(--tm-card-border);cursor:pointer;text-decoration:none;letter-spacing:0.02em;transition:background 120ms;}
.btn-primary{background:var(--tm-ink);color:#fdf6e3;border-color:var(--tm-ink);}
.btn-primary:hover{background:#2a1f12;}
.btn-ghost{background:rgba(255,255,255,0.38);color:var(--tm-ink-muted);}
.btn-ghost:hover{background:rgba(255,255,255,0.6);color:var(--tm-ink);}
</style>
</head>
<body>
<div class="trail-map" data-trail-map>
<div class="frame-outer">
<div class="parchment">
  <div class="inner-border"></div>
  <div class="corners">
    <span class="corner-glyph tl">✦</span>
    <span class="corner-glyph tr">✦</span>
    <span class="corner-glyph bl">✦</span>
    <span class="corner-glyph br">✦</span>
  </div>
  <div class="map-header">
    <p class="map-eyebrow">Chart of Token Lands · branch: project</p>
    <h1 class="map-title">Tokentrail</h1>
    <p class="map-tagline">Every token a footstep — every branch a fork in the road</p>
  </div>
  <hr class="rule">
  <div class="map-wrap">
    <div class="scale">1 coin ≈ 1.2k tokens · $ = cumulative branch cost</div>
    <pre class="ascii-map" id="ascii" aria-hidden="true"></pre>
  </div>
  <div class="legend">
    <div class="leg"><span class="leg-g tok-rim">(</span><span class="leg-g tok-face">⊙</span><span class="leg-g tok-rim">)</span> Token step</div>
    <div class="leg"><span class="leg-g path" style="letter-spacing:-1px">────</span> Trail</div>
    <div class="leg"><span class="leg-g branch">─┬─</span> Branch</div>
    <div class="leg"><span class="leg-g merged">✕</span> Merged PR</div>
    <div class="leg"><span class="leg-g anom" style="animation:none;color:#cc3333">!</span> Anomaly</div>
    <div class="leg"><span class="leg-g trophy" style="font-family:serif">⚑</span> Feature complete</div>
    <div class="leg"><span class="leg-g tree">♣</span> Forest</div>
    <div class="leg"><span class="leg-g mtn">▲</span> Mtns</div>
    <div class="leg"><span class="leg-g water">≈</span> River</div>
  </div>
  <div class="stats">
    <div class="stat">Cost Today<span class="stat-val green" id="cost-today">—</span><span class="stat-sub" id="cost-sub">of this week</span></div>
    <div class="stat">Merged PRs<span class="stat-val" id="prs">0</span><span class="stat-sub">11 total · all time</span></div>
    <div class="stat">Anomalies<span class="stat-val red" id="anom-count">—</span><span class="stat-sub" id="anom-sub">active</span></div>
    <div class="stat">Sessions<span class="stat-val" id="sess-count">—</span><span class="stat-sub">today</span></div>
  </div>
  <hr class="rule">
  <div class="cta-row">
    <a href="https://github.com/loschenbd/tokentrail" target="_blank" rel="noopener noreferrer" class="btn btn-primary">Begin the trail →</a>
    <a href="https://github.com/loschenbd/tokentrail#readme" target="_blank" rel="noopener noreferrer" class="btn btn-ghost">Read the scrolls</a>
  </div>
</div>
</div>
</div>

<script>
// PASTE the full contents of src/dashboard/static/trail-map.js HERE
// (or, more reliably, copy the file contents directly from Task 1's Step 2)
</script>
</body>
</html>
```

The `<script>` block at the end must contain the same `BG`, `TRAIL`, `buildFrame`, `tick`, and `tickStats` logic as Task 1's `trail-map.js`. Copy the body of that file (the contents inside the outer IIFE, OR the whole IIFE — both work) into the script tag here.

- [ ] **Step 3: Create `marketing/README.md`**

```markdown
# Tokentrail marketing page

Single-file landing page for tokentrail. No build step.

## Deploy

Drop `marketing/` into Vercel, Netlify, GitHub Pages, or any static
host. `index.html` is self-contained — its only external requests are
to `./static/logo.png` and `./static/favicon.svg`.

## Editing the trail visual

The CSS and the `BG` / `TRAIL` JavaScript arrays in `index.html`
duplicate the live dashboard's `src/dashboard/static/trail-map.css`
and `src/dashboard/static/trail-map.js`. When you change one, change
the other. The trail data is locked illustrative content — edits
should be rare.
```

- [ ] **Step 4: Verify the marketing site renders standalone**

Open it directly in a browser:

```bash
open marketing/index.html
```

Confirm in the browser:
- The animation starts (or, if `prefers-reduced-motion` is on, the full trail renders once).
- The "Begin the trail →" button links to the GitHub repo.
- The favicon and any apple-touch-icon resolve (no broken-asset 404s in the dev tools network panel).

- [ ] **Step 5: Commit**

```bash
git add marketing/
git commit -m "feat(marketing): standalone trail-map landing page"
```

---

## Self-review notes

**Spec coverage:**
- Marketing site → Task 4
- /welcome route → Task 2
- Empty-state replacement → Task 3
- Shared CSS/JS as dashboard statics → Task 1
- Class rename `.label` → `.tm-label` → Task 1 (CSS), Task 1 (JS render), Task 4 (marketing inline)
- `prefers-reduced-motion` honored → Task 1's JS preserves it
- Clipboard CTA for onboarding → Task 1's JS + Task 2's `renderCta('onboarding')`
- `<details>` troubleshooting block kept → Task 3
- No new nav tab for /welcome → Task 2 omits `activeTab`

**Placeholder check:** Every code block has the exact content; no TBD/TODO.

**Type consistency:** `TrailMapMode = 'onboarding' | 'welcome'` is defined in Task 2 and consumed in Task 3 via `renderTrailMap({ mode: 'onboarding' })`. The dashboard server route in Task 2 uses `renderTrailMap({ mode: 'welcome' })`. Names match.

**Known intentional duplication:** Task 4's marketing HTML inlines the same `BG`/`TRAIL` data and styles as Task 1. The plan and the marketing README both flag this. Sync cost is one find-and-paste because the data is locked.
