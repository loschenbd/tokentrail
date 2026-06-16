# Tokentrail SwiftBar Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a macOS menu bar widget showing today's Tokentrail spend, backed by a new JSON endpoint and a SwiftBar plugin script.

**Architecture:** One new Fastify JSON route (`GET /api/today`) reuses the existing `buildOverview` view-model plus a direct anomalies count query. A ~60-line Node script (`scripts/menubar/tokentrail.5m.js`) curls that route every 5 minutes and emits SwiftBar's text protocol to render the menu bar item. README explains how to install via Homebrew Cask + symlink. No new runtime dependencies; no Swift, no code-signing, no Sparkle.

**Tech Stack:** Node 20+ (built-in `fetch`, `AbortController`), Fastify, better-sqlite3 (existing), SwiftBar (user-installed via `brew install --cask swiftbar`), `node:test` + `tsx` for tests.

**Spec:** `docs/superpowers/specs/2026-06-16-tokentrail-swiftbar-plugin-design.md`

---

## File Map

**New files:**
- `src/dashboard/data/api.ts` — JSON shaper: `TodayResponse` type + `buildToday(db)` function
- `tests/api.test.ts` — unit tests for `buildToday`
- `scripts/menubar/tokentrail.5m.js` — SwiftBar plugin (executable Node script)

**Modified files:**
- `src/dashboard/server.ts` — add `GET /api/today` route
- `README.md` — add "Menu bar widget (SwiftBar)" subsection under Dashboard

---

## Task 0: Worktree setup

- [ ] **Step 1: Create isolated workspace**

Use `superpowers:using-git-worktrees`. Base: master. Branch: `feat/swiftbar`.

This invokes either a native worktree tool or `git worktree add .worktrees/feat-swiftbar -b feat/swiftbar`. After the worktree exists, `cd` into it; all subsequent tasks run from there.

- [ ] **Step 2: Verify clean baseline**

```bash
npm install
npm test
```

Expected: `# tests 37`, `# pass 37`, `# fail 0`. If anything fails, stop and report — do not proceed with a dirty baseline.

- [ ] **Step 3: Symlink parent `.env` (worktree quirk)**

Worktrees don't share `.env`. If the parent has one, symlink it in:

```bash
[ -f ../../.env ] && ln -sf ../../.env .env
```

The plugin work doesn't need any env vars at runtime, but the test suite reads `.env` defensively. This avoids surprises.

---

## Task 1: TDD `buildToday` shaper

**Files:**
- Create: `src/dashboard/data/api.ts`
- Create: `tests/api.test.ts`

This is the single source of truth for the JSON shape served by `/api/today`. The route handler in Task 2 is a one-liner that calls this.

- [ ] **Step 1: Write the failing test file**

Create `tests/api.test.ts`:

```typescript
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrations.js';
import { buildToday } from '../src/dashboard/data/api.js';

function makeDb() {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

function insertRollup(db: Database.Database, params: {
  date: string;
  featureKey: string;
  featureName: string;
  repo: string | null;
  cost: number;
  sessionIds: string;
  sessions: number;
}) {
  db.prepare(
    `INSERT INTO feature_rollups (id, date, feature_key, feature_name, repo, total_input_tokens, total_output_tokens, total_cost_usd, sessions_count, session_ids)
     VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, ?)`
  ).run(
    `${params.date}::${params.featureKey}`,
    params.date,
    params.featureKey,
    params.featureName,
    params.repo,
    params.cost,
    params.sessions,
    params.sessionIds,
  );
}

function insertAnomaly(db: Database.Database, opts: { date: string; dismissed: boolean }) {
  db.prepare(
    `INSERT INTO anomalies (kind, date, feature_key, session_id, amount, baseline, multiplier, reason, dismissed_at)
     VALUES ('feature_spike', ?, 'feat-x', NULL, 10, 1, 10, '10x baseline', ?)`
  ).run(opts.date, opts.dismissed ? "2026-06-16T00:00:00Z" : null);
}

describe('buildToday', () => {
  test('returns today total, top 3 features (with hrefs), and open anomaly count', () => {
    const db = makeDb();
    const today = (db.prepare(`SELECT date('now','localtime') AS d`).get() as { d: string }).d;

    insertRollup(db, { date: today, featureKey: 'feat-a', featureName: 'Feature A', repo: 'owner/repo', cost: 1.10, sessionIds: 'sA', sessions: 1 });
    insertRollup(db, { date: today, featureKey: 'feat-b', featureName: 'Feature B', repo: 'owner/repo', cost: 0.80, sessionIds: 'sB', sessions: 1 });
    insertRollup(db, { date: today, featureKey: 'feat-c', featureName: 'Feature C', repo: 'owner/repo', cost: 0.50, sessionIds: 'sC', sessions: 1 });
    insertRollup(db, { date: today, featureKey: 'feat-d', featureName: 'Feature D', repo: 'owner/repo', cost: 0.20, sessionIds: 'sD', sessions: 1 });

    insertAnomaly(db, { date: today, dismissed: false });
    insertAnomaly(db, { date: today, dismissed: false });
    insertAnomaly(db, { date: today, dismissed: true });   // dismissed → not counted

    const r = buildToday(db);

    assert.equal(r.todayUsd, 2.60);
    assert.equal(r.topFeatures.length, 3);
    assert.equal(r.topFeatures[0]!.key, 'feat-a');
    assert.equal(r.topFeatures[0]!.name, 'Feature A');
    assert.equal(r.topFeatures[0]!.usd, 1.10);
    assert.equal(r.topFeatures[0]!.href, 'http://127.0.0.1:4920/feature/feat-a');
    assert.equal(r.anomalyCount, 2);
    assert.match(r.asOf, /^\d{4}-\d{2}-\d{2}T/);
  });

  test('handles empty day: zero totals, empty array, zero anomalies', () => {
    const db = makeDb();
    const r = buildToday(db);

    assert.equal(r.todayUsd, 0);
    assert.equal(r.topFeatures.length, 0);
    assert.equal(r.anomalyCount, 0);
  });

  test('URL-encodes feature keys with slashes or unusual characters', () => {
    const db = makeDb();
    const today = (db.prepare(`SELECT date('now','localtime') AS d`).get() as { d: string }).d;
    insertRollup(db, { date: today, featureKey: 'repo:owner/name', featureName: 'Has slash', repo: null, cost: 1, sessionIds: 's', sessions: 1 });

    const r = buildToday(db);

    assert.equal(r.topFeatures[0]!.href, 'http://127.0.0.1:4920/feature/repo%3Aowner%2Fname');
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
npm test -- --test-name-pattern='buildToday'
```

