# ASCII coin-trail mascot — design

## Purpose

Give Tokentrail an interactive ASCII rendering of its coin-trail logo, in
the spirit of getmoshi.app's cursor-tracking ASCII cat. The mascot
appears on the dashboard hero (web), as a `tokentrail mascot` CLI
command, and as a baked-in block of the project README. One source SVG
and one precomputed frames file feed all three destinations.

## Non-goals

- No new mascot character (no animals, no faces, no figures). The
  coin-trail logo IS the mascot; we are not extending the brand mark.
- No runtime SVG rasterization in the browser, no headless browser in
  the CLI. Frames are precomputed at build time.
- No mobile cursor tracking, no touch-position tracking, no tilt input.
  Idle drift only on `pointer: coarse`.
- No animation library, no canvas in the served page, no new npm
  dependency in the dashboard runtime path.
- No multi-theme / dark mode. Tokentrail has one mode (parchment), per
  brand guide.
- No swappable mascots, no user-configurable grid size, no per-user
  preference.

## Architecture

```
docs/logo.svg
      │
      ▼
src/mascot/coin-trail.svg.ts   (parameterized SVG-string generator)
      │
      ▼
src/mascot/variants.ts          (15 frames: 5 horizontal × 3 vertical)
      │
      ▼
src/mascot/rasterize.ts         (SVG → 2D char grid via @resvg/resvg-js)
      │
      ▼
src/mascot/build-frames.ts      (build script — writes frames.json)
      │
      ▼
src/mascot/frames.json          (committed build artifact)
      │
   ┌──┴──┬────────────────┬─────────────┐
   ▼     ▼                ▼             ▼
 server  dashboard.js   CLI cmd    bake-readme script
 inject  (cursor swap)  (stdout)   (replaces marker block)
```

**Single source of truth.** `docs/logo.svg` is the canonical vector. The
current `docs/logo.png` is JPEG and cannot be parameterized; this design
creates `docs/logo.svg` as the new canonical mark. The PNG stays for
backwards compatibility but the SVG is authoritative going forward.

**Precompute, don't rasterize at runtime.** Tokentrail is Node + vanilla
TS with a build step (`tsc`). Precomputing frames keeps:
- The browser zero-dependency (no canvas API used at runtime)
- The CLI Node-native (no headless browser, no SVG renderer at runtime)
- The README script pure file I/O

Rebuilding the mascot art requires `npm run build:mascot`, which is
documented in CONTRIBUTING-equivalent surface (added to README and to
`scripts/` discoverable list).

## Source SVG and variant generation

`src/mascot/coin-trail.svg.ts` exports:

```ts
type Bend = { dx: number; dy: number };   // -1..+1 in each axis
export function coinTrailSvg(bend: Bend): string;
```

The SVG depicts the existing logo composition:
- A pile of 6 coins lower-left (overlapping circles with darker rims)
- An arc of 5 coins ascending to upper-right
- Coin face: `#c9b48d` (light sepia). Coin rim: `#3d2f1f` (ink).
- Canvas: 360 × 160 SVG units. ViewBox matches.

The arc is a single quadratic Bézier `<path>` whose control point and
endpoint shift with `(dx, dy)`. Coins on the arc are positioned at
fractions `0.2, 0.4, 0.6, 0.8, 1.0` along the curve. Bend ranges:

```
horizontal: dx ∈ {-1.0, -0.5, 0, +0.5, +1.0}    (5 steps)
vertical:   dy ∈ {-1.0, 0, +1.0}                (3 steps)
```

Endpoint offset relative to the centered arc endpoint:
- `endpoint.x += dx * 40`
- `endpoint.y += dy * 24`

Control-point offset is half the endpoint offset, giving a softer bend.

`src/mascot/variants.ts` calls `coinTrailSvg(bend)` for the 15
combinations and returns `{ bend, svg }[]`.

## Rasterization

`src/mascot/rasterize.ts` exports:

