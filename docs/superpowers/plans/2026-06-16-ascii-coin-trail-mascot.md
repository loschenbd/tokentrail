# ASCII Coin-Trail Mascot — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render Tokentrail's coin-trail logo as an interactive ASCII mascot — bending toward the cursor on the dashboard, printable from the CLI, and baked into the README — driven by a single precomputed `frames.json`.

**Architecture:** Pure-TS pipeline: a parameterized SVG generator produces 15 variants (5 horizontal × 3 vertical arc-bend) → `@resvg/resvg-js` rasterizes each to RGBA → a density-bucketing pass maps pixel cells to characters (` · ¤ ◐/◑ ●`) → a build script writes `src/mascot/frames.json`. Three thin consumers read that artifact: the server injects it into the dashboard HTML and `dashboard.js` swaps frames on mousemove; a `tokentrail mascot` CLI command prints a time-of-day frame; a `bake-readme` script replaces a marker block in `README.md`.

**Tech Stack:** TypeScript, Node 20+, `@resvg/resvg-js` (dev-only SVG rasterizer), commander (existing), node:test runner (existing), vanilla CSS animation on the dashboard.

## Global Constraints

- All char output uses ONLY these glyphs: space, `·`, `¤`, `◐`, `◑`, `●`. No other chars in `frames.json` grid cells.
- Frame grid is exactly `cols=36`, `rows=16` (pre-trim). After all-space row trim, rows may be ≤ 16.
- `centerIndex` is `7` (5-col grid × 3 rows, center is `iy=1, ix=2` → `1*5+2 = 7`).
- Bend ranges: `dx ∈ {-1.0, -0.5, 0, +0.5, +1.0}`, `dy ∈ {-1.0, 0, +1.0}`.
- Endpoint offset: `endpoint.x += dx * 40`, `endpoint.y += dy * 24`. Control-point offset is half of endpoint.
- Colors (web): `var(--color-ink)` for normal, `var(--color-accent-green)` for the shimmer peak. Accent green ONLY in the shimmer keyframe — used like punctuation per Tokentrail brand guide.
- Colors (CLI): `\x1b[38;5;94m` (ink sepia) for buckets 3–4, `\x1b[38;5;58m` (ink-muted) for buckets 1–2. Reset `\x1b[0m` after each color group.
- CLI color OFF when: `NO_COLOR` env var is set, `--no-color` flag passed, or `!process.stdout.isTTY`.
- `@resvg/resvg-js` is a **devDependency only**. The dashboard server, CLI runtime, and README script must NOT import it — they only read `frames.json`.
- `frames.json` is committed to git.
- All TypeScript imports use the `.js` extension (project uses ESM, see `package.json#type: "module"`).
- All test files use `node:test` + `node:assert/strict`, matching the existing test style.
- Server must NOT crash if `frames.json` is missing or malformed — log a warning, render without mascot.
- CLI must NOT exit non-zero if `frames.json` is missing — print helpful stderr message, exit 0.
- Tokentrail rule 7 ("Keep CLI language restrained"): CLI mascot help text is a single short sentence.

---

## File Structure

**New files:**
- `docs/logo.svg` — canonical vector source for the mark
- `src/mascot/coin-trail.svg.ts` — parameterized SVG-string generator
- `src/mascot/variants.ts` — 5×3 frame generator
- `src/mascot/rasterize.ts` — SVG → char grid via resvg
- `src/mascot/build-frames.ts` — build script (Node, runs once)
- `src/mascot/frames.json` — committed build artifact
- `src/mascot/load-frames.ts` — safe loader used by server + CLI
- `src/commands/mascot.ts` — CLI command implementation
- `scripts/bake-readme-mascot.ts` — README marker block replacer
- `tests/mascot/coin-trail.test.ts`
- `tests/mascot/variants.test.ts`
- `tests/mascot/rasterize.test.ts`
- `tests/mascot/load-frames.test.ts`
- `tests/mascot/mascot-command.test.ts`
- `tests/mascot/bake-readme.test.ts`

**Modified files:**
- `src/index.ts` — register `mascot` command (inline, matches existing pattern)
- `src/dashboard/render/shell.ts` — inject `<pre id="mascot">` + `<script id="mascot-frames">` into hero region; accept new optional `mascotJson` param
- `src/dashboard/server.ts` — load `frames.json` at startup, pass to `renderShell`
- `src/dashboard/static/dashboard.js` — append mascot cursor-tracking IIFE
- `src/dashboard/static/dashboard.css` — `.mascot-wrap`, `.mascot`, `@keyframes coin-shimmer`
- `package.json` — add `@resvg/resvg-js` devDependency; update `build` script; add `build:mascot` and `bake:readme` scripts
- `README.md` — add `<!-- MASCOT START --> <!-- MASCOT END -->` marker block

---

## Task 1: SVG generator + 15-frame variant set

**Files:**
- Create: `src/mascot/coin-trail.svg.ts`
- Create: `src/mascot/variants.ts`
- Create: `tests/mascot/coin-trail.test.ts`
- Create: `tests/mascot/variants.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `export type Bend = { dx: number; dy: number };`
  - `export function coinTrailSvg(bend: Bend): string;`
  - `export type Variant = { bend: Bend; svg: string };`
  - `export function variants(): Variant[];` (returns exactly 15 items, ordered `iy * 5 + ix`)
  - `export const BEND_DXS: readonly number[] = [-1.0, -0.5, 0, 0.5, 1.0];`
  - `export const BEND_DYS: readonly number[] = [-1.0, 0, 1.0];`
  - `export const CENTER_INDEX = 7;` (constant; do NOT compute at runtime in consumers)

- [ ] **Step 1.1: Write failing tests for `coinTrailSvg`**

Create `tests/mascot/coin-trail.test.ts`:

```ts
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { coinTrailSvg } from '../../src/mascot/coin-trail.js';