Expected: FAIL with "Cannot find module ... src/dashboard/data/api.js".

- [ ] **Step 3: Implement `src/dashboard/data/api.ts`**

Create the file:

```typescript
import type * as DatabaseType from 'better-sqlite3';
import { buildOverview } from './overview.js';

const DASHBOARD_BASE_URL = 'http://127.0.0.1:4920';

export type TodayResponse = {
  todayUsd: number;
  topFeatures: Array<{
    key: string;
    name: string;
    usd: number;
    href: string;
  }>;
  anomalyCount: number;
  asOf: string;
};

export function buildToday(db: DatabaseType.Database): TodayResponse {
  const overview = buildOverview(db, { days: 1 });

  const anomalyCount = (db
    .prepare(`SELECT COUNT(*) AS n FROM anomalies WHERE dismissed_at IS NULL`)
    .get() as { n: number }).n;

  return {
    todayUsd: overview.totalUsd,
    topFeatures: overview.topFeatures.slice(0, 3).map((f) => ({
      key: f.featureKey,
      name: f.featureName,
      usd: f.totalUsd,
      href: `${DASHBOARD_BASE_URL}/feature/${encodeURIComponent(f.featureKey)}`,
    })),
    anomalyCount,
    asOf: new Date().toISOString(),
  };
}
```

- [ ] **Step 4: Run the test to confirm it passes**

```bash
npm test -- --test-name-pattern='buildToday'
```

Expected: PASS, 3/3 subtests.

- [ ] **Step 5: Run the full suite to confirm no regressions**

```bash
npm test
```

Expected: `# tests 40`, `# pass 40` (was 37, +3 new subtests).

- [ ] **Step 6: Commit**

```bash
git add src/dashboard/data/api.ts tests/api.test.ts
git commit -m "feat(api): buildToday view-model for menubar JSON endpoint"
```

---

## Task 2: Wire `/api/today` route into Fastify

**Files:**
- Modify: `src/dashboard/server.ts` (add a new route alongside existing ones)
- Modify: `tests/dashboard-data.test.ts` (add a route-level integration test) OR create `tests/api-route.test.ts`

For consistency with existing tests, add a small route test that boots the server and curls the endpoint.

- [ ] **Step 1: Write the route integration test**

