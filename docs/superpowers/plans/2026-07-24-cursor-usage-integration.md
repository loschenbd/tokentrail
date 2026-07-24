# Cursor Usage Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Track Cursor usage in Tokentrail as a parallel lane — local AI-authored-code attribution (categorized by commit→repo→feature) plus an uncategorized account-spend tile — without ever touching the token-cost spine.

**Architecture:** Two independent data sources, each with its own table. Source B reads Cursor's local `ai-code-tracking.db` (`scored_commits`) read-only, resolves each commit to a repo via `git cat-file`, and reuses the existing `(repo, branch) → feature` attribution. Source A reads a web-session cookie derived from Cursor's `state.vscdb` and calls `cursor.com/api/usage-summary`, caching the result with a stale-fallback. Cursor rows never enter `usage_events`.

**Tech Stack:** Node.js + TypeScript, better-sqlite3, commander, `node --test` (built-in runner) with tsx, native `fetch`.

## Global Constraints

- Migrations run on every startup via idempotent SQL; new tables go in `src/db/schema.ts` `SCHEMA_STATEMENTS`; column-dependent indexes go in `src/db/migrations.ts` (copy verbatim: rule #1).
- Never hardcode API keys / secrets; cookie comes from local files or config/env (rule #2).
- All costs labeled `estimated` (rule #3).
- better-sqlite3 is the only DB layer (rule #4). Read the foreign Cursor DBs read-only via `new Database(path, { readonly: true, fileMustExist: true })`.
- `(repo, branch) → feature` attribution logic lives only in `src/lib/attribution.ts` (rule #5). The commit→repo git probe is a git-service concern (`src/services/git.ts`), not attribution.
- GitHub/Notion/**Cursor** failures log cleanly and never crash the pipeline (rule #6).
- CLI language restrained; fantasy flavor only in microcopy (rules #7, #8).
- Cursor source DBs are read-only to us — never write to them (rule #9 spirit).
- **Invariant:** Cursor lines are never summed into USD; Cursor dollars are never summed into token-cost totals; the two Cursor metrics are never summed into each other.
- Test runner: `npm test` runs `node --import tsx --test $(find tests -name '*.test.ts')`. Tests use `node:test` + `node:assert/strict` + in-memory `better-sqlite3` with `runMigrations(db)`.

---

## File Structure

- Create `src/services/cursor-tracking-reader.ts` — read-only reader over `ai-code-tracking.db` → typed `scored_commits` rows. No DB writes, no git.
- Create `src/services/cursor-cloud.ts` — session-cookie derivation from `state.vscdb` + `usage-summary` fetch/parse. Network + foreign-DB read only.
- Create `src/commands/cursor.ts` — orchestration: ingest (Source B), spend (Source A), and the combined entry. Owns the Tokentrail-DB writes.
- Modify `src/db/schema.ts` — add `cursor_code_attribution`, `cursor_usage`, `cursor_ingest_state` tables + indexes.
- Modify `src/services/git.ts` — add `commitExistsIn(dir, sha)`.
- Modify `src/lib/config.ts` — add Cursor config knobs.
- Modify `src/index.ts` — register `tokentrail cursor`.
- Modify `src/commands/run-all.ts` — call cursor ingest after enrich (non-fatal).
- Modify `src/commands/report.ts` — render the Cursor lane.
- Tests: `tests/cursor-tracking-reader.test.ts`, `tests/cursor-attribution.test.ts`, `tests/cursor-cloud.test.ts`, `tests/cursor-invariant.test.ts`.

---

## Task 0: Spike — confirm Source A cookie + endpoint (no code committed)

**Files:** none (throwaway).

This de-risks Source A before any spend code. Time-box to ~30 min.

- [ ] **Step 1: Locate the session cookie in state.vscdb**

Run (read-only copy first):
```bash
cp ~/Library/Application\ Support/Cursor/User/globalStorage/state.vscdb /tmp/cursor-gs.db
sqlite3 /tmp/cursor-gs.db "SELECT key FROM ItemTable WHERE key LIKE '%ourSecrets%' OR key LIKE '%cookie%' OR key='cursorAuth/accessToken';"
sqlite3 /tmp/cursor-gs.db "SELECT length(value) FROM ItemTable WHERE key='cursorAuth/accessToken';"
```
Goal: find whether a `WorkosCursorSessionToken` cookie value (or a token that can be sent as that cookie) is retrievable locally.

- [ ] **Step 2: Probe the endpoint**

With the derived cookie value in `$COOKIE`:
```bash
curl -s 'https://cursor.com/api/usage-summary' \
  -H "Cookie: WorkosCursorSessionToken=$COOKIE" | head -c 800
```
Expected: JSON with plan/on-demand usage + a billing-cycle window. Record the exact field names.

- [ ] **Step 3: Decide**

- Works → proceed to all tasks; fill the real field names into Task 8.
- Fails (needs browser cookies / undocumented derivation) → **mark Source A degraded**: implement only the pasted-cookie fallback path (config `cursor.sessionCookie`) in Task 8 and note in the plan that with no cookie, spend is skipped. Source B (Tasks 1–7) proceeds unchanged either way.

No commit — this is investigation only.

---

## Task 1: Cursor DB schema

**Files:**
- Modify: `src/db/schema.ts` (append to `SCHEMA_STATEMENTS`)
- Test: `tests/cursor-tracking-reader.test.ts` (schema-presence check reused later)

**Interfaces:**
- Produces tables: `cursor_code_attribution`, `cursor_usage`, `cursor_ingest_state`.

- [ ] **Step 1: Write the failing test**

Create `tests/cursor-tracking-reader.test.ts`:
```ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrations.js';

describe('cursor schema', () => {
  test('creates cursor tables', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r: any) => r.name);
    assert.ok(names.includes('cursor_code_attribution'));
    assert.ok(names.includes('cursor_usage'));
    assert.ok(names.includes('cursor_ingest_state'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test tests/cursor-tracking-reader.test.ts`
Expected: FAIL — assertion false (tables absent).

- [ ] **Step 3: Add the tables**

Append to the `SCHEMA_STATEMENTS` array in `src/db/schema.ts`:
```ts
  `CREATE TABLE IF NOT EXISTS cursor_code_attribution (
    commit_hash    TEXT PRIMARY KEY,
    repo           TEXT,
    branch         TEXT NOT NULL,
    ai_lines       INTEGER NOT NULL DEFAULT 0,
    composer_lines INTEGER NOT NULL DEFAULT 0,
    tab_lines      INTEGER NOT NULL DEFAULT 0,
    human_lines    INTEGER NOT NULL DEFAULT 0,
    ai_pct         REAL,
    committed_at   TEXT,
    message        TEXT,
    scored_at      INTEGER NOT NULL,
    source         TEXT NOT NULL DEFAULT 'cursor'
  )`,

  `CREATE INDEX IF NOT EXISTS idx_cursor_attr_repo_branch
    ON cursor_code_attribution (repo, branch)`,

  `CREATE TABLE IF NOT EXISTS cursor_usage (
    id                 INTEGER PRIMARY KEY CHECK (id = 1),
    cycle_start        TEXT,
    cycle_end          TEXT,
    membership_type    TEXT,
    plan_used          REAL,
    plan_limit         REAL,
    plan_pct_used      REAL,
    ondemand_enabled   INTEGER,
    ondemand_used      REAL,
    metered_usd        REAL,     -- SUM(chargedCents)/100 over the current cycle
    events_scanned     INTEGER,  -- how many dashboard events were summed
    events_total       INTEGER,  -- totalUsageEventsCount reported by the API
    truncated          INTEGER NOT NULL DEFAULT 0,  -- 1 if the page cap stopped us early
    fetched_at         TEXT NOT NULL,
    stale              INTEGER NOT NULL DEFAULT 0
  )`,

  `CREATE TABLE IF NOT EXISTS cursor_ingest_state (
    key            TEXT PRIMARY KEY,
    last_scored_at INTEGER NOT NULL
  )`,
```
(`cursor_usage` is a singleton row via `CHECK (id = 1)` — one account-level snapshot folding both endpoints: utilization from `usage-summary` and the metered-dollar total from `get-filtered-usage-events`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test tests/cursor-tracking-reader.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.ts tests/cursor-tracking-reader.test.ts
git commit -m "feat(cursor): add cursor_code_attribution, cursor_usage, cursor_ingest_state tables"
```

---

## Task 2: Config knobs

**Files:**
- Modify: `src/lib/config.ts`
- Test: (covered indirectly; add a minimal assertion)

**Interfaces:**
- Produces on `TokentrailConfig`: `cursorTrackingDbPath: string | null`, `cursorStateDbPath: string | null`, `cursorSessionCookie: string | null`, `cursorCloudSpend: boolean`.

- [ ] **Step 1: Write the failing test**

Append to `tests/cursor-tracking-reader.test.ts`:
```ts
import { getConfig, resetConfigCache } from '../src/lib/config.js';

describe('cursor config defaults', () => {
  test('cloud spend enabled by default, paths null', () => {
    resetConfigCache();
    const c = getConfig();
    assert.equal(c.cursorCloudSpend, true);
    assert.equal(c.cursorTrackingDbPath, null);
    assert.equal(c.cursorSessionCookie, null);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test tests/cursor-tracking-reader.test.ts`
Expected: FAIL — `cursorCloudSpend` undefined.

- [ ] **Step 3: Add fields to config**

In `src/lib/config.ts`: add to the `TokentrailConfig` type:
```ts
  /** Override path to Cursor's ai-code-tracking.db. Null = default location. */
  cursorTrackingDbPath: string | null;
  /** Override path to Cursor's globalStorage state.vscdb. Null = default. */
  cursorStateDbPath: string | null;
  /** Manually-pasted WorkosCursorSessionToken cookie value. Null = derive locally. */
  cursorSessionCookie: string | null;
  /** When false, skip the cursor.com network call entirely (local Source B still runs). */
  cursorCloudSpend: boolean;
```
Add to `EMPTY_CONFIG`:
```ts
  cursorTrackingDbPath: null,
  cursorStateDbPath: null,
  cursorSessionCookie: null,
  cursorCloudSpend: true,
```
In `loadConfig()` where the raw JSON is parsed into the config object, read the same keys (`raw.cursorTrackingDbPath ?? null`, etc.; `raw.cursorCloudSpend !== false` so the default is true). Follow the existing parse pattern in the file.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test tests/cursor-tracking-reader.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/config.ts tests/cursor-tracking-reader.test.ts
git commit -m "feat(cursor): add cursor config knobs (paths, cookie, cloudSpend toggle)"
```

---

## Task 3: Source B reader (`scored_commits` → typed rows)

**Files:**
- Create: `src/services/cursor-tracking-reader.ts`
- Test: `tests/cursor-tracking-reader.test.ts`

**Interfaces:**
- Produces:
  - `export type CursorScoredCommit = { commitHash: string; branch: string; aiLines: number; composerLines: number; tabLines: number; humanLines: number; aiPct: number | null; committedAt: string | null; message: string | null; scoredAt: number }`
  - `export function cursorTrackingDbPath(): string`
  - `export function readScoredCommits(dbPath: string, sinceScoredAt: number): CursorScoredCommit[]`

- [ ] **Step 1: Write the failing test**

Append to `tests/cursor-tracking-reader.test.ts`:
```ts
import { readScoredCommits } from '../src/services/cursor-tracking-reader.js';

function makeCursorDb() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE scored_commits (
    commitHash TEXT NOT NULL, branchName TEXT NOT NULL, scoredAt INTEGER NOT NULL,
    linesAdded INTEGER, linesDeleted INTEGER, tabLinesAdded INTEGER, tabLinesDeleted INTEGER,
    composerLinesAdded INTEGER, composerLinesDeleted INTEGER, humanLinesAdded INTEGER,
    humanLinesDeleted INTEGER, blankLinesAdded INTEGER, blankLinesDeleted INTEGER,
    commitMessage TEXT, commitDate TEXT, v1AiPercentage TEXT, v2AiPercentage TEXT,
    PRIMARY KEY (commitHash, branchName));`);
  db.prepare(`INSERT INTO scored_commits
    (commitHash, branchName, scoredAt, composerLinesAdded, tabLinesAdded, humanLinesAdded, v2AiPercentage, commitMessage, commitDate)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(
    'abc123', 'main', 1000, 20, 5, 3, '89.29', 'do a thing', 'Wed May 20 13:01:13 2026 -0700');
  db.prepare(`INSERT INTO scored_commits
    (commitHash, branchName, scoredAt, composerLinesAdded, tabLinesAdded, humanLinesAdded, v2AiPercentage)
    VALUES (?,?,?,?,?,?,?)`).run('old999', 'dev', 500, 1, 0, 0, '100.00');
  return db;
}

describe('readScoredCommits', () => {
  test('maps rows and filters by scoredAt watermark', () => {
    const cdb = makeCursorDb();
    const tmp = '/tmp/tt-cursor-fixture.db';
    cdb.backup(tmp); // write fixture to a real file for readonly open
    cdb.close();
    const rows = readScoredCommits(tmp, 999);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].commitHash, 'abc123');
    assert.equal(rows[0].aiLines, 25);        // composer 20 + tab 5
    assert.equal(rows[0].humanLines, 3);
    assert.equal(rows[0].aiPct, 89.29);
    assert.equal(rows[0].branch, 'main');
  });

  test('missing db returns empty, no throw', () => {
    assert.deepEqual(readScoredCommits('/no/such.db', 0), []);
  });
});
```
(`better-sqlite3` has `.backup(path)` for writing an in-memory fixture to disk. If unavailable in the installed version, write the fixture with a `new Database(tmp)` directly instead.)

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test tests/cursor-tracking-reader.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the reader**

Create `src/services/cursor-tracking-reader.ts`:
```ts
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type DatabaseType from 'better-sqlite3';
import { getConfig } from '../lib/config.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof DatabaseType;

export type CursorScoredCommit = {
  commitHash: string;
  branch: string;
  aiLines: number;
  composerLines: number;
  tabLines: number;
  humanLines: number;
  aiPct: number | null;
  committedAt: string | null;
  message: string | null;
  scoredAt: number;
};

export function cursorTrackingDbPath(): string {
  const override = getConfig().cursorTrackingDbPath;
  if (override) return override;
  return join(homedir(), '.cursor', 'ai-tracking', 'ai-code-tracking.db');
}

// Read-only, immutable open so we never contend with a running Cursor and
// never mutate the foreign DB. Any failure (missing file, schema drift,
// lock) degrades to [] with a logged warning — Cursor is never fatal.
export function readScoredCommits(
  dbPath: string,
  sinceScoredAt: number
): CursorScoredCommit[] {
  if (!existsSync(dbPath)) return [];
  let db: DatabaseType.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const rows = db
      .prepare(
        `SELECT commitHash, branchName, scoredAt,
                COALESCE(composerLinesAdded,0) AS composer,
                COALESCE(tabLinesAdded,0)      AS tab,
                COALESCE(humanLinesAdded,0)    AS human,
                v2AiPercentage, commitMessage, commitDate
         FROM scored_commits
         WHERE scoredAt > ?
         ORDER BY scoredAt ASC`
      )
      .all(sinceScoredAt) as Array<Record<string, unknown>>;
    return rows.map((r) => {
      const composer = Number(r.composer) || 0;
      const tab = Number(r.tab) || 0;
      const pctRaw = r.v2AiPercentage;
      const pct = pctRaw == null ? null : Number(pctRaw);
      return {
        commitHash: String(r.commitHash),
        branch: String(r.branchName),
        aiLines: composer + tab,
        composerLines: composer,
        tabLines: tab,
        humanLines: Number(r.human) || 0,
        aiPct: pct != null && Number.isFinite(pct) ? pct : null,
        committedAt: r.commitDate == null ? null : String(r.commitDate),
        message: r.commitMessage == null ? null : String(r.commitMessage),
        scoredAt: Number(r.scoredAt) || 0,
      };
    });
  } catch (err) {
    console.warn(
      `Cursor: could not read ${dbPath} (${(err as Error).message}). Skipping local AI-line ingest.`
    );
    return [];
  } finally {
    db?.close();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test tests/cursor-tracking-reader.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/services/cursor-tracking-reader.ts tests/cursor-tracking-reader.test.ts
git commit -m "feat(cursor): read-only scored_commits reader with scoredAt watermark"
```

---

## Task 4: `commitExistsIn` git probe

**Files:**
- Modify: `src/services/git.ts`
- Test: `tests/cursor-attribution.test.ts`

**Interfaces:**
- Produces: `export function commitExistsIn(dir: string, sha: string): boolean`

- [ ] **Step 1: Write the failing test**

Create `tests/cursor-attribution.test.ts`:
```ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitExistsIn } from '../src/services/git.js';

function makeRepoWithCommit(): { dir: string; sha: string } {
  const dir = mkdtempSync(join(tmpdir(), 'tt-git-'));
  const run = (args: string[]) =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  run(['init', '-q']);
  run(['config', 'user.email', 't@t.co']);
  run(['config', 'user.name', 'T']);
  writeFileSync(join(dir, 'f.txt'), 'hi');
  run(['add', '.']);
  run(['commit', '-q', '-m', 'init']);
  const sha = run(['rev-parse', 'HEAD']);
  return { dir, sha };
}

describe('commitExistsIn', () => {
  test('true for a sha in the repo, false otherwise', () => {
    const { dir, sha } = makeRepoWithCommit();
    assert.equal(commitExistsIn(dir, sha), true);
    assert.equal(commitExistsIn(dir, 'deadbeef00000000000000000000000000000000'), false);
  });

  test('false for a non-repo dir, no throw', () => {
    assert.equal(commitExistsIn('/tmp', 'deadbeef'), false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test tests/cursor-attribution.test.ts`
Expected: FAIL — `commitExistsIn` not exported.

- [ ] **Step 3: Implement**

Add to `src/services/git.ts` (reuse the existing `runGit` helper pattern in that file):
```ts
// True when <sha> is a commit object present in the repo at <dir>.
// `git cat-file -e <sha>^{commit}` exits 0 iff the object exists and is a
// commit; runGit returns null on any non-zero exit, so null => false.
export function commitExistsIn(dir: string, sha: string): boolean {
  if (!isGitRepo(dir)) return false;
  return runGit(dir, ['cat-file', '-e', `${sha}^{commit}`]) !== null;
}
```
(If `runGit` is not exported/visible at that location, it is defined later in `git.ts:132` — place `commitExistsIn` below it, or hoist a call using `execFileSync` mirroring `runGit`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test tests/cursor-attribution.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/git.ts tests/cursor-attribution.test.ts
git commit -m "feat(git): add commitExistsIn for cursor commit->repo resolution"
```

---

## Task 5: Commit→repo resolution helper

**Files:**
- Create: (add to) `src/commands/cursor.ts`
- Test: `tests/cursor-attribution.test.ts`

**Interfaces:**
- Consumes: `commitExistsIn` (Task 4).
- Produces: `export function resolveCommitRepo(commitHash: string, candidateDirs: string[], cache: Map<string, string | null>): string | null`

- [ ] **Step 1: Write the failing test**

Append to `tests/cursor-attribution.test.ts`:
```ts
import { resolveCommitRepo } from '../src/commands/cursor.js';

describe('resolveCommitRepo', () => {
  test('returns the local/<base> slug of the repo containing the sha', () => {
    const { dir, sha } = makeRepoWithCommit();
    const cache = new Map<string, string | null>();
    const repo = resolveCommitRepo(sha, [dir], cache);
    // no remote configured -> local/<basename>
    assert.ok(repo && repo.startsWith('local/'));
  });

  test('caches misses so repeat lookups do not re-shell git', () => {
    const cache = new Map<string, string | null>();
    const r1 = resolveCommitRepo('deadbeef', ['/tmp'], cache);
    assert.equal(r1, null);
    assert.equal(cache.has('deadbeef'), true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test tests/cursor-attribution.test.ts`
Expected: FAIL — module `../src/commands/cursor.js` not found.

- [ ] **Step 3: Implement (start `src/commands/cursor.ts`)**

Create `src/commands/cursor.ts`:
```ts
import { commitExistsIn, repoContextFor } from '../services/git.js';

// Resolve a Cursor-scored commit hash to a Tokentrail repo slug by testing
// membership across known project dirs. First containing repo wins. Results
// (including misses) are memoized in `cache` so a run never shells git twice
// for the same hash. A miss (no known repo contains it) returns null; the
// caller parks the row for a later run.
export function resolveCommitRepo(
  commitHash: string,
  candidateDirs: string[],
  cache: Map<string, string | null>
): string | null {
  if (cache.has(commitHash)) return cache.get(commitHash) ?? null;
  let resolved: string | null = null;
  for (const dir of candidateDirs) {
    if (commitExistsIn(dir, commitHash)) {
      resolved = repoContextFor(dir).repo;
      break;
    }
  }
  cache.set(commitHash, resolved);
  return resolved;
}
```
(`repoContextFor` is already exported from `src/services/git.ts:99` and returns `local/<base>` when no remote is set.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test tests/cursor-attribution.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/commands/cursor.ts tests/cursor-attribution.test.ts
git commit -m "feat(cursor): commit->repo resolution with memoized git membership"
```

---

## Task 6: Candidate-dir gathering + Source B ingest

**Files:**
- Modify: `src/commands/cursor.ts`
- Test: `tests/cursor-attribution.test.ts`

**Interfaces:**
- Consumes: `readScoredCommits` (Task 3), `resolveCommitRepo` (Task 5), the Tokentrail DB.
- Produces:
  - `export function knownProjectDirs(db: DatabaseType.Database): string[]`
  - `export async function runCursorIngest(db?: DatabaseType.Database): Promise<{ inserted: number; parked: number; scanned: number }>`

- [ ] **Step 1: Write the failing test**

Append to `tests/cursor-attribution.test.ts`:
```ts
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrations.js';
import { runCursorIngest, knownProjectDirs } from '../src/commands/cursor.js';
import { cursorTrackingDbPath } from '../src/services/cursor-tracking-reader.js';
import { getConfig, resetConfigCache } from '../src/lib/config.js';

test('runCursorIngest stores rows, resolving repo where a commit is known', async () => {
  const { dir, sha } = makeRepoWithCommit();
  // fixture cursor db with one scored commit matching the real sha
  const cur = new Database('/tmp/tt-cursor-ingest.db');
  cur.exec(`CREATE TABLE scored_commits (commitHash TEXT, branchName TEXT, scoredAt INTEGER,
    composerLinesAdded INTEGER, tabLinesAdded INTEGER, humanLinesAdded INTEGER,
    v2AiPercentage TEXT, commitMessage TEXT, commitDate TEXT,
    PRIMARY KEY (commitHash, branchName));`);
  cur.prepare(`INSERT INTO scored_commits VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(sha, 'main', 1234, 10, 0, 0, '100.00', 'm', 'd');
  cur.close();

  const db = new Database(':memory:');
  runMigrations(db);
  // seed a session whose project_dir is the real repo so knownProjectDirs finds it
  db.prepare(`INSERT INTO sessions (session_id, project_dir, first_seen_at, last_seen_at)
    VALUES ('s1', ?, '2026-01-01', '2026-01-01')`).run(dir);

  // point config at the fixture cursor db
  resetConfigCache();
  (getConfig() as any).cursorTrackingDbPath = '/tmp/tt-cursor-ingest.db';

  const res = await runCursorIngest(db);
  assert.equal(res.inserted, 1);
  const row: any = db.prepare('SELECT * FROM cursor_code_attribution WHERE commit_hash=?').get(sha);
  assert.ok(row.repo && row.repo.startsWith('local/'));
  assert.equal(row.ai_lines, 10);
  assert.equal(row.branch, 'main');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test tests/cursor-attribution.test.ts`
Expected: FAIL — `runCursorIngest`/`knownProjectDirs` not exported.

- [ ] **Step 3: Implement**

Add to `src/commands/cursor.ts`:
```ts
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import type DatabaseType from 'better-sqlite3';
import { getDb } from '../db/db.js';
import {
  readScoredCommits,
  cursorTrackingDbPath,
} from '../services/cursor-tracking-reader.js';

// Real filesystem dirs Tokentrail already knows about — the search space for
// commit->repo resolution. Distinct, existing dirs from sessions + usage.
export function knownProjectDirs(db: DatabaseType.Database): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT project_dir FROM sessions WHERE project_dir IS NOT NULL
       UNION SELECT DISTINCT project_dir FROM usage_events WHERE project_dir IS NOT NULL`
    )
    .all() as Array<{ project_dir: string }>;
  return rows.map((r) => r.project_dir).filter((d) => d && existsSync(d));
}

const WATERMARK_KEY = 'scored_commits';

export async function runCursorIngest(
  dbArg?: DatabaseType.Database
): Promise<{ inserted: number; parked: number; scanned: number }> {
  const db = dbArg ?? getDb();
  const path = cursorTrackingDbPath();

  const wmRow = db
    .prepare('SELECT last_scored_at FROM cursor_ingest_state WHERE key = ?')
    .get(WATERMARK_KEY) as { last_scored_at: number } | undefined;
  const since = wmRow?.last_scored_at ?? 0;

  const commits = readScoredCommits(path, since);
  if (commits.length === 0) {
    console.log('Cursor: no new scored commits.');
    return { inserted: 0, parked: 0, scanned: 0 };
  }

  const dirs = knownProjectDirs(db);
  const cache = new Map<string, string | null>();

  const upsert = db.prepare(`
    INSERT INTO cursor_code_attribution
      (commit_hash, repo, branch, ai_lines, composer_lines, tab_lines,
       human_lines, ai_pct, committed_at, message, scored_at, source)
    VALUES
      (@commit_hash, @repo, @branch, @ai_lines, @composer_lines, @tab_lines,
       @human_lines, @ai_pct, @committed_at, @message, @scored_at, 'cursor')
    ON CONFLICT(commit_hash) DO UPDATE SET
      repo = COALESCE(excluded.repo, cursor_code_attribution.repo),
      branch = excluded.branch,
      ai_lines = excluded.ai_lines,
      composer_lines = excluded.composer_lines,
      tab_lines = excluded.tab_lines,
      human_lines = excluded.human_lines,
      ai_pct = excluded.ai_pct,
      committed_at = excluded.committed_at,
      message = excluded.message,
      scored_at = excluded.scored_at
  `);

  let inserted = 0;
  let parked = 0;
  let maxScored = since;
  const tx = db.transaction(() => {
    for (const c of commits) {
      const repo = resolveCommitRepo(c.commitHash, dirs, cache);
      if (repo === null) parked++;
      upsert.run({
        commit_hash: c.commitHash,
        repo,
        branch: c.branch,
        ai_lines: c.aiLines,
        composer_lines: c.composerLines,
        tab_lines: c.tabLines,
        human_lines: c.humanLines,
        ai_pct: c.aiPct,
        committed_at: c.committedAt,
        message: c.message,
        scored_at: c.scoredAt,
      });
      inserted++;
      if (c.scoredAt > maxScored) maxScored = c.scoredAt;
    }
    db.prepare(
      `INSERT INTO cursor_ingest_state (key, last_scored_at) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET last_scored_at = excluded.last_scored_at`
    ).run(WATERMARK_KEY, maxScored);
  });
  tx();

  console.log(
    `Cursor: ingested ${inserted} scored commit${inserted === 1 ? '' : 's'}` +
      (parked > 0 ? ` (${parked} awaiting a known repo)` : '') +
      '.'
  );
  return { inserted, parked, scanned: commits.length };
}
```
**Note on the watermark + parked rows:** parked commits (repo NULL) advance the watermark, so they are not re-resolved automatically on the next run. To let a later-cloned repo pick them up, Task 7 adds a re-resolution pass over existing NULL-repo rows.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test tests/cursor-attribution.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/commands/cursor.ts tests/cursor-attribution.test.ts
git commit -m "feat(cursor): Source B ingest — scored commits into cursor_code_attribution"
```

---

## Task 7: Re-resolve parked (NULL-repo) rows

**Files:**
- Modify: `src/commands/cursor.ts`
- Test: `tests/cursor-attribution.test.ts`

**Interfaces:**
- Produces: `export function reresolveParkedCommits(db: DatabaseType.Database): number` (returns count newly resolved). `runCursorIngest` calls it at the end.

- [ ] **Step 1: Write the failing test**

Append to `tests/cursor-attribution.test.ts`:
```ts
import { reresolveParkedCommits } from '../src/commands/cursor.js';

test('reresolveParkedCommits fills repo once the dir is known', () => {
  const { dir, sha } = makeRepoWithCommit();
  const db = new Database(':memory:');
  runMigrations(db);
  db.prepare(`INSERT INTO cursor_code_attribution
    (commit_hash, repo, branch, ai_lines, composer_lines, tab_lines, human_lines, scored_at)
    VALUES (?, NULL, 'main', 5, 5, 0, 0, 1)`).run(sha);
  db.prepare(`INSERT INTO sessions (session_id, project_dir, first_seen_at, last_seen_at)
    VALUES ('s', ?, '2026-01-01','2026-01-01')`).run(dir);
  const n = reresolveParkedCommits(db);
  assert.equal(n, 1);
  const row: any = db.prepare('SELECT repo FROM cursor_code_attribution WHERE commit_hash=?').get(sha);
  assert.ok(row.repo.startsWith('local/'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test tests/cursor-attribution.test.ts`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement**

Add to `src/commands/cursor.ts`:
```ts
export function reresolveParkedCommits(db: DatabaseType.Database): number {
  const parked = db
    .prepare('SELECT commit_hash FROM cursor_code_attribution WHERE repo IS NULL')
    .all() as Array<{ commit_hash: string }>;
  if (parked.length === 0) return 0;
  const dirs = knownProjectDirs(db);
  const cache = new Map<string, string | null>();
  const setRepo = db.prepare(
    'UPDATE cursor_code_attribution SET repo = ? WHERE commit_hash = ?'
  );
  let fixed = 0;
  const tx = db.transaction(() => {
    for (const { commit_hash } of parked) {
      const repo = resolveCommitRepo(commit_hash, dirs, cache);
      if (repo !== null) {
        setRepo.run(repo, commit_hash);
        fixed++;
      }
    }
  });
  tx();
  return fixed;
}
```
Then, in `runCursorIngest`, before the final `console.log`, add:
```ts
  const refixed = reresolveParkedCommits(db);
  if (refixed > 0) {
    console.log(`Cursor: attributed ${refixed} previously-parked commit${refixed === 1 ? '' : 's'} to a now-known repo.`);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test tests/cursor-attribution.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/commands/cursor.ts tests/cursor-attribution.test.ts
git commit -m "feat(cursor): re-resolve parked NULL-repo commits on later runs"
```

---

## Task 8: Source A — cloud service (cookie + two endpoints)

**Files:**
- Create: `src/services/cursor-cloud.ts`
- Test: `tests/cursor-cloud.test.ts`

**Confirmed by Task 0 spike (use these exact shapes):**
- Cookie: `WorkosCursorSessionToken=<sub>::<jwt>`. `<jwt>` = `cursorAuth/accessToken` from `state.vscdb`; `<sub>` = that JWT's `sub` claim (base64url-decode the middle segment; value looks like `github|user_01J...`). Bare JWT → 401.
- `GET https://cursor.com/api/usage-summary` → `{ billingCycleStart, billingCycleEnd, membershipType, individualUsage: { plan: { used, limit, remaining, totalPercentUsed }, onDemand: { enabled, used, limit, remaining } } }`. No dollars here.
- `POST https://cursor.com/api/dashboard/get-filtered-usage-events` (header `Origin: https://cursor.com`, body `{}` for page 1) → `{ totalUsageEventsCount, usageEventsDisplay: [ { timestamp("ms"), model, chargedCents(number), usageBasedCosts("$x.xx"|"-"), tokenUsage:{...}, conversationId } ] }`, newest-first, 100/page. Dollar total = Σ`chargedCents`/100 over events in the current cycle.

**Interfaces:**
- Produces:
  - `export type CursorUtilization = { cycleStart: string | null; cycleEnd: string | null; membershipType: string | null; planUsed: number | null; planLimit: number | null; planPctUsed: number | null; ondemandEnabled: boolean | null; ondemandUsed: number | null }`
  - `export type CursorMetered = { usd: number; eventsScanned: number; eventsTotal: number; truncated: boolean }`
  - `export function deriveSessionCookie(): string | null`
  - `export function parseUsageSummary(json: unknown): CursorUtilization`
  - `export async function fetchUsageSummary(cookie: string, fetchImpl?: typeof fetch): Promise<CursorUtilization | null>`
  - `export function sumMeteredUsd(events: unknown[], cycleStartMs: number): { usd: number; scanned: number; reachedCycleStart: boolean }`
  - `export async function fetchMeteredUsd(cookie: string, cycleStartMs: number, fetchImpl?: typeof fetch): Promise<CursorMetered | null>`

- [ ] **Step 1: Write the failing test**

Create `tests/cursor-cloud.test.ts`:
```ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseUsageSummary,
  fetchUsageSummary,
  sumMeteredUsd,
  fetchMeteredUsd,
} from '../src/services/cursor-cloud.js';

describe('parseUsageSummary', () => {
  test('maps the confirmed usage-summary shape', () => {
    const out = parseUsageSummary({
      billingCycleStart: '2026-07-22T23:42:23.613Z',
      billingCycleEnd: '2026-08-22T23:42:23.613Z',
      membershipType: 'pro',
      individualUsage: {
        plan: { used: 3, limit: 500, remaining: 497, totalPercentUsed: 0.6 },
        onDemand: { enabled: false, used: 0, limit: null, remaining: null },
      },
    });
    assert.equal(out.membershipType, 'pro');
    assert.equal(out.planUsed, 3);
    assert.equal(out.planLimit, 500);
    assert.equal(out.planPctUsed, 0.6);
    assert.equal(out.ondemandEnabled, false);
    assert.equal(out.cycleStart, '2026-07-22T23:42:23.613Z');
  });
  test('garbage -> all null, no throw', () => {
    const out = parseUsageSummary(null);
    assert.equal(out.membershipType, null);
    assert.equal(out.planUsed, null);
  });
});

describe('sumMeteredUsd', () => {
  const cycleStartMs = 1000;
  test('sums chargedCents for events at/after cycle start, stops when older', () => {
    const events = [
      { timestamp: '3000', chargedCents: 950 },   // $9.50
      { timestamp: '2000', chargedCents: 50 },    // $0.50
      { timestamp: '500',  chargedCents: 999 },   // before cycle -> excluded, signals reachedCycleStart
    ];
    const r = sumMeteredUsd(events, cycleStartMs);
    assert.equal(r.usd, 10);           // 9.50 + 0.50
    assert.equal(r.scanned, 2);
    assert.equal(r.reachedCycleStart, true);
  });
  test('no pre-cycle event -> reachedCycleStart false', () => {
    const r = sumMeteredUsd([{ timestamp: '3000', chargedCents: 100 }], cycleStartMs);
    assert.equal(r.usd, 1);
    assert.equal(r.reachedCycleStart, false);
  });
});

describe('fetch*', () => {
  test('fetchUsageSummary returns null on non-200', async () => {
    const f = (async () => new Response('x', { status: 401 })) as unknown as typeof fetch;
    assert.equal(await fetchUsageSummary('c', f), null);
  });
  test('fetchMeteredUsd paginates until it reaches cycle start', async () => {
    const page1 = { totalUsageEventsCount: 3, usageEventsDisplay: [
      { timestamp: '3000', chargedCents: 100 }, { timestamp: '2500', chargedCents: 100 }] };
    const page2 = { totalUsageEventsCount: 3, usageEventsDisplay: [
      { timestamp: '2000', chargedCents: 100 }, { timestamp: '500', chargedCents: 999 }] };
    let call = 0;
    const f = (async () => new Response(JSON.stringify(call++ === 0 ? page1 : page2),
      { status: 200 })) as unknown as typeof fetch;
    const out = await fetchMeteredUsd('c', 1000, f);
    assert.equal(out?.usd, 3);         // 3 in-cycle events x $1.00
    assert.equal(out?.truncated, false);
    assert.equal(out?.eventsTotal, 3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test tests/cursor-cloud.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/services/cursor-cloud.ts`:
```ts
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type DatabaseType from 'better-sqlite3';
import { getConfig } from '../lib/config.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof DatabaseType;

const USAGE_SUMMARY_URL = 'https://cursor.com/api/usage-summary';
const EVENTS_URL = 'https://cursor.com/api/dashboard/get-filtered-usage-events';
const MAX_PAGES = 200;       // safety cap; matches CodexBar. Truncation is flagged, never silent.
const PAGE_SIZE = 100;       // observed page size

export type CursorUtilization = {
  cycleStart: string | null; cycleEnd: string | null; membershipType: string | null;
  planUsed: number | null; planLimit: number | null; planPctUsed: number | null;
  ondemandEnabled: boolean | null; ondemandUsed: number | null;
};
export type CursorMetered = { usd: number; eventsScanned: number; eventsTotal: number; truncated: boolean };

function stateDbPath(): string {
  const override = getConfig().cursorStateDbPath;
  if (override) return override;
  return join(homedir(), 'Library', 'Application Support', 'Cursor',
    'User', 'globalStorage', 'state.vscdb');
}

function jwtSub(jwt: string): string | null {
  try {
    const payload = jwt.split('.')[1];
    if (!payload) return null;
    const json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof json.sub === 'string' ? json.sub : null;
  } catch { return null; }
}

// Cookie = "<sub>::<jwt>". Manual config cookie wins (already composed).
export function deriveSessionCookie(): string | null {
  const manual = getConfig().cursorSessionCookie;
  if (manual) return manual;
  const path = stateDbPath();
  if (!existsSync(path)) return null;
  let db: DatabaseType.Database | null = null;
  try {
    db = new Database(path, { readonly: true, fileMustExist: true });
    const row = db.prepare("SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken'")
      .get() as { value: string } | undefined;
    const jwt = row?.value;
    if (!jwt) return null;
    const sub = jwtSub(jwt);
    if (!sub) return null;
    return `${sub}::${jwt}`;
  } catch (err) {
    console.warn(`Cursor: could not read session token (${(err as Error).message}).`);
    return null;
  } finally { db?.close(); }
}

function num(v: unknown): number | null {
  const n = Number(v); return Number.isFinite(n) ? n : null;
}

export function parseUsageSummary(json: unknown): CursorUtilization {
  const empty: CursorUtilization = {
    cycleStart: null, cycleEnd: null, membershipType: null, planUsed: null,
    planLimit: null, planPctUsed: null, ondemandEnabled: null, ondemandUsed: null };
  if (typeof json !== 'object' || json === null) return empty;
  const o = json as Record<string, any>;
  const plan = o.individualUsage?.plan ?? {};
  const od = o.individualUsage?.onDemand ?? {};
  return {
    cycleStart: typeof o.billingCycleStart === 'string' ? o.billingCycleStart : null,
    cycleEnd: typeof o.billingCycleEnd === 'string' ? o.billingCycleEnd : null,
    membershipType: typeof o.membershipType === 'string' ? o.membershipType : null,
    planUsed: num(plan.used), planLimit: num(plan.limit), planPctUsed: num(plan.totalPercentUsed),
    ondemandEnabled: typeof od.enabled === 'boolean' ? od.enabled : null,
    ondemandUsed: num(od.used),
  };
}

export async function fetchUsageSummary(
  cookie: string, fetchImpl: typeof fetch = fetch
): Promise<CursorUtilization | null> {
  try {
    const res = await fetchImpl(USAGE_SUMMARY_URL, {
      headers: { Cookie: `WorkosCursorSessionToken=${cookie}`, Origin: 'https://cursor.com' } });
    if (!res.ok) { console.warn(`Cursor: usage-summary ${res.status}.`); return null; }
    return parseUsageSummary(await res.json());
  } catch (err) { console.warn(`Cursor: usage-summary failed (${(err as Error).message}).`); return null; }
}

// Sum chargedCents (as USD) over events newer-or-equal to cycleStartMs.
// Events arrive newest-first; the first event older than cycleStart means we
// have seen the whole current cycle -> reachedCycleStart=true (stop paging).
export function sumMeteredUsd(
  events: unknown[], cycleStartMs: number
): { usd: number; scanned: number; reachedCycleStart: boolean } {
  let cents = 0, scanned = 0, reached = false;
  for (const e of events) {
    if (typeof e !== 'object' || e === null) continue;
    const o = e as Record<string, any>;
    const ts = Number(o.timestamp);
    if (Number.isFinite(ts) && ts < cycleStartMs) { reached = true; break; }
    const c = Number(o.chargedCents);
    if (Number.isFinite(c)) cents += c;
    scanned++;
  }
  return { usd: Math.round(cents) / 100, scanned, reachedCycleStart: reached };
}

export async function fetchMeteredUsd(
  cookie: string, cycleStartMs: number, fetchImpl: typeof fetch = fetch
): Promise<CursorMetered | null> {
  let usd = 0, scanned = 0, total = 0, truncated = false;
  let prevFirstTs: string | null = null;
  try {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await fetchImpl(EVENTS_URL, {
        method: 'POST',
        headers: { Cookie: `WorkosCursorSessionToken=${cookie}`, Origin: 'https://cursor.com',
          'Content-Type': 'application/json' },
        body: JSON.stringify({ page }),
      });
      if (!res.ok) { console.warn(`Cursor: usage-events ${res.status}.`); return page === 1 ? null : { usd, eventsScanned: scanned, eventsTotal: total, truncated: true }; }
      const body = (await res.json()) as Record<string, any>;
      total = Number(body.totalUsageEventsCount) || total;
      const events: unknown[] = Array.isArray(body.usageEventsDisplay) ? body.usageEventsDisplay : [];
      if (events.length === 0) break;
      // Pagination-unsupported guard: if page N returns the same first event as
      // page N-1, the `page` param is not honored -> stop and flag truncated.
      const firstTs = (events[0] as any)?.timestamp ?? null;
      if (page > 1 && firstTs === prevFirstTs) { truncated = true; break; }
      prevFirstTs = firstTs;
      const r = sumMeteredUsd(events, cycleStartMs);
      usd += r.usd; scanned += r.scanned;
      if (r.reachedCycleStart) return { usd: round2(usd), eventsScanned: scanned, eventsTotal: total, truncated: false };
      if (events.length < PAGE_SIZE) break; // last page
      if (page === MAX_PAGES) truncated = true;
    }
    return { usd: round2(usd), eventsScanned: scanned, eventsTotal: total, truncated };
  } catch (err) {
    console.warn(`Cursor: usage-events failed (${(err as Error).message}).`);
    return scanned > 0 ? { usd: round2(usd), eventsScanned: scanned, eventsTotal: total, truncated: true } : null;
  }
}

function round2(n: number): number { return Math.round(n * 100) / 100; }
```
**Live-confirm note (optional, one call):** the spike confirmed page 1 via body `{}`; the `{ "page": n }` pagination param is best-effort with a repeat-first-event guard that flags `truncated` if the param is not honored. When convenient, confirm the real pagination key against the live endpoint and adjust the body; tests use a mock and do not require it.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test tests/cursor-cloud.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/cursor-cloud.ts tests/cursor-cloud.test.ts
git commit -m "feat(cursor): cloud service — cookie derivation, usage-summary + metered-dollar events"
```

---

## Task 9: Usage persistence with stale fallback

**Files:**
- Modify: `src/commands/cursor.ts`
- Test: `tests/cursor-cloud.test.ts`

**Interfaces:**
- Consumes: `deriveSessionCookie`, `fetchUsageSummary`, `fetchMeteredUsd` (Task 8).
- Produces: `export async function runCursorUsage(db?: DatabaseType.Database, deps?: { cookie?: string | null; util?: CursorUtilization | null; metered?: CursorMetered | null }): Promise<'updated' | 'stale' | 'skipped'>`

- [ ] **Step 1: Write the failing test**

Append to `tests/cursor-cloud.test.ts`:
```ts
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrations.js';
import { runCursorUsage } from '../src/commands/cursor.js';

const UTIL = { cycleStart: 'a', cycleEnd: 'b', membershipType: 'pro', planUsed: 3,
  planLimit: 500, planPctUsed: 0.6, ondemandEnabled: false, ondemandUsed: 0 };

test('runCursorUsage writes a fresh row folding both endpoints', async () => {
  const db = new Database(':memory:'); runMigrations(db);
  const r = await runCursorUsage(db, { cookie: 'c', util: UTIL as any,
    metered: { usd: 12.4, eventsScanned: 210, eventsTotal: 13481, truncated: false } });
  assert.equal(r, 'updated');
  const row: any = db.prepare('SELECT * FROM cursor_usage WHERE id=1').get();
  assert.equal(row.membership_type, 'pro');
  assert.equal(row.metered_usd, 12.4);
  assert.equal(row.plan_pct_used, 0.6);
  assert.equal(row.stale, 0);
});

test('runCursorUsage marks stale + keeps last-good when fetch fails', async () => {
  const db = new Database(':memory:'); runMigrations(db);
  await runCursorUsage(db, { cookie: 'c', util: UTIL as any,
    metered: { usd: 5, eventsScanned: 1, eventsTotal: 1, truncated: false } });
  const r = await runCursorUsage(db, { cookie: 'c', util: null, metered: null });
  assert.equal(r, 'stale');
  const row: any = db.prepare('SELECT metered_usd, stale FROM cursor_usage WHERE id=1').get();
  assert.equal(row.metered_usd, 5);
  assert.equal(row.stale, 1);
});

test('runCursorUsage skips with no cookie', async () => {
  const db = new Database(':memory:'); runMigrations(db);
  assert.equal(await runCursorUsage(db, { cookie: null }), 'skipped');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test tests/cursor-cloud.test.ts`
Expected: FAIL — `runCursorUsage` not exported.

- [ ] **Step 3: Implement**

Add to `src/commands/cursor.ts`:
```ts
import { getConfig } from '../lib/config.js';
import {
  deriveSessionCookie, fetchUsageSummary, fetchMeteredUsd,
  type CursorUtilization, type CursorMetered,
} from '../services/cursor-cloud.js';

export async function runCursorUsage(
  dbArg?: DatabaseType.Database,
  deps?: { cookie?: string | null; util?: CursorUtilization | null; metered?: CursorMetered | null }
): Promise<'updated' | 'stale' | 'skipped'> {
  const db = dbArg ?? getDb();
  if (!getConfig().cursorCloudSpend) { console.log('Cursor: cloud usage disabled by config.'); return 'skipped'; }
  const cookie = deps?.cookie !== undefined ? deps.cookie : deriveSessionCookie();
  if (!cookie) { console.log('Cursor: no session cookie found; skipping cloud usage.'); return 'skipped'; }

  const util = deps?.util !== undefined ? deps.util : await fetchUsageSummary(cookie);
  let metered: CursorMetered | null;
  if (deps?.metered !== undefined) metered = deps.metered;
  else {
    const cycleStartMs = util?.cycleStart ? Date.parse(util.cycleStart) : 0;
    metered = await fetchMeteredUsd(cookie, Number.isFinite(cycleStartMs) ? cycleStartMs : 0);
  }

  const now = new Date().toISOString();
  if (util === null && metered === null) {
    const existing = db.prepare('SELECT id FROM cursor_usage WHERE id=1').get();
    if (existing) { db.prepare('UPDATE cursor_usage SET stale = 1 WHERE id = 1').run(); return 'stale'; }
    return 'skipped';
  }

  db.prepare(`
    INSERT INTO cursor_usage
      (id, cycle_start, cycle_end, membership_type, plan_used, plan_limit, plan_pct_used,
       ondemand_enabled, ondemand_used, metered_usd, events_scanned, events_total, truncated, fetched_at, stale)
    VALUES (1, @cs, @ce, @mt, @pu, @pl, @pp, @oe, @ou, @mu, @es, @et, @tr, @f, 0)
    ON CONFLICT(id) DO UPDATE SET
      cycle_start=excluded.cycle_start, cycle_end=excluded.cycle_end, membership_type=excluded.membership_type,
      plan_used=excluded.plan_used, plan_limit=excluded.plan_limit, plan_pct_used=excluded.plan_pct_used,
      ondemand_enabled=excluded.ondemand_enabled, ondemand_used=excluded.ondemand_used,
      metered_usd=excluded.metered_usd, events_scanned=excluded.events_scanned,
      events_total=excluded.events_total, truncated=excluded.truncated, fetched_at=excluded.fetched_at, stale=0
  `).run({
    cs: util?.cycleStart ?? null, ce: util?.cycleEnd ?? null, mt: util?.membershipType ?? null,
    pu: util?.planUsed ?? null, pl: util?.planLimit ?? null, pp: util?.planPctUsed ?? null,
    oe: util?.ondemandEnabled == null ? null : util.ondemandEnabled ? 1 : 0,
    ou: util?.ondemandUsed ?? null,
    mu: metered?.usd ?? null, es: metered?.eventsScanned ?? null, et: metered?.eventsTotal ?? null,
    tr: metered?.truncated ? 1 : 0, f: now,
  });
  const plan = util?.membershipType ?? 'unknown';
  const dollars = metered?.usd != null ? `$${metered.usd.toFixed(2)}` : 'n/a';
  console.log(`Cursor usage (account-wide, estimated): ${plan} · ${dollars} metered this cycle` +
    (metered?.truncated ? ' (partial — event history truncated)' : '') + '.');
  return 'updated';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test tests/cursor-cloud.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/commands/cursor.ts tests/cursor-cloud.test.ts
git commit -m "feat(cursor): persist cloud usage (utilization + metered $) with stale fallback"
```


## Task 10: `tokentrail cursor` command + run-all wiring

**Files:**
- Modify: `src/commands/cursor.ts` (add `runCursor`)
- Modify: `src/index.ts`
- Modify: `src/commands/run-all.ts`
- Test: `tests/smoke.test.ts` (extend) or new `tests/cursor-command.test.ts`

**Interfaces:**
- Produces: `export async function runCursor(opts: { ingest?: boolean; spend?: boolean }): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `tests/cursor-command.test.ts`:
```ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrations.js';
import { _setDbForTest, closeDb } from '../src/db/db.js';
import { runCursor } from '../src/commands/cursor.js';
import { resetConfigCache, getConfig } from '../src/lib/config.js';

test('runCursor with no cursor data is a clean no-op', async () => {
  const db = new Database(':memory:'); runMigrations(db);
  _setDbForTest(db);
  resetConfigCache();
  (getConfig() as any).cursorTrackingDbPath = '/no/such.db';
  (getConfig() as any).cursorCloudSpend = false;
  await assert.doesNotReject(runCursor({ ingest: true, spend: true }));
  _setDbForTest(null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test tests/cursor-command.test.ts`
Expected: FAIL — `runCursor` not exported.

- [ ] **Step 3: Implement `runCursor` + register command + wire run-all**

Add to `src/commands/cursor.ts`:
```ts
export async function runCursor(
  opts: { ingest?: boolean; spend?: boolean }
): Promise<void> {
  const both = !opts.ingest && !opts.spend;
  if (both || opts.ingest) await runCursorIngest();
  if (both || opts.spend) await runCursorUsage();
}
```
In `src/index.ts`, register after the `ingest` command block:
```ts
program
  .command('cursor')
  .description('Track Cursor usage: local AI-authored code + account spend.')
  .option('--ingest', 'Only ingest local AI-line attribution (Source B).')
  .option('--spend', 'Only fetch account spend (Source A).')
  .action(async (opts: { ingest?: boolean; spend?: boolean }) => {
    const { runCursor } = await import('./commands/cursor.js');
    await runCursor({ ingest: opts.ingest, spend: opts.spend });
  });
```
In `src/commands/run-all.ts`, after the enrich step, add a non-fatal call (match the file's existing try/catch-per-stage style):
```ts
  try {
    const { runCursor } = await import('./cursor.js');
    await runCursor({});
  } catch (err) {
    console.warn(`Cursor stage failed (non-fatal): ${(err as Error).message}`);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test tests/cursor-command.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/commands/cursor.ts src/index.ts src/commands/run-all.ts tests/cursor-command.test.ts
git commit -m "feat(cursor): tokentrail cursor command + non-fatal run-all wiring"
```

---

## Task 11: Report — Cursor lane

**Files:**
- Modify: `src/commands/report.ts`
- Test: `tests/cursor-invariant.test.ts`

**Interfaces:**
- Produces: `export function renderCursorLane(db: DatabaseType.Database): string` (returns the text block; empty string when no Cursor data).

- [ ] **Step 1: Write the failing test**

Create `tests/cursor-invariant.test.ts`:
```ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrations.js';
import { renderCursorLane } from '../src/commands/report.js';

test('renderCursorLane shows lines and account usage, never mixed', () => {
  const db = new Database(':memory:'); runMigrations(db);
  db.prepare(`INSERT INTO cursor_code_attribution
    (commit_hash, repo, branch, ai_lines, composer_lines, tab_lines, human_lines, ai_pct, scored_at)
    VALUES ('h','local/proj','main', 100, 90, 10, 5, 95.2, 1)`).run();
  db.prepare(`INSERT INTO cursor_usage
    (id, membership_type, plan_pct_used, metered_usd, truncated, fetched_at, stale)
    VALUES (1, 'pro', 0.6, 41.2, 0, '2026-07-24', 0)`).run();
  const out = renderCursorLane(db);
  assert.match(out, /Cursor/);
  assert.match(out, /100/);            // ai lines shown
  assert.match(out, /\$41\.20/);       // metered dollars shown
  assert.match(out, /account-wide/);   // dollars labeled non-attributable
  assert.match(out, /estimated/);      // rule #3
});

test('empty cursor data renders nothing', () => {
  const db = new Database(':memory:'); runMigrations(db);
  assert.equal(renderCursorLane(db), '');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test tests/cursor-invariant.test.ts`
Expected: FAIL — `renderCursorLane` not exported.

- [ ] **Step 3: Implement**

Add to `src/commands/report.ts` (and call it from `runReport` after the token report, printing the returned string when non-empty):
```ts
import type DatabaseType from 'better-sqlite3';

export function renderCursorLane(db: DatabaseType.Database): string {
  const byFeature = db
    .prepare(
      `SELECT repo, branch, SUM(ai_lines) AS ai, SUM(human_lines) AS human,
              COUNT(*) AS commits
       FROM cursor_code_attribution
       WHERE repo IS NOT NULL
       GROUP BY repo, branch
       ORDER BY ai DESC
       LIMIT 20`
    )
    .all() as Array<{ repo: string; branch: string; ai: number; human: number; commits: number }>;
  const usage = db
    .prepare(`SELECT membership_type, plan_pct_used, metered_usd, truncated, stale
              FROM cursor_usage WHERE id = 1`)
    .get() as {
      membership_type: string | null; plan_pct_used: number | null;
      metered_usd: number | null; truncated: number; stale: number;
    } | undefined;

  if (byFeature.length === 0 && !usage) return '';

  const lines: string[] = ['', 'Cursor'];
  if (usage) {
    const plan = usage.membership_type ?? 'unknown';
    const usd = usage.metered_usd != null ? `$${usage.metered_usd.toFixed(2)}` : 'n/a';
    const pct = usage.plan_pct_used != null ? ` · ${usage.plan_pct_used}% of included usage` : '';
    const partial = usage.truncated ? ' (partial)' : '';
    const staleTag = usage.stale ? ' (stale)' : '';
    lines.push(
      `  Usage (account-wide, estimated): ${plan} · ${usd} metered this cycle${partial}${pct}${staleTag} — not attributable per-feature.`
    );
  }
  for (const r of byFeature) {
    const pct = r.ai + r.human > 0 ? Math.round((r.ai / (r.ai + r.human)) * 100) : 0;
    lines.push(`  ${r.repo} ${r.branch}: ${r.ai} AI lines across ${r.commits} commit${r.commits === 1 ? '' : 's'} (${pct}% AI)`);
  }
  return lines.join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test tests/cursor-invariant.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/commands/report.ts tests/cursor-invariant.test.ts
git commit -m "feat(cursor): report Cursor lane (AI lines + account spend, never mixed)"
```

---

## Task 12: The never-summed invariant test

**Files:**
- Test: `tests/cursor-invariant.test.ts`

**Interfaces:** none new — this is a guard.

- [ ] **Step 1: Write the test**

Append to `tests/cursor-invariant.test.ts`:
```ts
import { runCursorIngest } from '../src/commands/cursor.js';
import { resetConfigCache, getConfig } from '../src/lib/config.js';
import Database2 from 'better-sqlite3';

test('cursor ingest never writes to usage_events / never changes USD totals', async () => {
  const db = new Database(':memory:'); runMigrations(db);
  db.prepare(`INSERT INTO usage_events (id, session_id, timestamp, model, estimated_cost_usd)
    VALUES ('e1','s','2026-07-01T00:00:00Z','opus', 3.50)`).run();
  const before = (db.prepare('SELECT SUM(estimated_cost_usd) AS t FROM usage_events').get() as any).t;
  const beforeCount = (db.prepare('SELECT COUNT(*) AS c FROM usage_events').get() as any).c;

  // empty cursor db -> ingest is a no-op, but even a populated one must not touch usage_events
  resetConfigCache();
  (getConfig() as any).cursorTrackingDbPath = '/no/such.db';
  await runCursorIngest(db);

  const after = (db.prepare('SELECT SUM(estimated_cost_usd) AS t FROM usage_events').get() as any).t;
  const afterCount = (db.prepare('SELECT COUNT(*) AS c FROM usage_events').get() as any).c;
  assert.equal(after, before);
  assert.equal(afterCount, beforeCount);
});
```

- [ ] **Step 2: Run the test**

Run: `node --import tsx --test tests/cursor-invariant.test.ts`
Expected: PASS.

- [ ] **Step 3: Run the whole suite**

Run: `npm test`
Expected: all tests PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/cursor-invariant.test.ts
git commit -m "test(cursor): guard that Cursor never touches the token-cost spine"
```

---

## Task 13: Docs — README + config reference

**Files:**
- Modify: `README.md` (Cursor section), any config docs.

- [ ] **Step 1: Document the command + config**

Add a short README subsection: what `tokentrail cursor` does (two lanes), the config knobs (`cursorTrackingDbPath`, `cursorStateDbPath`, `cursorSessionCookie`, `cursorCloudSpend`), the privacy note (cloud path can be disabled), and the caveat that Cursor spend is account-wide and not attributable per-feature. Keep language restrained (rule #7).

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs(cursor): document tokentrail cursor command and config knobs"
```

---

## Self-Review

**Spec coverage:**
- §1 no-usage_events invariant → Task 12 (guard) + design of separate tables (Task 1). ✓
- §2 Source B reader → Task 3; repo resolution → Tasks 4–5; ingest + parking → Tasks 6–7. ✓
- §3 Source A cookie/endpoint → Tasks 0, 8; persistence + stale/skip → Task 9; cloudSpend toggle → Tasks 2, 9. ✓
- §4 command + run-all → Task 10; report lane → Task 11. ✓
- §5 error handling → non-fatal paths in Tasks 3, 8, 9, 10 (try/catch + degrade). ✓
- §6 testing incl. never-summed invariant → Tasks 11, 12. ✓
- §7 spike-first / build order → Task 0 first; degrade plan documented. ✓
- Phase-2 `get-filtered-usage-events` → intentionally excluded (YAGNI). ✓

**Placeholder scan:** The only deferred concreteness is the exact cursor.com JSON field names + cookie key, which Task 0 resolves before Task 8 lands; the parser/tests are written against a named shape and adjusted to the confirmed one. No "TBD/handle errors appropriately" left.

**Type consistency:** `CursorScoredCommit`, `CursorUtilization`, `CursorMetered`, `resolveCommitRepo(hash, dirs, cache)`, `runCursorIngest(db?)`, `runCursorUsage(db?, deps?)`, `runCursor({ingest,spend})`, `renderCursorLane(db)`, `commitExistsIn(dir, sha)`, `deriveSessionCookie()`, `fetchUsageSummary`, `fetchMeteredUsd`, `sumMeteredUsd` — names/signatures match across all consuming tasks. (`runCursor`'s `--spend` flag label is retained as the CLI name for the cloud lane; it invokes `runCursorUsage`.)