describe('coinTrailSvg', () => {
  test('returns SVG with the canonical viewBox 0 0 360 160', () => {
    const svg = coinTrailSvg({ dx: 0, dy: 0 });
    assert.match(svg, /^<svg /);
    assert.match(svg, /viewBox="0 0 360 160"/);
  });

  test('contains 6 pile coins at fixed positions', () => {
    const svg = coinTrailSvg({ dx: 0, dy: 0 });
    const pileMatches = svg.match(/<circle class="coin pile"/g) ?? [];
    assert.equal(pileMatches.length, 6, 'expected 6 pile coins');
  });

  test('contains 5 trail coins (along the arc)', () => {
    const svg = coinTrailSvg({ dx: 0, dy: 0 });
    const trailMatches = svg.match(/<circle class="coin trail"/g) ?? [];
    assert.equal(trailMatches.length, 5, 'expected 5 trail coins');
  });

  test('uses the brand palette colors only', () => {
    const svg = coinTrailSvg({ dx: 0, dy: 0 });
    assert.match(svg, /fill="#c9b48d"/);  // coin face = light sepia
    assert.match(svg, /stroke="#3d2f1f"/); // coin rim = ink
    assert.equal(svg.includes('#000'), false);
    assert.equal(svg.includes('#fff'), false);
  });

  test('bend dx=+1 shifts trail endpoint +40px in x vs centered', () => {
    const centered = coinTrailSvg({ dx: 0, dy: 0 });
    const right = coinTrailSvg({ dx: 1.0, dy: 0 });
    const cxCenter = extractLastTrailCx(centered);
    const cxRight = extractLastTrailCx(right);
    assert.equal(cxRight - cxCenter, 40);
  });

  test('bend dy=+1 shifts trail endpoint +24px in y vs centered', () => {
    const centered = coinTrailSvg({ dx: 0, dy: 0 });
    const down = coinTrailSvg({ dx: 0, dy: 1.0 });
    const cyCenter = extractLastTrailCy(centered);
    const cyDown = extractLastTrailCy(down);
    assert.equal(cyDown - cyCenter, 24);
  });
});

function extractLastTrailCx(svg: string): number {
  const matches = [...svg.matchAll(/<circle class="coin trail"[^>]*cx="([-\d.]+)"/g)];
  return Number(matches[matches.length - 1][1]);
}
function extractLastTrailCy(svg: string): number {
  const matches = [...svg.matchAll(/<circle class="coin trail"[^>]*cy="([-\d.]+)"/g)];
  return Number(matches[matches.length - 1][1]);
}
```

- [ ] **Step 1.2: Run tests — confirm they fail**

```bash
npm test -- --test-name-pattern="coinTrailSvg"
```

Expected: FAIL — `Cannot find module ../../src/mascot/coin-trail.js`.

- [ ] **Step 1.3: Implement `src/mascot/coin-trail.ts`**

```ts
export type Bend = { dx: number; dy: number };

const PILE_COINS: ReadonlyArray<{ cx: number; cy: number; r: number }> = [
  { cx:  60, cy: 110, r: 22 },
  { cx:  90, cy: 100, r: 22 },
  { cx:  75, cy: 130, r: 22 },
  { cx: 110, cy: 122, r: 22 },
  { cx:  45, cy: 130, r: 20 },
  { cx:  95, cy: 118, r: 18 },
];

const ARC_START = { x: 130, y: 100 };
const ARC_END_CENTERED = { x: 320, y: 30 };
const ARC_CTRL_CENTERED = { x: 220, y: 40 };
const TRAIL_FRACTIONS = [0.2, 0.4, 0.6, 0.8, 1.0] as const;
const TRAIL_RADII = [16, 15, 14, 13, 12] as const;

export function coinTrailSvg(bend: Bend): string {
  const endX = ARC_END_CENTERED.x + bend.dx * 40;
  const endY = ARC_END_CENTERED.y + bend.dy * 24;
  const ctrlX = ARC_CTRL_CENTERED.x + bend.dx * 20;
  const ctrlY = ARC_CTRL_CENTERED.y + bend.dy * 12;

  const trailCoins = TRAIL_FRACTIONS.map((t, i) => {
    const { x, y } = quadBezier(ARC_START, { x: ctrlX, y: ctrlY }, { x: endX, y: endY }, t);
    return `<circle class="coin trail" cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${TRAIL_RADII[i]}" fill="#c9b48d" stroke="#3d2f1f" stroke-width="2"/>`;
  }).join('');

  const pileCoins = PILE_COINS
    .map(c => `<circle class="coin pile" cx="${c.cx}" cy="${c.cy}" r="${c.r}" fill="#c9b48d" stroke="#3d2f1f" stroke-width="2.5"/>`)
    .join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 160" width="360" height="160">${pileCoins}${trailCoins}</svg>`;
}

function quadBezier(
  p0: { x: number; y: number },
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  t: number,
): { x: number; y: number } {
  const u = 1 - t;
  return {
    x: u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x,
    y: u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y,
  };
}
```

- [ ] **Step 1.4: Run tests — confirm they pass**

```bash
npm test -- --test-name-pattern="coinTrailSvg"
```

Expected: PASS all 6 tests.

- [ ] **Step 1.5: Write failing tests for `variants`**

Create `tests/mascot/variants.test.ts`:

```ts
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { variants, BEND_DXS, BEND_DYS, CENTER_INDEX } from '../../src/mascot/variants.js';

describe('variants', () => {
  test('returns exactly 15 entries', () => {
    assert.equal(variants().length, 15);
  });

  test('covers the full 5×3 bend grid with no duplicates', () => {
    const seen = new Set<string>();
    for (const v of variants()) {
      const key = `${v.bend.dx}|${v.bend.dy}`;
      assert.equal(seen.has(key), false, `duplicate bend ${key}`);
      seen.add(key);
    }
    assert.equal(seen.size, 15);
    for (const dx of BEND_DXS) for (const dy of BEND_DYS) {
      assert.equal(seen.has(`${dx}|${dy}`), true, `missing bend ${dx}|${dy}`);
    }
  });

  test('every entry has a non-empty svg', () => {
    for (const v of variants()) assert.match(v.svg, /^<svg/);
  });

  test('CENTER_INDEX points to bend (0, 0)', () => {
    const vs = variants();
    assert.equal(vs[CENTER_INDEX].bend.dx, 0);
    assert.equal(vs[CENTER_INDEX].bend.dy, 0);
  });

  test('order is iy * 5 + ix (rows first, then columns)', () => {
    const vs = variants();
    assert.deepEqual(vs[0].bend, { dx: -1.0, dy: -1.0 });
    assert.deepEqual(vs[4].bend, { dx:  1.0, dy: -1.0 });
    assert.deepEqual(vs[5].bend, { dx: -1.0, dy:  0   });
    assert.deepEqual(vs[14].bend, { dx: 1.0, dy:  1.0 });
  });
});
```

- [ ] **Step 1.6: Run variants tests — confirm they fail**

```bash
npm test -- --test-name-pattern="variants"
```

Expected: FAIL — module not found.

- [ ] **Step 1.7: Implement `src/mascot/variants.ts`**

```ts
import { coinTrailSvg, type Bend } from './coin-trail.js';