Append to `tests/api.test.ts` (before the final `});` of the file is fine — they're separate `describe` blocks):

```typescript
import { buildServer } from '../src/dashboard/server.js';

describe('GET /api/today', () => {
  test('returns 200 with JSON content-type and TodayResponse shape', async () => {
    const app = buildServer({ defaultDays: 30 });
    try {
      const res = await app.inject({ method: 'GET', url: '/api/today' });
      assert.equal(res.statusCode, 200);
      assert.match(res.headers['content-type'] as string, /^application\/json/);
      const body = res.json() as { todayUsd: number; topFeatures: unknown[]; anomalyCount: number; asOf: string };
      assert.equal(typeof body.todayUsd, 'number');
      assert.ok(Array.isArray(body.topFeatures));
      assert.equal(typeof body.anomalyCount, 'number');
      assert.match(body.asOf, /^\d{4}-\d{2}-\d{2}T/);
    } finally {
      await app.close();
    }
  });
});
```

Note: this uses the real database (whatever `getDb()` returns). The test asserts only types/shape, not values — so it's deterministic regardless of the live DB contents.

- [ ] **Step 2: Run to confirm it fails**

```bash
npm test -- --test-name-pattern='GET /api/today'
```

Expected: FAIL — route returns 404 because we haven't added it.

- [ ] **Step 3: Add the route to `src/dashboard/server.ts`**

In the imports block, add:

```typescript
import { buildToday } from './data/api.js';
```

Then, in `buildServer(...)`, add a new route alongside the existing `app.get('/', ...)` block. Place it just before the static-asset handler section:

```typescript
  app.get('/api/today', async (_req, reply) => {
    const payload = buildToday(getDb());
    reply.type('application/json; charset=utf-8');
    return payload;
  });
```

- [ ] **Step 4: Run the test to confirm it passes**

```bash
npm test -- --test-name-pattern='GET /api/today'
```

Expected: PASS, 1/1.

- [ ] **Step 5: Run the full suite**

```bash
npm test
```

Expected: `# tests 41`, `# pass 41`, `# fail 0`.

- [ ] **Step 6: Smoke-test against a live server**

```bash
npm run tokentrail -- dashboard > /tmp/dash.log 2>&1 &
sleep 2
curl -s http://127.0.0.1:4920/api/today | head -c 500
pkill -f "tokentrail.*dashboard" 2>/dev/null
```

Expected: a JSON blob with the four keys (`todayUsd`, `topFeatures`, `anomalyCount`, `asOf`). Eyeball it.

- [ ] **Step 7: Commit**

```bash
git add src/dashboard/server.ts tests/api.test.ts
git commit -m "feat(api): expose buildToday via GET /api/today"
```

---

## Task 3: Write the SwiftBar plugin script

**Files:**
- Create: `scripts/menubar/tokentrail.5m.js`

This is presentation glue. No unit tests — too much string-formatting churn for tests to add value. We verify by running it and inspecting the output.

- [ ] **Step 1: Create the plugin directory**

```bash
mkdir -p scripts/menubar
```

- [ ] **Step 2: Write the script**

Create `scripts/menubar/tokentrail.5m.js`:

```javascript
#!/usr/bin/env node
// Tokentrail SwiftBar plugin.
//
// Filename convention: `.5m.` tells SwiftBar to re-run this script every
// 5 minutes. See https://github.com/swiftbar/SwiftBar#plugin-api for the
// full text protocol.
//
// Requires the Tokentrail dashboard server on 127.0.0.1:4920. Install:
//   brew install --cask swiftbar
//   ln -s "$PWD/scripts/menubar/tokentrail.5m.js" \
//     ~/Library/Application\ Support/SwiftBar/

'use strict';

const ENDPOINT = 'http://127.0.0.1:4920/api/today';
const REPO_URL = 'https://github.com/loschenbd/tokentrail#menu-bar-widget-swiftbar';
const FETCH_TIMEOUT_MS = 2000;

function fmtUsd(n) {
  return `$${Number(n).toFixed(2)}`;
}

function plural(n, singular, plural) {
  return `${n} ${n === 1 ? singular : plural}`;
}

function renderError(message) {
  return [
    `$— | color=#8b6f47`,
    `---`,
    `${message} | color=#8b6f47`,
    `Install / docs | href=${REPO_URL}`,
    `Refresh | refresh=true`,
  ].join('\n');
}

function renderHappy(data) {
  const lines = [];
  lines.push(`${fmtUsd(data.todayUsd)} | font=Menlo size=12`);
  lines.push('---');

  if (data.topFeatures.length === 0) {
    lines.push('TODAY · no activity yet | color=#6b563d size=11');
  } else {
    lines.push(
      `TODAY · ${plural(data.topFeatures.length, 'feature', 'features')} · ` +
      `${plural(data.anomalyCount, 'anomaly', 'anomalies')} | color=#6b563d size=11`
    );
    lines.push('---');
    for (const f of data.topFeatures) {
      // SwiftBar splits on ` | `, so the label may not contain that token.
      const label = `${f.name}  ${fmtUsd(f.usd)}`.replace(/\s*\|\s*/g, ' ');
      lines.push(`${label} | href=${f.href}`);
    }
  }

  lines.push('---');
  lines.push('Open dashboard | href=http://127.0.0.1:4920/');
  lines.push('Refresh | refresh=true');
  return lines.join('\n');
}

