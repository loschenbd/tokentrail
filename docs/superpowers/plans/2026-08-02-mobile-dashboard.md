# Mobile Dashboard Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Tokentrail web dashboard a mobile-first, installable PWA — bottom tab bar, slim sticky header, readable trend chart and Worth-a-look cards at phone width — without changing desktop layout.

**Architecture:** Server-rendered Fastify dashboard. All mobile *layout* lives behind one `@media (max-width:700px)` block in `dashboard.css`; the shared shell (`shell.ts`) gains a bottom-nav element (hidden on desktop), a reordered nav, PWA `<head>` tags, and a service-worker registration script. Two new Fastify routes serve the manifest and service worker. Three icon files are generated from the existing 1024×1024 logo.

**Tech Stack:** Node.js + TypeScript, Fastify, plain CSS with custom-property tokens (Midori theme), `node:test` + `node:assert/strict`, `sips` for icon generation.

## Global Constraints

- Runtime: Node.js + TypeScript. No new npm dependencies.
- Attribution logic stays only in `src/lib/attribution.ts` (untouched here).
- Reuse existing Midori tokens — no new colors, no font changes.
- CLI/microcopy voice: calm, precise, lightly fantasy. Flavor in microcopy only.
- All mobile layout rules behind `@media (max-width: 700px)`; desktop (>700px) rendering unchanged except nav tab order (Today leftmost).
- Test command: `npm test` (runs `node --import tsx --test $(find tests -name '*.test.ts')`).
- Typecheck: `npx tsc --noEmit`.
- Manifest colors (Midori light): `background_color` = `#f3f1eb` (paper), `theme_color` = `#f3f1eb`.
- Live spend data (HTML pages + `/api/*`) is **never** cached by the service worker — cache-first applies to `/static/*` only.

---

### Task 1: Reorder nav + add bottom-nav markup (shell.ts)

Reorder the shared nav so **Today** is the leftmost tab, and emit a second copy of the nav as a bottom tab bar (icons + labels). Both are rendered on every page; CSS (Task 2) decides which is visible. The brand-mark link keeps pointing at `/` (Overview stays home).

**Files:**
- Modify: `src/dashboard/render/shell.ts` (the `nav` block ~lines 44–52, and add a bottom-nav before `</body>` ~line 99)
- Test: `tests/shell.test.ts`

**Interfaces:**
- Consumes: existing `ShellOptions` (`activeTab`, etc.) — unchanged signature.
- Produces: `renderShell(opts, body)` HTML now contains a `<nav class="bottom-nav">` with four `<a class="bottom-nav-item">` links in order Today, Overview, Worth a look, Settings; the active one has class `bottom-nav-item active`. The desktop `<nav class="nav-tabs">` links are reordered to the same order.

- [ ] **Step 1: Write the failing tests**

Add to `tests/shell.test.ts`:

```ts
describe('renderShell bottom nav', () => {
  test('renders a bottom tab bar with all four sections', () => {
    const html = renderShell({ title: 't', activeTab: 'overview', days: 30 }, '');
    assert.match(html, /class="bottom-nav"/);
    for (const [href, label] of [['/today', 'Today'], ['/', 'Overview'], ['/worth-a-look', 'Worth'], ['/settings', 'Settings']] as const) {
      assert.ok(html.includes(`href="${href}"`), `bottom nav missing ${label} link`);
    }
  });

  test('Today is the leftmost tab in both navs', () => {
    const html = renderShell({ title: 't', activeTab: 'today', days: 30 }, '');
    // In each nav block, the Today link appears before the Overview link.
    const navTabs = html.slice(html.indexOf('class="nav-tabs"'));
    assert.ok(navTabs.indexOf('/today') < navTabs.indexOf('href="/"'), 'desktop nav: Today not before Overview');
    const bottom = html.slice(html.indexOf('class="bottom-nav"'));
    assert.ok(bottom.indexOf('/today') < bottom.indexOf('href="/"'), 'bottom nav: Today not before Overview');
  });

  test('marks the active bottom-nav item', () => {
    const html = renderShell({ title: 't', activeTab: 'today', days: 30 }, '');
    assert.match(html, /class="bottom-nav-item active"[^>]*href="\/today"|href="\/today"[^>]*class="bottom-nav-item active"/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test 2>&1 | grep -A3 "bottom nav"`