export const BEND_DXS = [-1.0, -0.5, 0, 0.5, 1.0] as const;
export const BEND_DYS = [-1.0, 0, 1.0] as const;
export const CENTER_INDEX = 7; // BEND_DYS index 1 × 5 + BEND_DXS index 2

export type Variant = { bend: Bend; svg: string };

export function variants(): Variant[] {
  const out: Variant[] = [];
  for (const dy of BEND_DYS) {
    for (const dx of BEND_DXS) {
      out.push({ bend: { dx, dy }, svg: coinTrailSvg({ dx, dy }) });
    }
  }
  return out;
}
```

- [ ] **Step 1.8: Run variants tests — confirm they pass**

```bash
npm test -- --test-name-pattern="variants"
```

Expected: PASS all 5 tests.

- [ ] **Step 1.9: Commit**

```bash
git add src/mascot/coin-trail.ts src/mascot/variants.ts tests/mascot/coin-trail.test.ts tests/mascot/variants.test.ts
git commit -m "feat(mascot): parameterized coin-trail SVG + 15-frame variant set"
```

---

## Task 2: SVG → char-grid rasterizer

**Files:**
- Create: `src/mascot/rasterize.ts`
- Create: `tests/mascot/rasterize.test.ts`
- Modify: `package.json` (add `@resvg/resvg-js` to `devDependencies`)

**Interfaces:**
- Consumes: nothing (SVG passed as string)
- Produces:
  - `export type CharGrid = string[][];`
  - `export function rasterizeSvgToChars(svg: string, opts: { cols: number; rows: number }): CharGrid;` — returns trimmed (leading + trailing all-space rows removed) grid with exactly `cols` columns per row.
  - `export const DENSITY_CHARS = { empty: ' ', sparse: '·', mid: '¤', faceLeft: '◐', faceRight: '◑', full: '●' } as const;`

- [ ] **Step 2.1: Install `@resvg/resvg-js` as devDependency**

```bash
npm install --save-dev @resvg/resvg-js
```

Verify it's in `package.json` devDependencies:

```bash
grep -q '"@resvg/resvg-js"' package.json && echo OK
```

- [ ] **Step 2.2: Write failing tests for `rasterizeSvgToChars`**

Create `tests/mascot/rasterize.test.ts`:

```ts
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { rasterizeSvgToChars, DENSITY_CHARS } from '../../src/mascot/rasterize.js';

const ALLOWED_CHARS = new Set([' ', '·', '¤', '◐', '◑', '●']);

function allBlackSvg(): string {
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 120" width="60" height="120"><rect x="0" y="0" width="60" height="120" fill="#000"/></svg>';
}
function emptySvg(): string {
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 120" width="60" height="120"></svg>';
}
function halfBlackSvg(): string {
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 120" width="60" height="120"><rect x="0" y="0" width="30" height="120" fill="#000"/></svg>';
}

describe('rasterizeSvgToChars', () => {
  test('all-black SVG → every cell is the full coin char ●', () => {
    const grid = rasterizeSvgToChars(allBlackSvg(), { cols: 10, rows: 4 });
    assert.equal(grid.length, 4);
    for (const row of grid) {
      assert.equal(row.length, 10);
      for (const ch of row) assert.equal(ch, DENSITY_CHARS.full);
    }
  });

  test('empty SVG → grid trimmed to zero rows (all rows were all-space)', () => {
    const grid = rasterizeSvgToChars(emptySvg(), { cols: 10, rows: 4 });
    assert.equal(grid.length, 0);
  });

  test('half-black SVG → left half cells are ●, right half cells are space', () => {
    const grid = rasterizeSvgToChars(halfBlackSvg(), { cols: 10, rows: 4 });
    assert.equal(grid.length, 4);
    for (const row of grid) {
      for (let i = 0; i < 5; i++) assert.equal(row[i], DENSITY_CHARS.full, `col ${i} should be full`);
      for (let i = 5; i < 10; i++) assert.equal(row[i], ' ', `col ${i} should be space`);
    }
  });

  test('output uses only the allowed character set', () => {
    const grid = rasterizeSvgToChars(halfBlackSvg(), { cols: 10, rows: 4 });
    for (const row of grid) for (const ch of row) {
      assert.equal(ALLOWED_CHARS.has(ch), true, `unexpected char "${ch}"`);
    }
  });
});
```

- [ ] **Step 2.3: Run tests — confirm they fail**

```bash
npm test -- --test-name-pattern="rasterizeSvgToChars"
```

Expected: FAIL — module not found.

- [ ] **Step 2.4: Implement `src/mascot/rasterize.ts`**

```ts
import { Resvg } from '@resvg/resvg-js';

export type CharGrid = string[][];

export const DENSITY_CHARS = {
  empty: ' ',
  sparse: '·',
  mid: '¤',
  faceLeft: '◐',
  faceRight: '◑',
  full: '●',
} as const;

const CELL_PX_W = 6;
const CELL_PX_H = 12;

export function rasterizeSvgToChars(svg: string, opts: { cols: number; rows: number }): CharGrid {
  const width = opts.cols * CELL_PX_W;
  const height = opts.rows * CELL_PX_H;
  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: width } });
  const png = resvg.render();
  const { pixels, width: w, height: h } = png;
  // pixels is RGBA Uint8Array of size w*h*4. Use the actual w/h from the
  // pixmap, then sample per cell.
  const cellW = w / opts.cols;
  const cellH = h / opts.rows;

  const grid: CharGrid = [];
  for (let r = 0; r < opts.rows; r++) {
    const row: string[] = [];
    for (let c = 0; c < opts.cols; c++) {
      const x0 = Math.floor(c * cellW);
      const y0 = Math.floor(r * cellH);
      const x1 = Math.floor((c + 1) * cellW);
      const y1 = Math.floor((r + 1) * cellH);
      const density = cellDensity(pixels, w, x0, y0, x1, y1);
      row.push(charFor(density, c, opts.cols));
    }
    grid.push(row);
  }
  return trim(grid);
}

function cellDensity(pixels: Uint8Array, stride: number, x0: number, y0: number, x1: number, y1: number): number {
  let sum = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * stride + x) * 4;
      const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2], a = pixels[i + 3];
      // darkness = 1 - luminance, weighted by alpha
      const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      const dark = (1 - lum) * (a / 255);
      sum += dark;
      n++;
    }
  }
  return n === 0 ? 0 : sum / n;
}

function charFor(d: number, col: number, totalCols: number): string {
  if (d < 0.10) return DENSITY_CHARS.empty;
  if (d < 0.30) return DENSITY_CHARS.sparse;
  if (d < 0.55) return DENSITY_CHARS.mid;
  if (d < 0.80) return col < totalCols / 2 ? DENSITY_CHARS.faceLeft : DENSITY_CHARS.faceRight;
  return DENSITY_CHARS.full;
}