(async () => {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(ENDPOINT, { signal: ac.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    console.log(renderHappy(data));
  } catch (err) {
    console.log(renderError('Tokentrail dashboard not running'));
  } finally {
    clearTimeout(timer);
  }
})();
```

- [ ] **Step 3: Make it executable**

```bash
chmod +x scripts/menubar/tokentrail.5m.js
```

- [ ] **Step 4: Smoke-test the script against a live server**

```bash
npm run tokentrail -- dashboard > /tmp/dash.log 2>&1 &
sleep 2
node scripts/menubar/tokentrail.5m.js
echo "---"
echo "(now killing dashboard to test error path)"
pkill -f "tokentrail.*dashboard" 2>/dev/null
sleep 1
node scripts/menubar/tokentrail.5m.js
```

Expected: first call prints a `$X.XX` line, then a `---` divider, then the dropdown rows. Second call (server down) prints `$—`, then "Tokentrail dashboard not running", then docs link + Refresh.

- [ ] **Step 5: Verify the script's shebang resolves**

```bash
./scripts/menubar/tokentrail.5m.js
```

Should print the error-path output (server is down). If it errors with "node: command not found" or similar, the env shebang isn't finding node — fix `PATH` or document.

- [ ] **Step 6: Commit**

```bash
git add scripts/menubar/tokentrail.5m.js
git commit -m "feat(menubar): SwiftBar plugin emitting today's spend"
```

---

## Task 4: README install docs

**Files:**
- Modify: `README.md` (add subsection under Dashboard)

- [ ] **Step 1: Edit README.md**

Find the line in `README.md` that reads:

```
The dashboard is read-only. Labeling, anomaly dismissal, and sync stay on the
CLI. Stop it with Ctrl-C.
```

Immediately after that line, before the next `### Anomalies` heading, insert:

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
widget shows today's spend (`$X.XX`) and refreshes every 5 minutes. Click
it to see the top 3 features (each links into the dashboard) and an
anomaly count.

Requires `tokentrail dashboard` to be running on port 4920. If it isn't,
the widget shows `$—` and a "not running" hint instead of crashing.
````

- [ ] **Step 2: Sanity-check the rendered markdown**

```bash
grep -A 2 "Menu bar widget" README.md | head -10
```

Expected: the new heading and its first line appear.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(readme): SwiftBar menu bar install instructions"
```

---

## Task 5: Final verification

- [ ] **Step 1: Run the full test suite**

```bash
npm test 2>&1 | tail -10
```

Expected: `# tests 41`, `# pass 41`, `# fail 0`.

- [ ] **Step 2: End-to-end smoke test**

```bash
npm run tokentrail -- dashboard > /tmp/dash.log 2>&1 &
sleep 2

echo "=== JSON endpoint ==="
curl -s http://127.0.0.1:4920/api/today | node -e "let d=''; process.stdin.on('data',c=>d+=c).on('end',()=>{const o=JSON.parse(d); console.log('keys:', Object.keys(o).join(','), '| todayUsd:', o.todayUsd, '| features:', o.topFeatures.length, '| anomalies:', o.anomalyCount)})"

echo "=== Plugin output (happy path) ==="
node scripts/menubar/tokentrail.5m.js

pkill -f "tokentrail.*dashboard" 2>/dev/null
sleep 1

echo "=== Plugin output (server down) ==="
node scripts/menubar/tokentrail.5m.js
```

Expected:
- Endpoint reports the four keys with sensible values.
- Plugin happy-path output shows `$X.XX`, then `---`, then a `TODAY · ...` header, then either feature rows or `no activity yet`, then `Open dashboard | href=...`.
- Plugin error output shows `$—` and "Tokentrail dashboard not running".

- [ ] **Step 3: Hand off to finishing-a-development-branch**

Use `superpowers:finishing-a-development-branch` to verify tests, present merge options, and clean up the worktree.

---

## Notes for the implementer

- The existing project uses ES modules with NodeNext resolution, hence the `.js` suffix on TypeScript imports (`from './overview.js'`). Don't drop them — TS won't complain but the runtime will.
- The test runner is `node --import tsx --test` (see `package.json`). Tests are plain `node:test` with `assert/strict`. No Vitest, no Jest.
- `getDb()` returns a singleton SQLite handle. The route handler uses it directly; the unit tests in Task 1 use in-memory `Database(':memory:')` for isolation.
- SwiftBar's text protocol is loosely documented at https://github.com/swiftbar/SwiftBar. The pipe character `|` separates the label from the parameter list (`href=`, `color=`, `font=`, etc.). We sanitize labels to avoid accidental pipes.
- Don't add `@types/node` or other deps. Everything used (`fetch`, `AbortController`, `URL`) is built into Node 20+.