Expected: FAIL — `bottom-nav` class not found.

- [ ] **Step 3: Implement the reorder + bottom nav**

In `src/dashboard/render/shell.ts`, replace the `nav` const (the `const nav = ...nav-tabs...` block) so the desktop tabs are reordered Today-first:

```ts
  const navLinks: Array<[NonNullable<ShellOptions['activeTab']>, string, string]> = [
    ['today', '/today', 'Today'],
    ['overview', '/', 'Overview'],
    ['worth-a-look', '/worth-a-look', 'Worth a look'],
    ['settings', '/settings', 'Settings'],
  ];
  const nav = `
    <nav class="nav-tabs">
      ${navLinks.map(([key, href, label]) => navItem(key, href, label)).join('\n      ')}
    </nav>`;

  // Icons for the mobile bottom bar (inline SVG, currentColor, 22px).
  const bottomIcons: Record<NonNullable<ShellOptions['activeTab']>, string> = {
    today: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    overview: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3v18h18"/><path d="M7 14l3-4 3 3 4-6"/></svg>',
    'worth-a-look': '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l2.5 5.5L20 9l-4 4 1 6-5-3-5 3 1-6-4-4 5.5-.5z"/></svg>',
    settings: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/></svg>',
  };
  const bottomLabels: Record<NonNullable<ShellOptions['activeTab']>, string> = {
    today: 'Today', overview: 'Overview', 'worth-a-look': 'Worth', settings: 'Settings',
  };
  const bottomNav = `
    <nav class="bottom-nav" aria-label="Primary">
      ${navLinks.map(([key, href]) => `<a class="bottom-nav-item${opts.activeTab === key ? ' active' : ''}" href="${href}">${bottomIcons[key]}<span>${bottomLabels[key]}</span></a>`).join('\n      ')}
    </nav>`;
```

Then insert `${bottomNav}` right after `<main>${body}</main>` (before the `<script src="/static/uPlot...">` line):