function trim(grid: CharGrid): CharGrid {
  const isBlank = (row: string[]) => row.every(c => c === ' ');
  let top = 0;
  while (top < grid.length && isBlank(grid[top])) top++;
  let bottom = grid.length - 1;
  while (bottom >= top && isBlank(grid[bottom])) bottom--;
  return grid.slice(top, bottom + 1);
}
```

- [ ] **Step 2.5: Run tests — confirm they pass**

```bash
npm test -- --test-name-pattern="rasterizeSvgToChars"
```

Expected: PASS all 4 tests.

- [ ] **Step 2.6: Commit**

```bash
git add src/mascot/rasterize.ts tests/mascot/rasterize.test.ts package.json package-lock.json
git commit -m "feat(mascot): SVG-to-char-grid rasterizer via @resvg/resvg-js"
```

---

## Task 3: Build script + `frames.json` artifact + safe loader

**Files:**
- Create: `src/mascot/build-frames.ts` (Node script)
- Create: `src/mascot/load-frames.ts` (runtime-safe loader)
- Create: `src/mascot/frames.json` (build output, committed)
- Create: `tests/mascot/load-frames.test.ts`
- Modify: `package.json` (add `build:mascot` and update `build` scripts)

**Interfaces:**
- Consumes: `variants()` from Task 1, `rasterizeSvgToChars` from Task 2.
- Produces:
  - `frames.json` structure: `{ cols: 36, rows: 16, centerIndex: 7, frames: [{ bend, grid }] }`
  - `export type FrameBundle = { cols: number; rows: number; centerIndex: number; frames: Array<{ bend: { dx: number; dy: number }; grid: string[][] }> };`
  - `export function loadFrames(): FrameBundle | null;` — returns `null` (NOT throw) on any failure (missing, malformed, wrong shape). Always logs to stderr on failure.

- [ ] **Step 3.1: Write failing tests for `loadFrames`**

Create `tests/mascot/load-frames.test.ts`:

```ts
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadFramesFrom } from '../../src/mascot/load-frames.js';