```ts
type CharGrid = string[][];   // rows × cols of single chars
export function rasterizeSvgToChars(svg: string, opts: { cols: number; rows: number }): CharGrid;
```

Pipeline:
1. Load `@resvg/resvg-js` (Rust-backed, ~3 MB install, no headless browser).
2. Rasterize SVG to a raw RGBA pixmap at `cols * 6 px` wide × `rows * 12 px`
   tall (approximates monospace cell aspect — characters are roughly twice
   as tall as wide).
3. Walk pixels in `(rows × cols)` cells, average alpha + darkness in each
   cell, classify by threshold into 5 density buckets:

   | Bucket | Threshold (darkness) | Char |
   |---|---|---|
   | 0 | < 0.10 | `' '` (space) |
   | 1 | < 0.30 | `'·'` |
   | 2 | < 0.55 | `'¤'` |
   | 3 | < 0.80 | `'◐'` (mirror to `'◑'` for right half of arc) |
   | 4 | ≥ 0.80 | `'●'` |

4. Trim leading and trailing all-space rows (mirror Moshi's `oe()` trim).

**Target grid:** 36 cols × 16 rows. Tunable in `build-frames.ts`.

## Build artifact: `frames.json`

`src/mascot/build-frames.ts` is a build-time script (run via `tsx`):

```jsonc
{
  "cols": 36,
  "rows": 16,
  "centerIndex": 7,          // index into frames[] for bend (0, 0)
  "frames": [
    { "bend": { "dx": -1.0, "dy": -1.0 }, "grid": [["·"," ","◐", ...], ...] },
    ...
  ]
}
```

15 frames. Committed to git (regenerable but stable across builds). File
size budget: under 50 KB minified JSON (~15 cells × 36 × 16 = 8 640
chars before whitespace).

`package.json` gains:

```jsonc
"scripts": {
  "build:mascot": "tsx src/mascot/build-frames.ts",
  "build": "npm run build:mascot && tsc",
  "bake:readme": "tsx scripts/bake-readme-mascot.ts"
}
```

`@resvg/resvg-js` is added as a **dev**Dependency (it's only used by the
build script, not the runtime dashboard).

The existing `"build": "tsc"` script becomes `"build": "npm run build:mascot && tsc"` —
this replaces the current value, not appends to it.

## Destination 1 — Web (dashboard hero)

`src/dashboard/render/shell.ts` injects:

```html
<div class="mascot-wrap">
  <pre id="mascot" class="mascot" aria-hidden="true"></pre>
  <script type="application/json" id="mascot-frames">…frames.json contents…</script>
</div>
```

The JSON is read from disk at server startup and embedded in the HTML
response. The initial `<pre>` is empty; `dashboard.js` populates it on
DOMContentLoaded with `frames.centerIndex` so there's no flash of empty
content past the first paint.

`src/dashboard/static/dashboard.js` gains an IIFE block:

```js
(function () {
  const pre = document.getElementById('mascot');
  const dataNode = document.getElementById('mascot-frames');
  if (!pre || !dataNode) return;
  let bundle;
  try { bundle = JSON.parse(dataNode.textContent || ''); } catch { return; }
  if (!bundle?.frames?.length) return;

  function render(idx) {
    const f = bundle.frames[idx] ?? bundle.frames[bundle.centerIndex];
    pre.textContent = f.grid.map(row => row.join('')).join('\n');
  }
  render(bundle.centerIndex);

  if (matchMedia('(pointer: coarse)').matches) {
    // Touch device — idle drift only
    let t = 0;
    setInterval(() => { t += 0.03; render(driftIndex(t, bundle)); }, 80);
    return;
  }

  let lastIdx = bundle.centerIndex;
  let idleTimer = setTimeout(startDrift, 2000);
  let driftHandle = null;

  function indexFromCursor(e) {
    const rect = pre.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dx = Math.max(-1, Math.min(1, (e.clientX - cx) / 320));
    const dy = Math.max(-1, Math.min(1, (e.clientY - cy) / 240));
    const ix = Math.round((dx + 1) * 2);             // 0..4
    const iy = Math.round(dy + 1);                   // 0..2
    return iy * 5 + ix;
  }

  let lastMove = 0;
  window.addEventListener('mousemove', (e) => {
    const now = performance.now();
    if (now - lastMove < 30) return;
    lastMove = now;
    if (driftHandle) { clearInterval(driftHandle); driftHandle = null; }
    const idx = indexFromCursor(e);
    if (idx !== lastIdx) { lastIdx = idx; render(idx); }
    clearTimeout(idleTimer);
    idleTimer = setTimeout(startDrift, 2000);
  });

  function startDrift() {
    let t = 0;
    driftHandle = setInterval(() => { t += 0.03; render(driftIndex(t, bundle)); }, 80);
  }
  function driftIndex(t, b) {
    const ix = Math.sin(t) > 0 ? 3 : 1;
    const iy = Math.cos(t * 0.7) > 0 ? 0 : 2;
    return iy * 5 + ix;
  }
})();
```

`src/dashboard/static/dashboard.css` gains:

```css
.mascot-wrap { display: flex; justify-content: center; padding: 16px 0; }
.mascot {
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.15;
  color: var(--color-ink);
  letter-spacing: 0.02em;
  white-space: pre;
  user-select: none;
  margin: 0;
}
@keyframes coin-shimmer {
  0%, 100% { color: var(--color-ink); }
  50%      { color: var(--color-accent-green); }
}
.mascot { animation: coin-shimmer 5s ease-in-out infinite; animation-delay: 3s; }
```

Idle shimmer is implemented as a CSS animation on the whole `<pre>`, not
a per-char overlay — simpler, no JS state, and the visual effect of the
ink slowly catching the sage-olive accent reads correctly even on a
single-color block. Accent green stays "punctuation" per the brand
guide.

## Destination 2 — CLI command

`src/commands/mascot.ts` registers `tokentrail mascot` on the existing
commander instance:

```ts
import { Command } from 'commander';
import { readFileSync } from 'fs';
import { resolve } from 'path';

type Frame = { bend: { dx: number; dy: number }; grid: string[][] };
type Bundle = { cols: number; rows: number; centerIndex: number; frames: Frame[] };

export function registerMascotCommand(program: Command): void {
  program
    .command('mascot')
    .description('Print the Tokentrail ASCII coin trail.')
    .option('--no-color', 'Disable ANSI sepia color (also respects NO_COLOR env).')
    .option('--frame <index>', 'Force a specific frame (0–14).', (v) => parseInt(v, 10))
    .action((opts) => {
      const bundle = loadBundle();
      const idx = pickFrameIndex(opts.frame, bundle);
      const useColor = shouldColor(opts.color);
      process.stdout.write(renderFrame(bundle.frames[idx], useColor) + '\n');
    });
}
```

Frame picker, in priority order:
1. `--frame N` if provided and in `[0, frames.length)`
2. Time-of-day pick: `dx = 0`, `dy` from hour-of-day, then index = `(dy + 1) * 5 + 2`
3. Fall back to `centerIndex`

```ts
function pickFrameIndex(forced: number | undefined, b: Bundle): number {
  if (typeof forced === 'number' && forced >= 0 && forced < b.frames.length) return forced;
  const h = new Date().getHours();
  const dy = h < 12 ? -1 : h < 18 ? 0 : 1;     // morning rises, evening descends
  const idx = (dy + 1) * 5 + 2;                 // dx = 0 → ix = 2 (center column)
  return idx < b.frames.length ? idx : b.centerIndex;
}
```

Color rules:
- Default ON, except: `NO_COLOR` env var set, `--no-color` flag,
  `!process.stdout.isTTY`
- Active color: `\x1b[38;5;94m` (ink sepia) for chars in buckets 3–4,
  `\x1b[38;5;58m` (ink-muted) for buckets 1–2
- Reset after each character group

Bucket info is preserved by storing the *char* in `frames.json` (the
bucket is recoverable from the char since the mapping is 1:1).

## Destination 3 — README baking

`scripts/bake-readme-mascot.ts` reads `frames.json`, picks
`centerIndex`, renders it plain text (no ANSI), and replaces the marker
block in `README.md`:

````markdown
<!-- MASCOT START -->
```
        ·  ·  ¤
     ·  ¤  ¤
  ◐  ◐  ◐  ◐
●  ●  ●  ●
   ●  ●
```
<!-- MASCOT END -->
````

Idempotent. If markers missing, fail with a clear error and instructions
to add them. README runs `bake:readme` after `build:mascot` is re-run.
Not wired into CI for MVP; manual `npm run bake:readme` after any logo
change.

## Error handling

- `build-frames.ts` failures (canvas load fails, SVG malformed) crash
  the build loudly. Acceptable — this is a dev-time script.
- Dashboard server reads `frames.json` at startup. If missing or
  malformed, log a one-line warning and serve the hero without a
  mascot. The dashboard must not crash because the mascot is broken.
- CLI command with missing `frames.json` prints
  `mascot frames not built — run \`npm run build:mascot\`` to stderr
  and exits 0 (don't fail noisily for a decorative command).
- Bake-readme script with missing markers exits 1 with the instruction
  text.

## Testing

Per the project rule "manual verification after each phase," the
verification gates are command-driven, not a unit-test suite:

1. **Frames build**: `npm run build:mascot`, then `jq '.frames | length' src/mascot/frames.json` returns 15. `jq '.frames[7].grid | length' src/mascot/frames.json` returns 16. Visually skim `jq -r '.frames[7].grid[] | join("")' src/mascot/frames.json` and confirm it looks like the logo.
2. **CLI plain**: `NO_COLOR=1 npm run tokentrail -- mascot | cat -v` shows only known chars (`·`, `¤`, `◐`, `◑`, `●`, space, newline), no control codes.
3. **CLI color**: `npm run tokentrail -- mascot` in a real TTY shows sepia output. `npm run tokentrail -- mascot | cat` (piped, not a TTY) automatically falls back to no color.
4. **CLI frame override**: `tokentrail mascot --frame 0` and `--frame 14` render visibly different bends. `--frame 99` falls back to center without crashing.
5. **README bake**: `npm run bake:readme`, then `git diff README.md` shows changes only between `<!-- MASCOT START -->` and `<!-- MASCOT END -->`.
6. **Dashboard**: start `npm run tokentrail -- dashboard`, open `http://127.0.0.1:4920`, confirm the mascot appears in the hero card. Move cursor — arc bends. Leave still 5 s — shimmer to sage-olive and back.
7. **Touch device sim**: in Chrome DevTools device mode, confirm no mousemove listener fires and the idle drift loop runs.
8. **Missing frames graceful**: rename `frames.json` aside, start dashboard, confirm hero renders without crashing and a warning logs.

## Open implementation questions

- Whether to extract a `renderHero` helper into a shared component for
  reuse across `overview.ts` and a possible future `today.ts` mascot
  embedding. **Decision:** defer — `shell.ts` injection is fine for
  now; revisit if a second page wants the mascot.
- Whether to also expose `frames.json` as a runtime API
  (`GET /api/mascot`) for third-party embedding (e.g. a status badge).
  **Decision:** defer; see Out of scope.

## Out of scope (explicit future work, not now)

- A second mascot variant for the SwiftBar menubar (constrained char
  width — would need a 1-row "spark trail" frame). Defer.
- An `/api/mascot` JSON endpoint for third-party embeds. Defer.
- A `--watch` mode that hot-rebuilds frames on logo.svg change. Defer.