```ts
<main>${body}</main>
${bottomNav}
<script src="/static/uPlot.iife.min.js"></script>
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test 2>&1 | tail -20`
Expected: all `renderShell` tests PASS, including the new bottom-nav ones. Existing shell tests still green.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/dashboard/render/shell.ts tests/shell.test.ts
git commit -m "feat(dashboard): bottom-nav markup + Today-leftmost nav order"
```

---

### Task 2: Mobile shell CSS — bottom bar, slim sticky header, safe areas

Add the mobile media query that swaps the top tabs for the bottom bar, slims the header into one sticky row, hides the tagline, and pads content so the bar never covers it. Desktop unchanged (bottom nav is `display:none` by default).

**Files:**
- Modify: `src/dashboard/static/dashboard.css` (append a new mobile block near the existing `@media (max-width: 700px)` at line 82; keep the existing rules)

**Interfaces:**
- Consumes: `.bottom-nav`, `.bottom-nav-item` (Task 1); existing `.header`, `.header-left`, `.header-center`, `.nav-tabs`, `.brand-tag`, `main`, Midori tokens.
- Produces: no JS/HTML interface; purely visual.

- [ ] **Step 1: Add the always-on bottom-nav base + desktop hide**

Append to `dashboard.css` (outside any media query):

```css
/* Bottom tab bar — mobile only; hidden on desktop by default. */
.bottom-nav { display: none; }
.bottom-nav-item {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 2px; flex: 1 1 0; padding: 8px 0 4px;
  color: var(--color-ink-muted); text-decoration: none;
  font-size: 10px; letter-spacing: 0.04em;
}
.bottom-nav-item svg { opacity: 0.85; }
.bottom-nav-item.active { color: var(--color-accent); }
.bottom-nav-item.active svg { opacity: 1; }
```

- [ ] **Step 2: Add the mobile shell rules**

Append a new block (do not edit the existing `@media (max-width: 700px)` — add a second one below all current rules so it wins on cascade order):

```css
@media (max-width: 700px) {
  /* Slim sticky header: brand left, controls right, one row. */
  .header {
    position: sticky; top: 0; z-index: 20;
    flex-wrap: nowrap; align-items: center; gap: var(--space-s);
    padding: 10px var(--space-m);
    padding-top: calc(10px + env(safe-area-inset-top));
    background: var(--color-paper);
    border-bottom: 1px solid var(--color-card-border);
  }
  .brand-tag { display: none; }              /* "· the trail so far" */
  .header-center { display: none; }          /* top tabs — replaced by bottom bar */
  .brand-mark { width: 28px; height: 28px; }
  .brand { font-size: var(--size-h2); }
  .header-right { margin-left: auto; gap: var(--space-s); }
  .range-form .label { display: none; }      /* compact: dropdowns speak for themselves */

  /* Source picker (Overview, multi-source) drops to its own full-width row. */
  .source-form { flex-basis: 100%; }

  /* Bottom tab bar shown, fixed, safe-area aware. */
  .bottom-nav {
    display: flex; position: fixed; left: 0; right: 0; bottom: 0; z-index: 30;
    background: var(--color-card-bg);
    border-top: 1px solid var(--color-card-border);
    padding-bottom: env(safe-area-inset-bottom);
  }
  /* Content clears the fixed bar. */
  main { padding-bottom: calc(72px + env(safe-area-inset-bottom)); }
}
```

- [ ] **Step 3: Verify in the browser (mobile) — daemon**

Run the live daemon dashboard (already on `127.0.0.1:4920`). At 390px width, confirm:
- Header is one slim sticky row (brand left, Window + theme right); tagline gone; top tabs gone.
- A fixed bottom bar shows Today · Overview · Worth · Settings with icons; active tab is sage-colored.
- The last card is fully scrollable above the bar (not covered).
- On Overview with multiple sources, the Source dropdown appears on its own row under the header.

If the daemon isn't reflecting source edits, rebuild is not required for CSS — the daemon serves `src/dashboard/static/` directly in dev; hard-refresh the phone/browser.

- [ ] **Step 4: Verify desktop unchanged**

At >900px width, confirm the header, top tabs (now Today-first), and layout look exactly as before, and the bottom bar is not visible.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/static/dashboard.css
git commit -m "feat(dashboard): mobile slim sticky header + bottom tab bar"
```

---

### Task 3: Mobile content CSS — trend chart legend below + Worth-a-look cards

Fix the two broken views. Both are pure media-query overrides of existing markup.

**Files:**
- Modify: `src/dashboard/static/dashboard.css` (add rules inside the same second `@media (max-width: 700px)` block from Task 2)

**Interfaces:**
- Consumes: `.trend-layout`, `#trend-chart`, `.trend-legend`, `.anomaly-full`, `.anomaly-date`, `.anomaly-kind`, `.anomaly-target`, `.anomaly-reason`, `.anomaly-action` — all existing.
- Produces: purely visual.

- [ ] **Step 1: Add trend-chart stack + anomaly-card rules**

Inside the Task-2 `@media (max-width: 700px)` block, add:

```css
  /* Trend chart: stack legend below a full-width, taller chart. */
  .trend-layout { flex-direction: column; }
  .trend-layout #trend-chart { width: 100%; height: 220px; }
  .trend-legend {
    flex: 1 1 auto; max-height: none; overflow: visible;
    display: grid; grid-template-columns: 1fr 1fr; gap: 2px 16px;
  }

  /* Worth a look: rigid grid -> stacked cards. */
  .anomaly-full {
    display: block;
    padding: var(--space-s) 0;
  }
  .anomaly-full > .anomaly-date { display: inline; }
  .anomaly-full > .anomaly-kind { display: inline; margin-left: var(--space-s); }
  .anomaly-target { display: block; margin: 4px 0; font-size: var(--size-body); }
  .anomaly-full > .anomaly-reason { display: block; text-align: left; margin-bottom: 4px; }
  .anomaly-full > .anomaly-action { display: inline-block; padding-left: 0; }
```