describe('loadFramesFrom', () => {
  test('returns the parsed bundle for a valid file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mascot-'));
    const path = join(dir, 'frames.json');
    writeFileSync(path, JSON.stringify({
      cols: 36, rows: 16, centerIndex: 7,
      frames: [{ bend: { dx: 0, dy: 0 }, grid: [[' ']] }],
    }));
    const b = loadFramesFrom(path);
    assert.notEqual(b, null);
    assert.equal(b!.cols, 36);
    assert.equal(b!.frames.length, 1);
    rmSync(dir, { recursive: true, force: true });
  });

  test('returns null for a missing file (no throw)', () => {
    assert.equal(loadFramesFrom('/nonexistent/path/frames.json'), null);
  });

  test('returns null for malformed JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mascot-'));
    const path = join(dir, 'frames.json');
    writeFileSync(path, '{ not json');
    assert.equal(loadFramesFrom(path), null);
    rmSync(dir, { recursive: true, force: true });
  });

  test('returns null when shape is wrong (missing frames array)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mascot-'));
    const path = join(dir, 'frames.json');
    writeFileSync(path, JSON.stringify({ cols: 36, rows: 16, centerIndex: 7 }));
    assert.equal(loadFramesFrom(path), null);
    rmSync(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 3.2: Run tests — confirm they fail**

```bash
npm test -- --test-name-pattern="loadFramesFrom"
```

Expected: FAIL — module not found.

- [ ] **Step 3.3: Implement `src/mascot/load-frames.ts`**

```ts
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

export type Frame = { bend: { dx: number; dy: number }; grid: string[][] };
export type FrameBundle = { cols: number; rows: number; centerIndex: number; frames: Frame[] };

export function loadFrames(): FrameBundle | null {
  const here = dirname(fileURLToPath(import.meta.url));
  return loadFramesFrom(join(here, 'frames.json'));
}

export function loadFramesFrom(path: string): FrameBundle | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    process.stderr.write(`tokentrail mascot: frames.json not found at ${path}\n`);
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(`tokentrail mascot: frames.json is malformed JSON\n`);
    return null;
  }
  if (!isFrameBundle(parsed)) {
    process.stderr.write(`tokentrail mascot: frames.json has unexpected shape\n`);
    return null;
  }
  return parsed;
}

function isFrameBundle(x: unknown): x is FrameBundle {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.cols === 'number' &&
    typeof o.rows === 'number' &&
    typeof o.centerIndex === 'number' &&
    Array.isArray(o.frames)
  );
}
```

- [ ] **Step 3.4: Run tests — confirm they pass**

```bash
npm test -- --test-name-pattern="loadFramesFrom"
```

Expected: PASS all 4 tests.

- [ ] **Step 3.5: Implement `src/mascot/build-frames.ts`**

```ts
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { variants, CENTER_INDEX } from './variants.js';
import { rasterizeSvgToChars } from './rasterize.js';

const COLS = 36;
const ROWS = 16;

function main(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const outPath = join(here, 'frames.json');
  const frames = variants().map(v => ({
    bend: v.bend,
    grid: rasterizeSvgToChars(v.svg, { cols: COLS, rows: ROWS }),
  }));
  const bundle = { cols: COLS, rows: ROWS, centerIndex: CENTER_INDEX, frames };
  writeFileSync(outPath, JSON.stringify(bundle));
  // eslint-disable-next-line no-console
  console.log(`mascot: wrote ${frames.length} frames to ${outPath}`);
}

main();
```

- [ ] **Step 3.6: Update `package.json` scripts**

Edit `package.json`. Replace the existing `"build": "tsc"` with the chained version, and add `build:mascot`:

```jsonc
"scripts": {
  "dev": "tsx src/index.ts",
  "build:mascot": "tsx src/mascot/build-frames.ts",
  "build": "npm run build:mascot && tsc",
  "start": "node dist/index.js",
  "tokentrail": "tsx src/index.ts",
  "test": "node --import tsx --test $(find tests -name '*.test.ts')",
  "test:watch": "node --import tsx --test --watch $(find tests -name '*.test.ts')"
}
```

- [ ] **Step 3.7: Run the build script to produce `frames.json`**

```bash
npm run build:mascot
```

Expected stdout: `mascot: wrote 15 frames to .../src/mascot/frames.json`

Verify the artifact:

```bash
jq '.frames | length' src/mascot/frames.json     # → 15
jq '.cols, .rows, .centerIndex' src/mascot/frames.json   # → 36, 16, 7
jq -r '.frames[7].grid[] | join("")' src/mascot/frames.json
```

That last command should print a recognizable rendering of the coin pile + trail.

- [ ] **Step 3.8: Commit**

```bash
git add src/mascot/load-frames.ts src/mascot/build-frames.ts src/mascot/frames.json tests/mascot/load-frames.test.ts package.json
git commit -m "feat(mascot): build script, safe loader, and 15-frame artifact"
```

---

## Task 4: `tokentrail mascot` CLI command

**Files:**
- Create: `src/commands/mascot.ts`
- Create: `tests/mascot/mascot-command.test.ts`
- Modify: `src/index.ts` (add `mascot` command registration, inline with existing commands)

**Interfaces:**
- Consumes: `loadFrames()` and `FrameBundle` from Task 3.
- Produces:
  - `export type MascotOptions = { frame?: number; noColor?: boolean; now?: Date };`
  - `export function renderFrame(frame: Frame, useColor: boolean): string;` — returns the frame as a single string (rows joined with `\n`), with optional ANSI escape codes.
  - `export function pickFrameIndex(forced: number | undefined, bundle: FrameBundle, now: Date): number;`
  - `export function shouldColor(opts: { noColor?: boolean; env?: NodeJS.ProcessEnv; isTTY?: boolean }): boolean;`
  - `export async function runMascot(opts: MascotOptions): Promise<void>;` — the action body wired to the CLI.

- [ ] **Step 4.1: Write failing tests**

Create `tests/mascot/mascot-command.test.ts`:

```ts
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { renderFrame, pickFrameIndex, shouldColor } from '../../src/commands/mascot.js';
import type { FrameBundle, Frame } from '../../src/mascot/load-frames.js';

const bundle: FrameBundle = {
  cols: 3, rows: 2, centerIndex: 7,
  frames: Array.from({ length: 15 }, (_, i) => ({
    bend: { dx: 0, dy: 0 },
    grid: [['●', ' ', '·'], ['¤', '◐', '●']],
  })),
};

describe('renderFrame', () => {
  test('plain (no color) renders grid as plain text with newlines', () => {
    const out = renderFrame(bundle.frames[0], false);
    assert.equal(out, '● ·\n¤◐●');
    assert.equal(out.includes('\x1b['), false);
  });

  test('colored renders include ANSI escape sequences', () => {
    const out = renderFrame(bundle.frames[0], true);
    assert.equal(out.includes('\x1b[38;5;94m'), true);
    assert.equal(out.includes('\x1b[0m'), true);
  });
});

describe('pickFrameIndex', () => {
  test('forced index in range returns that index', () => {
    assert.equal(pickFrameIndex(5, bundle, new Date('2026-06-16T12:00:00Z')), 5);
  });
  test('forced index out of range falls back to centerIndex', () => {
    assert.equal(pickFrameIndex(99, bundle, new Date('2026-06-16T12:00:00Z')), bundle.centerIndex);
  });
  test('morning (hour 8) → dy=-1 → index 2 (center column of first row)', () => {
    assert.equal(pickFrameIndex(undefined, bundle, new Date('2026-06-16T08:00:00')), 2);
  });
  test('afternoon (hour 14) → dy=0 → index 7', () => {
    assert.equal(pickFrameIndex(undefined, bundle, new Date('2026-06-16T14:00:00')), 7);
  });
  test('evening (hour 20) → dy=+1 → index 12', () => {
    assert.equal(pickFrameIndex(undefined, bundle, new Date('2026-06-16T20:00:00')), 12);
  });
});

describe('shouldColor', () => {
  test('default on TTY with no flags → true', () => {
    assert.equal(shouldColor({ env: {}, isTTY: true }), true);
  });
  test('NO_COLOR env var → false', () => {
    assert.equal(shouldColor({ env: { NO_COLOR: '1' }, isTTY: true }), false);
  });
  test('--no-color flag → false', () => {
    assert.equal(shouldColor({ noColor: true, env: {}, isTTY: true }), false);
  });
  test('not a TTY → false', () => {
    assert.equal(shouldColor({ env: {}, isTTY: false }), false);
  });
});
```

(Note: the first `renderFrame` assertion contains a redundant double-assertion of the same value; that's intentional to make the literal string explicit for future readers.)

- [ ] **Step 4.2: Run tests — confirm they fail**

```bash
npm test -- --test-name-pattern="renderFrame|pickFrameIndex|shouldColor"
```

Expected: FAIL — module not found.

- [ ] **Step 4.3: Implement `src/commands/mascot.ts`**

```ts
import type { Frame, FrameBundle } from '../mascot/load-frames.js';
import { loadFrames } from '../mascot/load-frames.js';

const SEPIA_DARK = '\x1b[38;5;94m';
const SEPIA_MID  = '\x1b[38;5;58m';
const RESET      = '\x1b[0m';

const DARK_CHARS = new Set(['◐', '◑', '●']);
const MID_CHARS  = new Set(['·', '¤']);

export type MascotOptions = { frame?: number; noColor?: boolean };

export function renderFrame(frame: Frame, useColor: boolean): string {
  if (!useColor) {
    return frame.grid.map(row => row.join('')).join('\n');
  }
  return frame.grid.map(row => {
    let out = '';
    let currentColor: '' | typeof SEPIA_DARK | typeof SEPIA_MID = '';
    for (const ch of row) {
      const want: '' | typeof SEPIA_DARK | typeof SEPIA_MID =
        DARK_CHARS.has(ch) ? SEPIA_DARK :
        MID_CHARS.has(ch)  ? SEPIA_MID  : '';
      if (want !== currentColor) {
        if (currentColor) out += RESET;
        if (want) out += want;
        currentColor = want;
      }
      out += ch;
    }
    if (currentColor) out += RESET;
    return out;
  }).join('\n');
}

export function pickFrameIndex(forced: number | undefined, bundle: FrameBundle, now: Date): number {
  if (typeof forced === 'number' && forced >= 0 && forced < bundle.frames.length) return forced;
  const h = now.getHours();
  const dyIndex = h < 12 ? 0 : h < 18 ? 1 : 2;
  const idx = dyIndex * 5 + 2;
  return idx < bundle.frames.length ? idx : bundle.centerIndex;
}

export function shouldColor(opts: { noColor?: boolean; env?: NodeJS.ProcessEnv; isTTY?: boolean }): boolean {
  if (opts.noColor) return false;
  const env = opts.env ?? process.env;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  return opts.isTTY ?? true;
}

export async function runMascot(opts: MascotOptions): Promise<void> {
  const bundle = loadFrames();
  if (!bundle) {
    process.stderr.write('mascot frames not built — run `npm run build:mascot`\n');
    return;
  }
  const idx = pickFrameIndex(opts.frame, bundle, new Date());
  const useColor = shouldColor({ noColor: opts.noColor, env: process.env, isTTY: process.stdout.isTTY });
  process.stdout.write(renderFrame(bundle.frames[idx], useColor) + '\n');
}
```

- [ ] **Step 4.4: Run tests — confirm they pass**

```bash
npm test -- --test-name-pattern="renderFrame|pickFrameIndex|shouldColor"
```

Expected: PASS all 11 tests.

- [ ] **Step 4.5: Register the command in `src/index.ts`**

Add a new `program.command('mascot')` block, placed near the other utility commands (after `report`/`trail` is a natural spot). Append:

```ts
program
  .command('mascot')
  .description('Print the Tokentrail ASCII coin trail.')
  .option('--no-color', 'Disable ANSI sepia color (also respects NO_COLOR env).')
  .option('--frame <n>', 'Force a specific frame index (0–14).')
  .action(async (opts: { color?: boolean; frame?: string }) => {
    const { runMascot } = await import('./commands/mascot.js');
    await runMascot({
      noColor: opts.color === false,
      frame: opts.frame !== undefined ? Number.parseInt(opts.frame, 10) : undefined,
    });
  });
```

Note: commander's `--no-color` produces `opts.color === false` on the action object (negated boolean convention).

- [ ] **Step 4.6: Smoke-test the command end-to-end**

```bash
npm run tokentrail -- mascot --no-color
npm run tokentrail -- mascot --frame 0 --no-color
npm run tokentrail -- mascot --frame 14 --no-color
npm run tokentrail -- mascot --frame 99 --no-color   # should fall back, not crash
NO_COLOR=1 npm run tokentrail -- mascot
```

Expected: each command prints a recognizable ASCII coin trail to stdout. `--frame 0` and `--frame 14` should look visibly different. `--frame 99` should print the centered frame without erroring.

- [ ] **Step 4.7: Commit**

```bash
git add src/commands/mascot.ts src/index.ts tests/mascot/mascot-command.test.ts
git commit -m "feat(mascot): tokentrail mascot CLI command"
```

---

## Task 5: README bake script

**Files:**
- Create: `scripts/bake-readme-mascot.ts`
- Create: `tests/mascot/bake-readme.test.ts`
- Modify: `package.json` (add `bake:readme` script)
- Modify: `README.md` (add `<!-- MASCOT START --> ... <!-- MASCOT END -->` marker block)

**Interfaces:**
- Consumes: `loadFrames()` from Task 3.
- Produces:
  - `export function bakeMascot(readme: string, frameText: string): string;` — pure string function. Replaces content between the markers. Throws if either marker is missing.
  - Script body that reads `README.md`, calls `bakeMascot`, writes back.

- [ ] **Step 5.1: Write failing tests**

Create `tests/mascot/bake-readme.test.ts`:

```ts
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { bakeMascot } from '../../scripts/bake-readme-mascot.js';

const FRAME = '  ·  ·\n● ● ●';

describe('bakeMascot', () => {
  test('replaces content between markers and wraps it in a fenced code block', () => {
    const before = 'one\n<!-- MASCOT START -->\nOLD CONTENT\n<!-- MASCOT END -->\ntwo\n';
    const after = bakeMascot(before, FRAME);
    assert.match(after, /<!-- MASCOT START -->\n```\n {2}·  ·\n● ● ●\n```\n<!-- MASCOT END -->/);
    assert.equal(after.includes('OLD CONTENT'), false);
    assert.match(after, /^one\n/);
    assert.match(after, /two\n$/);
  });

  test('is idempotent', () => {
    const before = '<!-- MASCOT START -->\nplaceholder\n<!-- MASCOT END -->';
    const once = bakeMascot(before, FRAME);
    const twice = bakeMascot(once, FRAME);
    assert.equal(twice, once);
  });

  test('throws when START marker is missing', () => {
    assert.throws(() => bakeMascot('no markers here\n<!-- MASCOT END -->', FRAME), /MASCOT START/);
  });

  test('throws when END marker is missing', () => {
    assert.throws(() => bakeMascot('<!-- MASCOT START -->\nopen\n', FRAME), /MASCOT END/);
  });
});
```

- [ ] **Step 5.2: Run tests — confirm they fail**

```bash
npm test -- --test-name-pattern="bakeMascot"
```

Expected: FAIL — module not found.

- [ ] **Step 5.3: Implement `scripts/bake-readme-mascot.ts`**

```ts
import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { loadFrames } from '../src/mascot/load-frames.js';

const START = '<!-- MASCOT START -->';
const END = '<!-- MASCOT END -->';

export function bakeMascot(readme: string, frameText: string): string {
  const startIdx = readme.indexOf(START);
  if (startIdx < 0) throw new Error(`README is missing the ${START} marker`);
  const endIdx = readme.indexOf(END, startIdx);
  if (endIdx < 0) throw new Error(`README is missing the ${END} marker (after START)`);
  const before = readme.slice(0, startIdx);
  const after = readme.slice(endIdx + END.length);
  return `${before}${START}\n\`\`\`\n${frameText}\n\`\`\`\n${END}${after}`;
}

function main(): void {
  const bundle = loadFrames();
  if (!bundle) {
    process.stderr.write('mascot frames not built — run `npm run build:mascot` first\n');
    process.exit(1);
  }
  const path = resolve(process.cwd(), 'README.md');
  const before = readFileSync(path, 'utf8');
  const frame = bundle.frames[bundle.centerIndex];
  const frameText = frame.grid.map(row => row.join('')).join('\n');
  const after = bakeMascot(before, frameText);
  if (after === before) {
    console.log('README already up to date');
    return;
  }
  writeFileSync(path, after);
  console.log(`baked centered mascot frame into ${path}`);
}

// Run only when invoked directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
```

- [ ] **Step 5.4: Run tests — confirm they pass**

```bash
npm test -- --test-name-pattern="bakeMascot"
```

Expected: PASS all 4 tests.

- [ ] **Step 5.5: Add the marker block to `README.md`**

Find a natural spot in `README.md` (just after the centered logo image at the top is ideal) and insert:

```markdown
<!-- MASCOT START -->
<!-- MASCOT END -->
```

- [ ] **Step 5.6: Add `bake:readme` script to `package.json`**

Append to the `scripts` block:

```jsonc
"bake:readme": "tsx scripts/bake-readme-mascot.ts"
```

- [ ] **Step 5.7: Run the bake and verify**

```bash
npm run bake:readme
git diff README.md
```

Expected: the diff is contained between `<!-- MASCOT START -->` and `<!-- MASCOT END -->` only. The bake adds a fenced code block containing a recognizable coin-trail rendering.

- [ ] **Step 5.8: Commit**

```bash
git add scripts/bake-readme-mascot.ts tests/mascot/bake-readme.test.ts package.json README.md
git commit -m "feat(mascot): README bake script and marker block"
```

---

## Task 6: Dashboard hero integration (server inject + client JS + CSS)

**Files:**
- Modify: `src/dashboard/render/shell.ts` — accept optional `mascotJson` param; emit `<pre>` + `<script>` in hero region.
- Modify: `src/dashboard/server.ts` — call `loadFrames()` at startup; pass JSON to `renderShell`.
- Modify: `src/dashboard/static/dashboard.js` — append mascot IIFE block.
- Modify: `src/dashboard/static/dashboard.css` — `.mascot-wrap`, `.mascot`, `@keyframes coin-shimmer`.
- Modify: `tests/shell.test.ts` — add test for the new `mascotJson` param.

**Interfaces:**
- Consumes: `loadFrames()` and `FrameBundle` from Task 3.
- Produces:
  - `renderShell` signature gains an optional `mascotJson?: string` parameter. When provided, the hero region contains the mascot `<pre>` + JSON `<script>` block.
  - The dashboard server passes `JSON.stringify(bundle)` (or omits the param if `loadFrames()` returned `null`).

- [ ] **Step 6.1: Add failing test for the new `renderShell` behavior**

In `tests/shell.test.ts`, append:

```ts
describe('renderShell mascot', () => {
  test('when mascotJson omitted, no mascot pre/script appears', () => {
    const html = renderShell({ title: 'T', days: 7 }, '<div>body</div>');
    assert.equal(html.includes('id="mascot"'), false);
    assert.equal(html.includes('id="mascot-frames"'), false);
  });

  test('when mascotJson provided, both pre and script appear', () => {
    const html = renderShell({ title: 'T', days: 7, mascotJson: '{"frames":[]}' }, '<div>body</div>');
    assert.match(html, /<pre id="mascot"[^>]*><\/pre>/);
    assert.match(html, /<script type="application\/json" id="mascot-frames">\{"frames":\[\]\}<\/script>/);
  });

  test('mascotJson is HTML-escaped to prevent </script> breakout', () => {
    const evil = '"</script><script>alert(1)</script>';
    const html = renderShell({ title: 'T', days: 7, mascotJson: evil }, '');
    // The literal "</script>" must NOT appear inside the JSON block.
    // Verify by counting closing script tags: the JSON block's content
    // should be escaped so the only </script> tags are the legitimate
    // closers for the dashboard's own script tags.
    assert.equal(html.includes('"</script><script>alert(1)</script>"'), false);
  });
});
```

- [ ] **Step 6.2: Run tests — confirm they fail**

```bash
npm test -- --test-name-pattern="renderShell mascot"
```

Expected: FAIL — `mascotJson` param doesn't exist yet; HTML doesn't include the new elements.

- [ ] **Step 6.3: Extend `renderShell` in `src/dashboard/render/shell.ts`**

Read the existing file first to find the `renderShell` signature and the hero region. Add to the existing `Opts` type:

```ts
mascotJson?: string;
```

Inside the rendered HTML, just inside `<main>` or in a dedicated hero `<div>` near the top (above the existing main content placeholder), inject:

```ts
${opts.mascotJson ? `
  <div class="mascot-wrap">
    <pre id="mascot" class="mascot" aria-hidden="true"></pre>
    <script type="application/json" id="mascot-frames">${escapeJsonForScriptTag(opts.mascotJson)}</script>
  </div>
` : ''}
```

Add (next to `escapeHtml`):

```ts
// Escape a JSON string so it can be embedded inside a <script> tag without
// allowing a </script> sequence to break out of the script context.
export function escapeJsonForScriptTag(json: string): string {
  return json.replace(/<\/script/gi, '<\\/script');
}
```

- [ ] **Step 6.4: Run shell tests — confirm they pass**

```bash
npm test -- --test-name-pattern="renderShell"
```

Expected: PASS (new tests + all existing shell tests).

- [ ] **Step 6.5: Wire `loadFrames()` into `src/dashboard/server.ts`**

Read the existing `server.ts`. At module load time (or inside the request handler that calls `renderShell` — whichever matches the existing pattern), call:

```ts
import { loadFrames } from '../mascot/load-frames.js';
// ...
const mascotBundle = loadFrames();
const mascotJson = mascotBundle ? JSON.stringify(mascotBundle) : undefined;
```

Pass `mascotJson` to every `renderShell({...})` call.

- [ ] **Step 6.6: Append the mascot IIFE to `src/dashboard/static/dashboard.js`**

Add at the end of the file (do not modify the existing `renderTrend` IIFE):

```js
(function () {
  const pre = document.getElementById('mascot');
  const dataNode = document.getElementById('mascot-frames');
  if (!pre || !dataNode) return;
  let bundle;
  try { bundle = JSON.parse(dataNode.textContent || ''); } catch (e) { return; }
  if (!bundle || !Array.isArray(bundle.frames) || bundle.frames.length === 0) return;

  function render(idx) {
    const f = bundle.frames[idx] || bundle.frames[bundle.centerIndex];
    pre.textContent = f.grid.map(function (row) { return row.join(''); }).join('\n');
  }
  render(bundle.centerIndex);

  function driftIndex(t) {
    const ix = Math.sin(t) > 0 ? 3 : 1;
    const iy = Math.cos(t * 0.7) > 0 ? 0 : 2;
    return iy * 5 + ix;
  }

  if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) {
    let t = 0;
    setInterval(function () { t += 0.03; render(driftIndex(t)); }, 80);
    return;
  }

  let lastIdx = bundle.centerIndex;
  let idleTimer = setTimeout(startDrift, 2000);
  let driftHandle = null;
  let lastMove = 0;

  function indexFromCursor(e) {
    const rect = pre.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dx = Math.max(-1, Math.min(1, (e.clientX - cx) / 320));
    const dy = Math.max(-1, Math.min(1, (e.clientY - cy) / 240));
    const ix = Math.round((dx + 1) * 2);
    const iy = Math.round(dy + 1);
    return iy * 5 + ix;
  }

  function startDrift() {
    if (driftHandle) return;
    let t = 0;
    driftHandle = setInterval(function () { t += 0.03; render(driftIndex(t)); }, 80);
  }

  window.addEventListener('mousemove', function (e) {
    const now = performance.now();
    if (now - lastMove < 30) return;
    lastMove = now;
    if (driftHandle) { clearInterval(driftHandle); driftHandle = null; }
    const idx = indexFromCursor(e);
    if (idx !== lastIdx) { lastIdx = idx; render(idx); }
    clearTimeout(idleTimer);
    idleTimer = setTimeout(startDrift, 2000);
  });
})();
```

- [ ] **Step 6.7: Append mascot CSS to `src/dashboard/static/dashboard.css`**

Add at the end of the file:

```css
.mascot-wrap {
  display: flex;
  justify-content: center;
  padding: 16px 0;
}
.mascot {
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.15;
  color: var(--color-ink);
  letter-spacing: 0.02em;
  white-space: pre;
  user-select: none;
  margin: 0;
  animation: coin-shimmer 5s ease-in-out infinite;
  animation-delay: 3s;
}
@keyframes coin-shimmer {
  0%, 100% { color: var(--color-ink); }
  50%      { color: var(--color-accent-green); }
}
```

- [ ] **Step 6.8: Manual verification — dashboard**

```bash
npm run tokentrail -- dashboard
# In another shell, open http://127.0.0.1:4920
```

Confirm:
- The ASCII coin trail appears near the top of the dashboard hero region.
- Moving the mouse around the viewport changes which frame is shown (the arc bends toward the cursor).
- Leaving the mouse still for 2+ seconds starts an idle drift animation.
- After ~3 seconds idle, the whole mascot's ink color cycles through sage olive over 5 seconds and returns. (Open DevTools → Elements → Computed → `color` to confirm if the visual is subtle.)
- In Chrome DevTools device mode (touch device emulation), mousemove no longer changes frames; idle drift runs from the start.

- [ ] **Step 6.9: Manual verification — graceful failure on missing artifact**

```bash
mv src/mascot/frames.json src/mascot/frames.json.bak
npm run tokentrail -- dashboard &  # background
# Open dashboard; the page should render without crashing. No mascot pre tag.
# Then restore:
mv src/mascot/frames.json.bak src/mascot/frames.json
```

Expected: the dashboard page renders. The mascot region is empty (no `<pre>`). Server logs a stderr warning from `loadFrames`. No 500 errors.

- [ ] **Step 6.10: Commit**

```bash
git add src/dashboard/render/shell.ts src/dashboard/server.ts src/dashboard/static/dashboard.js src/dashboard/static/dashboard.css tests/shell.test.ts
git commit -m "feat(mascot): dashboard hero — cursor-tracking ASCII mascot"
```

---

## Task 7: Final wire-up + README polish + full test sweep

**Files:**
- Modify: `package.json` (sanity-check final script set is present and correct)
- Modify: `README.md` (Quickstart mention of the mascot command, near the existing `init` block)

**Interfaces:**
- Consumes: everything from Tasks 1–6.
- Produces: a green test suite, a bakeable README, and a documented CLI.

- [ ] **Step 7.1: Run the full test suite**

```bash
npm test
```

Expected: all tests pass (existing + the 6 new test files this plan added).

- [ ] **Step 7.2: Verify the full build chain works**

```bash
rm -rf dist src/mascot/frames.json
npm run build
ls -la dist/index.js src/mascot/frames.json
```

Expected: `src/mascot/frames.json` is regenerated (because `build:mascot` runs first), then `tsc` compiles to `dist/`. Both files exist after.

- [ ] **Step 7.3: Re-bake README (since frames.json was just rebuilt)**

```bash
npm run bake:readme
git diff README.md
```

Expected: README diff is fully contained between `<!-- MASCOT START -->` and `<!-- MASCOT END -->`. No other markdown changes.

- [ ] **Step 7.4: Add a CLI mention to the README**

Find the existing Quickstart section in `README.md`. Just below the `init` command block, add a single sentence + code line:

```markdown
Bonus: `npm run tokentrail -- mascot` prints the ASCII coin trail.
```

(One sentence. Tokentrail rule 7: restrained CLI language.)

- [ ] **Step 7.5: Final smoke pass**

Run every consumer once:

```bash
npm run tokentrail -- mascot                    # color (if TTY)
NO_COLOR=1 npm run tokentrail -- mascot         # plain
npm run tokentrail -- mascot --frame 0
npm run tokentrail -- mascot --frame 14
npm test
```

Expected: each prints visible output; the test suite is green.

- [ ] **Step 7.6: Final commit**

```bash
git add package.json README.md
git commit -m "docs(mascot): wire mascot mention into Quickstart + bake centered frame"
```

- [ ] **Step 7.7: Confirm the branch is ready**

```bash
git log --oneline master..HEAD
```

Expected: 7 commits on `mascot-ascii-trail` (one per task). All TDD: tests-first, implementation, commit.

---

## Self-review notes

- **Spec coverage:**
  - Concept (`Living coin-trail`): Tasks 1, 2, 3 (source SVG → variants → rasterize). ✓
  - Three destinations (web, CLI, README): Tasks 6, 4, 5 respectively. ✓
  - Char palette `· ¤ ◐/◑ ●`: Task 2 (rasterize) defines, all consumers honor. ✓
  - 36×16 grid, 15 frames, CENTER_INDEX=7: Tasks 1, 3 constants. ✓
  - Idle shimmer (CSS, accent green): Task 6 step 6.7. ✓
  - CLI time-of-day pick: Task 4 `pickFrameIndex`. ✓
  - CLI color rules (NO_COLOR, --no-color, !isTTY): Task 4 `shouldColor`. ✓
  - README markers + idempotent bake: Task 5. ✓
  - Server graceful failure on missing artifact: Task 3 (`loadFrames` returns `null`) + Task 6 (server passes `undefined` when null). Manually verified step 6.9. ✓
  - `@resvg/resvg-js` as devDependency only: Task 2 installs it, only `rasterize.ts` and `build-frames.ts` import it. ✓
- **Placeholder scan:** No `TBD`, no `TODO`, no "implement similar". Every step contains real code or real commands.
- **Type consistency:** `FrameBundle`, `Frame`, `Variant`, `Bend`, `CharGrid`, `MascotOptions` — all defined once and reused with matching names. `loadFrames` returns `FrameBundle | null` throughout. `CENTER_INDEX = 7` is the same constant everywhere. `BEND_DXS`/`BEND_DYS` array contents match the spec's bend ranges exactly.