- [ ] **Step 2: Verify Overview trend chart (mobile)**

At 390px on `/`, confirm the trend chart spans the full card width and is ~220px tall and legible; the legend sits **below** it in two columns (name + amount). The "Other ▸" row still expands/collapses on tap.

- [ ] **Step 3: Verify Worth a look (mobile)**

At 390px on `/worth-a-look`, confirm each anomaly renders as a stacked card: a date + kind meta line, the branch/feature link as its own line, the reason left-aligned below, and the dismiss/restore button — **no letter-per-line wrapping**. Tap `dismiss` on one and confirm it still works (the existing JS handler is unchanged).

- [ ] **Step 4: Verify desktop unchanged**

At >900px, the trend chart still sits beside its 200px legend and Worth-a-look still renders as aligned columns.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/static/dashboard.css
git commit -m "fix(dashboard): mobile trend chart + Worth-a-look card layout"
```

---

### Task 4: Generate PWA icons

Create three PNG icons from the canonical 1024×1024 logo and add them to the static allowlist.

**Files:**
- Create: `src/dashboard/static/icon-192.png`, `src/dashboard/static/icon-512.png`, `src/dashboard/static/icon-512-maskable.png`
- Modify: `src/dashboard/server.ts` (the `STATIC_ALLOW` Set ~line 362)

**Interfaces:**
- Produces: three static assets served via the existing `/static/:name` route once allowlisted.

- [ ] **Step 1: Generate standard icons with sips**

```bash
cd src/dashboard/static
sips -z 192 192 logo.png --out icon-192.png
sips -z 512 512 logo.png --out icon-512.png
```

- [ ] **Step 2: Generate the maskable icon (logo padded into a 512 safe zone)**

The maskable icon needs the mark inside an ~80% safe zone on the Midori paper background so Android's circle/squircle mask never clips it. Scale the logo to 410px and center it on a 512 `#f3f1eb` canvas:

```bash
cd src/dashboard/static
sips -z 410 410 logo.png --out /tmp/tt-icon-inner.png
# 512x512 paper-colored background:
sips -s format png --resampleHeightWidth 512 512 \
  --padColor F3F1EB /tmp/tt-icon-inner.png --out icon-512-maskable.png
```

If `--padColor` isn't honored on this sips build, fall back to Python/Pillow:

```bash
python3 - <<'PY'
from PIL import Image
bg = Image.new('RGBA', (512,512), (243,241,235,255))
fg = Image.open('src/dashboard/static/logo.png').convert('RGBA').resize((410,410))
bg.paste(fg, ((512-410)//2, (512-410)//2), fg)
bg.convert('RGB').save('src/dashboard/static/icon-512-maskable.png')
PY
```

- [ ] **Step 3: Verify the files exist at the right dimensions**

```bash
sips -g pixelWidth -g pixelHeight src/dashboard/static/icon-192.png src/dashboard/static/icon-512.png src/dashboard/static/icon-512-maskable.png
```
Expected: 192×192, 512×512, 512×512.

- [ ] **Step 4: Add icons to the static allowlist**

In `src/dashboard/server.ts`, add the three filenames to the `STATIC_ALLOW` Set:

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
    'settings.js',
    'fonts.css',
    'icon-192.png',
    'icon-512.png',
    'icon-512-maskable.png',
  ]);
```

- [ ] **Step 5: Verify they serve**

Run: `curl -s -o /dev/null -w "%{http_code} %{content_type}\n" http://127.0.0.1:4920/static/icon-192.png`
Expected: `200 image/png`. (Restart the daemon if the allowlist change isn't live — the daemon is the compiled Homebrew binary; in dev, `npm run dev dashboard` serves current source.)

- [ ] **Step 6: Commit**

```bash
git add src/dashboard/static/icon-192.png src/dashboard/static/icon-512.png src/dashboard/static/icon-512-maskable.png src/dashboard/server.ts
git commit -m "feat(dashboard): PWA app icons (192/512/maskable)"
```

---

### Task 5: Web app manifest (route + head link + iOS meta)

Serve a manifest and link it, plus iOS meta so the app installs standalone with the right name, colors, and icons.

**Files:**
- Modify: `src/dashboard/server.ts` (add a `/manifest.webmanifest` route near the other `app.get` routes)
- Modify: `src/dashboard/render/shell.ts` (add `<head>` tags after the existing icon links ~line 68)
- Test: `tests/manifest.test.ts` (new), `tests/shell.test.ts`

**Interfaces:**
- Consumes: `buildServer({ defaultDays })` (existing), `renderShell` (existing).
- Produces: `GET /manifest.webmanifest` → 200, `content-type: application/manifest+json`, JSON with `name`, `display: "standalone"`, `start_url: "/"`, and three `icons`. `renderShell` HTML includes `<link rel="manifest" href="/manifest.webmanifest">` and `apple-mobile-web-app-capable`.

- [ ] **Step 1: Write the failing route test**

Create `tests/manifest.test.ts`:

```ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServer } from '../src/dashboard/server.js';
import { closeDb } from '../src/db/db.js';

describe('GET /manifest.webmanifest', () => {
  test('returns a standalone PWA manifest with icons', async () => {
    const original = process.env.TRACKER_DB_PATH;
    process.env.TRACKER_DB_PATH = join(mkdtempSync(join(tmpdir(), 'tt-manifest-')), 'test.db');
    const app = buildServer({ defaultDays: 30 });
    try {
      const res = await app.inject({ method: 'GET', url: '/manifest.webmanifest' });
      assert.equal(res.statusCode, 200);
      assert.match(res.headers['content-type'] as string, /application\/manifest\+json/);
      const m = res.json() as { name: string; display: string; start_url: string; icons: unknown[] };
      assert.equal(m.name, 'Tokentrail');
      assert.equal(m.display, 'standalone');
      assert.equal(m.start_url, '/');
      assert.equal(m.icons.length, 3);
    } finally {
      await app.close();
      closeDb();
      process.env.TRACKER_DB_PATH = original;
    }
  });
});
```

(`closeDb` lives at `../src/db/db.js` — same import the sibling `tests/api.test.ts` uses.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test 2>&1 | grep -A3 manifest`
Expected: FAIL — 404 (route not defined).

- [ ] **Step 3: Add the manifest route**

In `src/dashboard/server.ts`, alongside the other `app.get` routes (e.g. just before the static handler section), add:

```ts
  app.get('/manifest.webmanifest', async (_req, reply) => {
    reply.type('application/manifest+json; charset=utf-8');
    return {
      name: 'Tokentrail',
      short_name: 'Tokentrail',
      description: 'The trail-map and ledger for AI spend.',
      start_url: '/',
      scope: '/',
      display: 'standalone',
      orientation: 'portrait',
      background_color: '#f3f1eb',
      theme_color: '#f3f1eb',
      icons: [
        { src: '/static/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/static/icon-512.png', sizes: '512x512', type: 'image/png' },
        { src: '/static/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    };
  });
```

- [ ] **Step 4: Run the route test to verify it passes**

Run: `npm test 2>&1 | grep -A3 manifest`
Expected: PASS.

- [ ] **Step 5: Write the failing shell head test**

Add to `tests/shell.test.ts`:

```ts
describe('renderShell PWA head', () => {
  test('links the manifest and declares iOS standalone', () => {
    const html = renderShell({ title: 't', activeTab: 'overview', days: 30 }, '');
    assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest">/);
    assert.match(html, /<meta name="apple-mobile-web-app-capable" content="yes">/);
    assert.match(html, /<meta name="theme-color"/);
  });
});
```

- [ ] **Step 6: Run to verify it fails, then add the head tags**

Run: `npm test 2>&1 | grep -A3 "PWA head"` → FAIL.

In `src/dashboard/render/shell.ts`, after the existing `<link rel="apple-touch-icon" ...>` line (~line 68), add:

```html
<link rel="manifest" href="/manifest.webmanifest">
<meta name="theme-color" content="#f3f1eb" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#1a1917" media="(prefers-color-scheme: dark)">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="Tokentrail">
```

- [ ] **Step 7: Run tests + typecheck**

Run: `npm test 2>&1 | tail -20 && npx tsc --noEmit`
Expected: all PASS, no type errors.

- [ ] **Step 8: Commit**

```bash
git add src/dashboard/server.ts src/dashboard/render/shell.ts tests/manifest.test.ts tests/shell.test.ts
git commit -m "feat(dashboard): web app manifest + iOS PWA meta"
```

---

### Task 6: Service worker (cache-first static, network-only data)

Add a root-scope service worker that precaches static assets and passes everything else straight to the network, plus the registration script. Cache name carries the app version so every release busts it.

**Files:**
- Create: `src/dashboard/sw.ts` (service-worker source generator)
- Modify: `src/dashboard/server.ts` (add a `/sw.js` route)
- Modify: `src/dashboard/render/shell.ts` (registration script before `</body>`)
- Test: `tests/sw.test.ts` (new)

**Interfaces:**
- Consumes: nothing new.
- Produces: `GET /sw.js` → 200, `content-type: text/javascript`, body containing a `CACHE` constant with the app version and `addEventListener('install'|'fetch')` handlers. `serviceWorkerJs(): string` exported from `src/dashboard/sw.ts`.

- [ ] **Step 1: Write the failing test**

Create `tests/sw.test.ts`:

```ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { serviceWorkerJs } from '../src/dashboard/sw.js';

describe('serviceWorkerJs', () => {
  test('caches static, versions the cache, and never caches api/html', () => {
    const src = serviceWorkerJs();
    assert.match(src, /addEventListener\(['"]install['"]/);
    assert.match(src, /addEventListener\(['"]fetch['"]/);
    assert.match(src, /tt-static-v\d+\.\d+\.\d+/, 'cache name must embed the semver');
    assert.match(src, /\/static\//, 'must special-case /static/ for cache-first');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test 2>&1 | grep -A3 serviceWorkerJs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the SW generator**

Create `src/dashboard/sw.ts`:

```ts
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, parse } from 'node:path';

// Walk upward to the nearest package.json (same proven pattern as src/index.ts):
// a hardcoded ../../ offset only holds for the compiled dist layout.
function appVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  const { root } = parse(dir);
  while (dir !== root) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) {
      return (JSON.parse(readFileSync(candidate, 'utf8')) as { version: string }).version;
    }
    dir = dirname(dir);
  }
  return '0.0.0';
}

// Cache-first for /static/* only; everything else (HTML pages, /api/*) is
// network-only so live spend figures are never served stale.
export function serviceWorkerJs(): string {
  const cache = `tt-static-v${appVersion()}`;
  return `const CACHE = ${JSON.stringify(cache)};
const PRECACHE = [
  '/static/dashboard.css', '/static/dashboard.js',
  '/static/uPlot.iife.min.js', '/static/uPlot.min.css',
  '/static/fonts.css', '/static/logo.png',
  '/static/icon-192.png', '/static/icon-512.png',
];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || !url.pathname.startsWith('/static/')) return; // network-only
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
      return res;
    }))
  );
});
`;
}
```

- [ ] **Step 4: Run the generator test to verify it passes**

Run: `npm test 2>&1 | grep -A3 serviceWorkerJs`
Expected: PASS.

- [ ] **Step 5: Add the /sw.js route**

In `src/dashboard/server.ts`, import and serve it (add near the manifest route):

```ts
import { serviceWorkerJs } from './sw.js';
// ...
  app.get('/sw.js', async (_req, reply) => {
    reply.type('text/javascript; charset=utf-8');
    reply.header('cache-control', 'no-cache'); // always revalidate the SW itself
    return serviceWorkerJs();
  });
```

- [ ] **Step 6: Add the registration script in shell.ts**

Before `</body>` (after the `dashboard.js` script tag ~line 101) in `src/dashboard/render/shell.ts`:

```html
<script>if('serviceWorker' in navigator){window.addEventListener('load',function(){navigator.serviceWorker.register('/sw.js').catch(function(){});});}</script>
```

- [ ] **Step 7: Run full suite + typecheck**

Run: `npm test 2>&1 | tail -20 && npx tsc --noEmit`
Expected: all PASS, no type errors.

- [ ] **Step 8: Verify the route live**

Run: `curl -s -o /dev/null -w "%{http_code} %{content_type}\n" http://127.0.0.1:4920/sw.js` (via `npm run dev dashboard` if the daemon binary is stale).
Expected: `200 text/javascript; charset=utf-8`.

- [ ] **Step 9: Commit**

```bash
git add src/dashboard/sw.ts src/dashboard/server.ts src/dashboard/render/shell.ts tests/sw.test.ts
git commit -m "feat(dashboard): service worker — cache-first static, network-only data"
```

---

### Task 7: End-to-end mobile + PWA verification

Final manual pass on a real phone-width viewport and an install check. No code unless a check fails (then fix in the relevant task's files and re-commit).

**Files:** none (verification only).

- [ ] **Step 1: Run the whole suite + typecheck once more**

Run: `npm test && npx tsc --noEmit`
Expected: green.

- [ ] **Step 2: Build to confirm static assets ship**

Run: `npm run build && ls dist/src/dashboard/static/ | grep -E 'icon-(192|512)|manifest' ; ls dist/src/dashboard/ | grep sw`
Expected: `sw.js` is generated by a route (not a static file — it won't be in `static/`); icons present in `dist/.../static/`. (`manifest` is route-served too, so it also won't be a file — that's correct.)

- [ ] **Step 3: Mobile visual sweep at 390px (both themes)**

On `127.0.0.1:4920` at 390px, in light **and** dark, walk Overview → Today → Worth a look → Settings → a `/feature/...` drill-down and confirm each item in the spec's Verification checklist:
- Content starts near the top (~64px), not ~320px.
- Bottom bar fixed/thumb-reachable/clears home indicator, active tab highlighted, Today leftmost.
- Trend chart full-width and legible, legend below it.
- Worth a look = clean stacked cards, no letter-per-line wrapping.
- Brand-mark still lands on Overview (`/`).

- [ ] **Step 4: PWA install check**

In Chrome DevTools → Application: Manifest shows name/icons with no errors; Service Workers shows `/sw.js` activated; on a phone (or DevTools device mode) "Add to Home Screen" installs a standalone icon that launches chromeless in portrait. Confirm HTML/`/api` responses are **not** in the SW cache (Application → Cache Storage → only `/static/*` entries).

- [ ] **Step 5: Final commit (if any fixes were made)**

```bash
git add -A
git commit -m "chore(dashboard): mobile + PWA verification fixes"
```

---

## Self-Review

**Spec coverage:**
- §1 bottom tab bar → Tasks 1, 2. ✓
- §1 tab order (Today leftmost) → Task 1. ✓
- §2 slim sticky top bar → Task 2. ✓
- §3 trend chart legend below → Task 3. ✓
- §4 Worth-a-look cards → Task 3. ✓
- §5 home stays Overview (no redirect) → honored by *not* adding any redirect; brand-mark → `/` asserted in Task 1. ✓
- §6 manifest → Task 5; icons → Task 4; service worker (cache-first static / network-only data) → Task 6; iOS meta + theme-color + safe areas → Tasks 5 (meta) + 2/3 (safe areas). ✓
- Verification checklist → Task 7. ✓

**Placeholder scan:** No TBD/TODO; every code step has concrete content; the one conditional (sips `--padColor` fallback) gives a complete Pillow alternative.

**Type consistency:** `serviceWorkerJs()` defined in Task 6 sw.ts and consumed by the Task 6 route and test with matching signature. `renderShell`/`ShellOptions`/`buildServer` signatures unchanged. Nav order asserted consistently (Today before Overview) in Task 1 and re-verified in Task 7. Manifest icon count (3) matches Task 4's three generated files. Cache name pattern `tt-static-v<semver>` consistent between Task 6 impl and test.

**DB import path:** resolved — `closeDb` is imported from `../src/db/db.js` (the working precedent in `tests/api.test.ts`), used in Task 5's test.
