# Mainline Feature Inference Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the opaque `mainline-<repo>-<branch>` bucket with per-event feature inference driven by conventional commit scope + optional LLM fallback, configurable via a dashboard Settings UI.

**Architecture:** A new `infer-mainline` pass runs between `enrich` and `rollup`. It selects sessions whose `(repo,branch)` maps to a `mainline-*` work-unit, slices each session's `usage_events` by commit timestamps, and writes `inferred_feature_key` per event. Rollup grouping switches to `COALESCE(usage_events.inferred_feature_key, work_units.feature_key)`. A new `src/lib/llm.ts` factory abstracts OpenRouter vs Ollama vs none. Settings persist in `~/Library/Application Support/Tokentrail/settings.json` and are editable via a new `/settings` page in the dashboard.

**Tech Stack:** Node 20+, TypeScript, better-sqlite3, Fastify (dashboard), OpenAI SDK (LLM clients), node:test + tsx (tests), commander (CLI).

## Global Constraints

- All schema changes go through `src/db/schema.ts` (idempotent CREATE / ALTER, run on every startup via `migrations.ts`). Project rule 1.
- Never hardcode API keys. Read from env or `settings.json` only. Project rule 2.
- Attribution logic stays in `src/lib/attribution.ts` for the existing path. Mainline inference is a separate module under `src/services/`. Project rule 5.
- GitHub / Notion / OpenRouter / Ollama failures log cleanly and never crash the pipeline. Project rule 6.
- All cost labels are "estimated". Project rule 3.
- LLM model defaults: OpenRouter `anthropic/claude-haiku-4.5`; Ollama `qwen2.5:3b`.
- Dashboard binds `127.0.0.1` only — confirmed at `src/commands/dashboard.ts:12`. Do not introduce a `--host` flag in this plan.
- Inferred feature_keys follow the same slug rules as `src/lib/attribution.ts:slugify` (lowercase, kebab, ≤80 chars).
- JSONL sources stay read-only. Project rule 9.
- node:test + tsx test pattern as in `tests/*.test.ts`. No new test framework.

---

## File Structure

**New files:**

| Path | Responsibility |
|---|---|
| `src/lib/settings.ts` | Read/write `settings.json`, atomic writes, mode 0600, schema validation. |
| `src/lib/llm.ts` | `getLLMClient()` factory — picks backend from env > settings > auto-detect. |
| `src/services/mainline-inference.ts` | The pass: select sessions, classify commits, slice timeline, write inferred keys, write run row. |
| `src/services/mainline-inference-rules.ts` | Pure `classifyCommit(subject)` (conventional-scope regex). |
| `src/services/mainline-inference-slicing.ts` | Pure `sliceEventsByCommits(commits, events)` — time-window mapping. |
| `src/commands/infer-mainline.ts` | CLI command runner. |
| `src/commands/llm.ts` | CLI subcommands: `tokentrail llm setup|status|test`. |
| `src/dashboard/data/settings.ts` | View-model for `/settings` (loads settings, masks API key). |
| `src/dashboard/render/settings.ts` | HTML render of the settings page. |
| `tests/mainline-inference-rules.test.ts` | Unit tests for `classifyCommit`. |
| `tests/mainline-inference-slicing.test.ts` | Unit tests for `sliceEventsByCommits`. |
| `tests/mainline-inference.test.ts` | Integration tests for the DB pass. |
| `tests/llm.test.ts` | Backend factory + settings precedence tests. |
| `tests/settings.test.ts` | Settings read/write/atomic/mode tests. |
| `tests/dashboard-settings.test.ts` | Endpoint tests via `fastify.inject()`. |

**Modified files:**

| Path | Change |
|---|---|
| `src/db/schema.ts` | Add three columns to `usage_events`, index, `mainline_inference_runs` table. |
| `src/services/clustering.ts` | Replace direct `new OpenAI({...})` with `getLLMClient()`. |
| `src/commands/rollup.ts` | Update SELECT to `COALESCE(e.inferred_feature_key, w.feature_key)`; update GROUP BY; update bucketing priority. |
| `src/commands/run-all.ts` | Insert `infer-mainline` between `enrich` and `rollup`. |
| `src/index.ts` | Register `infer-mainline` and `llm` commands. |
| `src/dashboard/server.ts` | Mount `/settings` page + `/api/settings`, `/api/settings/test` endpoints. |
| `scripts/menubar/tokentrail.1m.sh` | Add `Settings…` menu item under Actions. |
| `tests/clustering.test.ts` | Mock `getLLMClient()` instead of `OpenAI`. |
| `README.md` | Two new sections: LLM backend setup + privacy note. |

---

## Task 1: Schema additions

**Files:**
- Modify: `src/db/schema.ts`
- Test: `tests/clustering.test.ts` (existing migration tests already exercise schema bootstrap)

**Interfaces:**
- Consumes: nothing (idempotent CREATE / ALTER)
- Produces: `usage_events.inferred_feature_key`, `usage_events.inferred_feature_name`, `usage_events.inference_source`; index `idx_usage_events_inferred_feature`; table `mainline_inference_runs(session_id PRIMARY KEY, ran_at, events_relabeled, llm_calls, commit_set_hash)`.

- [ ] **Step 1: Add migration statements**

Edit `src/db/schema.ts` — append to `SCHEMA_STATEMENTS`:

```ts
  // --- Mainline feature inference (2026-06-29 spec) ---
  // ALTER TABLE … ADD COLUMN is idempotent here only because SQLite errors
  // are swallowed by migrations.ts when the column already exists. If
  // migrations.ts changes its error handling, wrap these in a runtime
  // PRAGMA table_info check.
  `ALTER TABLE usage_events ADD COLUMN inferred_feature_key TEXT`,
  `ALTER TABLE usage_events ADD COLUMN inferred_feature_name TEXT`,
  `ALTER TABLE usage_events ADD COLUMN inference_source TEXT`,

  `CREATE INDEX IF NOT EXISTS idx_usage_events_inferred_feature
    ON usage_events (inferred_feature_key)`,

  `CREATE TABLE IF NOT EXISTS mainline_inference_runs (
    session_id        TEXT PRIMARY KEY,
    ran_at            TEXT NOT NULL,
    events_relabeled  INTEGER NOT NULL,
    llm_calls         INTEGER NOT NULL DEFAULT 0,
    commit_set_hash   TEXT NOT NULL
  )`,
```

- [ ] **Step 2: Verify migrations.ts handles ALTER repeats**

Read `src/db/migrations.ts`. If it does NOT swallow "duplicate column" errors, change the three `ALTER TABLE` statements to a one-off runtime check:

```ts
function ensureColumn(db: Database, table: string, column: string, decl: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{name: string}>;
  if (!cols.some(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }
}
```

…and remove the three ALTER strings from `SCHEMA_STATEMENTS`, calling `ensureColumn` from `migrations.ts` after the other CREATEs.

- [ ] **Step 3: Run the existing test suite**

Run: `pnpm test`
Expected: all existing tests pass; schema bootstrap path covered by existing tests via in-memory DBs.

- [ ] **Step 4: Commit**

```bash
git add src/db/schema.ts src/db/migrations.ts
git commit -m "feat(db): add inferred_feature_key columns + mainline_inference_runs"
```

---

## Task 2: Pure `classifyCommit` rule

**Files:**
- Create: `src/services/mainline-inference-rules.ts`
- Test: `tests/mainline-inference-rules.test.ts`

**Interfaces:**
- Consumes: `slugify` from `src/lib/attribution.ts`.
- Produces: `classifyCommit(subject: string): { key: string; name: string; source: 'commit-scope' } | null` — returns null when no conventional scope is present (caller then runs Rule B or C).

- [ ] **Step 1: Write the failing tests**

Create `tests/mainline-inference-rules.test.ts`:

```ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyCommit } from '../src/services/mainline-inference-rules.js';

describe('classifyCommit()', () => {
  test('conventional scope: feat(menubar): X', () => {
    const r = classifyCommit('feat(menubar): visual redesign');
    assert.deepEqual(r, { key: 'menubar', name: 'Menubar', source: 'commit-scope' });
  });

  test('breaking-change bang variant', () => {
    const r = classifyCommit('feat(menubar)!: drop hero title');
    assert.deepEqual(r, { key: 'menubar', name: 'Menubar', source: 'commit-scope' });
  });

  test('no scope: fix: thing → null', () => {
    assert.equal(classifyCommit('fix: broken thing'), null);
  });

  test('non-conventional → null', () => {
    assert.equal(classifyCommit('whatever I did today'), null);
  });

  test('meta-work resolves honestly: chore(release): v0.3', () => {
    const r = classifyCommit('chore(release): v0.3');
    assert.deepEqual(r, { key: 'release', name: 'Release', source: 'commit-scope' });
  });

  test('empty scope → null', () => {
    assert.equal(classifyCommit('feat(): empty'), null);
  });

  test('slash inside scope → slug-normalized', () => {
    const r = classifyCommit('feat(macos/menubar): power off');
    assert.deepEqual(r, { key: 'macos-menubar', name: 'Macos menubar', source: 'commit-scope' });
  });

  test('multi-word scope humanized', () => {
    const r = classifyCommit('refactor(api-client): split');
    assert.deepEqual(r, { key: 'api-client', name: 'Api client', source: 'commit-scope' });
  });
});
```

- [ ] **Step 2: Run the test (it should fail)**

Run: `pnpm test -- --test-name-pattern classifyCommit`
Expected: FAIL — `classifyCommit` is not defined.

- [ ] **Step 3: Implement `classifyCommit`**

Create `src/services/mainline-inference-rules.ts`:

```ts
import { slugify } from '../lib/attribution.js';

const CONVENTIONAL_RE =
  /^(feat|fix|chore|refactor|docs|test|perf|style|build|ci|revert)(?:\(([^)]+)\))?(!)?:\s/i;

export type CommitClassification = {
  key: string;
  name: string;
  source: 'commit-scope';
};

export function classifyCommit(subject: string): CommitClassification | null {
  const m = subject.trim().match(CONVENTIONAL_RE);
  if (!m) return null;
  const scope = (m[2] ?? '').trim();
  if (!scope) return null;
  const key = slugify(scope);
  if (!key) return null;
  return { key, name: humanize(scope), source: 'commit-scope' };
}

function humanize(s: string): string {
  const cleaned = s.replace(/[-_/]+/g, ' ').trim();
  if (!cleaned) return 'Untitled';
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}
```

- [ ] **Step 4: Run the tests (they should pass)**

Run: `pnpm test -- --test-name-pattern classifyCommit`
Expected: PASS (all 8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/mainline-inference-rules.ts tests/mainline-inference-rules.test.ts
git commit -m "feat(infer): classifyCommit conventional-scope rule"
```

---

## Task 3: Pure time-window slicing

**Files:**
- Create: `src/services/mainline-inference-slicing.ts`
- Test: `tests/mainline-inference-slicing.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `sliceEventsByCommits<E extends {timestamp: string}, C extends {sha: string; authoredAt: string}>(events: E[], commits: C[]): Array<{commitSha: string; events: E[]}>` — assigns each event to exactly one commit. Preamble events (before first commit) go to first commit; tail events (after last commit) go to last commit. Returns empty array if `commits.length === 0`.

- [ ] **Step 1: Write the failing tests**

Create `tests/mainline-inference-slicing.test.ts`:

```ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { sliceEventsByCommits } from '../src/services/mainline-inference-slicing.js';

const ev = (ts: string, id = ts) => ({ id, timestamp: ts });
const co = (sha: string, ts: string) => ({ sha, authoredAt: ts });

describe('sliceEventsByCommits()', () => {
  test('empty commits → empty result', () => {
    const out = sliceEventsByCommits([ev('2026-06-29T10:00:00Z')], []);
    assert.deepEqual(out, []);
  });

  test('single commit absorbs all events', () => {
    const events = [ev('2026-06-29T09:00:00Z'), ev('2026-06-29T11:00:00Z')];
    const commits = [co('A', '2026-06-29T10:00:00Z')];
    const out = sliceEventsByCommits(events, commits);
    assert.equal(out.length, 1);
    assert.equal(out[0].commitSha, 'A');
    assert.equal(out[0].events.length, 2);
  });

  test('preamble events route to first commit', () => {
    const events = [ev('2026-06-29T08:00:00Z')];
    const commits = [co('A', '2026-06-29T10:00:00Z'), co('B', '2026-06-29T12:00:00Z')];
    const out = sliceEventsByCommits(events, commits);
    assert.equal(out[0].commitSha, 'A');
    assert.equal(out[0].events[0].id, '2026-06-29T08:00:00Z');
  });

  test('events between commits go to the earlier commit', () => {
    const events = [ev('2026-06-29T11:00:00Z')]; // between A (10:00) and B (12:00)
    const commits = [co('A', '2026-06-29T10:00:00Z'), co('B', '2026-06-29T12:00:00Z')];
    const out = sliceEventsByCommits(events, commits);
    const a = out.find((s) => s.commitSha === 'A');
    assert.equal(a?.events.length, 1);
  });

  test('tail events go to last commit', () => {
    const events = [ev('2026-06-29T13:00:00Z')];
    const commits = [co('A', '2026-06-29T10:00:00Z'), co('B', '2026-06-29T12:00:00Z')];
    const out = sliceEventsByCommits(events, commits);
    const b = out.find((s) => s.commitSha === 'B');
    assert.equal(b?.events.length, 1);
  });

  test('events exactly at commit timestamp belong to that commit (half-open intervals)', () => {
    const events = [ev('2026-06-29T12:00:00Z')];
    const commits = [co('A', '2026-06-29T10:00:00Z'), co('B', '2026-06-29T12:00:00Z')];
    const out = sliceEventsByCommits(events, commits);
    const b = out.find((s) => s.commitSha === 'B');
    assert.equal(b?.events.length, 1);
  });

  test('commits arrive in any order — output is sorted by authoredAt', () => {
    const events = [ev('2026-06-29T11:00:00Z')];
    const commits = [co('B', '2026-06-29T12:00:00Z'), co('A', '2026-06-29T10:00:00Z')];
    const out = sliceEventsByCommits(events, commits);
    assert.equal(out[0].commitSha, 'A');
    assert.equal(out[1].commitSha, 'B');
  });

  test('commits with no events get empty slice (still returned)', () => {
    const events: Array<{ id: string; timestamp: string }> = [];
    const commits = [co('A', '2026-06-29T10:00:00Z')];
    const out = sliceEventsByCommits(events, commits);
    assert.equal(out.length, 1);
    assert.equal(out[0].events.length, 0);
  });
});
```

- [ ] **Step 2: Run the tests (they should fail)**

Run: `pnpm test -- --test-name-pattern sliceEventsByCommits`
Expected: FAIL — function not defined.

- [ ] **Step 3: Implement `sliceEventsByCommits`**

Create `src/services/mainline-inference-slicing.ts`:

```ts
export function sliceEventsByCommits<
  E extends { timestamp: string },
  C extends { sha: string; authoredAt: string },
>(events: E[], commits: C[]): Array<{ commitSha: string; events: E[] }> {
  if (commits.length === 0) return [];
  const sorted = [...commits].sort((a, b) =>
    a.authoredAt < b.authoredAt ? -1 : a.authoredAt > b.authoredAt ? 1 : 0
  );
  const slices: Array<{ commitSha: string; events: E[] }> = sorted.map((c) => ({
    commitSha: c.sha,
    events: [],
  }));

  for (const e of events) {
    // Find the index of the first commit whose authoredAt > event.timestamp.
    // Event belongs to the commit BEFORE that index (or the last commit if
    // no such index exists). Preamble events (before commit 0) go to slice 0.
    let idx = sorted.findIndex((c) => c.authoredAt > e.timestamp);
    if (idx === -1) idx = sorted.length; // tail
    const target = Math.max(0, idx - 1);
    slices[target].events.push(e);
  }

  // Preamble (events earlier than first commit) were assigned to target 0
  // by the loop above. But a literal event-before-first-commit would have
  // idx=0 (first commit comes after it), then target=max(0, -1)=0. Good.
  return slices;
}
```

- [ ] **Step 4: Run the tests (they should pass)**

Run: `pnpm test -- --test-name-pattern sliceEventsByCommits`
Expected: PASS (all 8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/mainline-inference-slicing.ts tests/mainline-inference-slicing.test.ts
git commit -m "feat(infer): sliceEventsByCommits time-window mapping"
```

---

## Task 4: Settings storage + LLM backend factory

**Files:**
- Create: `src/lib/settings.ts`
- Create: `src/lib/llm.ts`
- Test: `tests/settings.test.ts`
- Test: `tests/llm.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `readSettings(): Settings` and `writeSettings(s: Settings): void` from `settings.ts`. `Settings` shape:

    ```ts
    export type LLMBackend = 'openrouter' | 'ollama' | 'none' | 'auto';
    export type Settings = {
      llm: {
        backend: LLMBackend;
        openrouter: { apiKey: string | null; model: string };
        ollama: { baseUrl: string; model: string };
      };
    };
    export function settingsPath(): string;
    export function readSettings(): Settings;
    export function writeSettings(next: Settings): void;
    ```

  - `getLLMClient(): LLMClient | null` from `llm.ts` where:

    ```ts
    export type LLMClient = {
      backend: 'openrouter' | 'ollama';
      model: string;
      client: OpenAI;
    };
    ```

- [ ] **Step 1: Write settings tests**

Create `tests/settings.test.ts`:

```ts
import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSettings, writeSettings, settingsPath, _setSettingsDirForTest } from '../src/lib/settings.js';

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'tokentrail-settings-'));
  _setSettingsDirForTest(tmp);
});
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); _setSettingsDirForTest(null); });

describe('settings', () => {
  test('readSettings returns defaults when file missing', () => {
    const s = readSettings();
    assert.equal(s.llm.backend, 'auto');
    assert.equal(s.llm.openrouter.model, 'anthropic/claude-haiku-4.5');
    assert.equal(s.llm.ollama.model, 'qwen2.5:3b');
    assert.equal(s.llm.ollama.baseUrl, 'http://localhost:11434/v1');
    assert.equal(s.llm.openrouter.apiKey, null);
  });

  test('writeSettings persists and round-trips', () => {
    const next = {
      llm: {
        backend: 'ollama' as const,
        openrouter: { apiKey: 'sk-or-test', model: 'anthropic/claude-haiku-4.5' },
        ollama: { baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:7b' },
      },
    };
    writeSettings(next);
    const s = readSettings();
    assert.deepEqual(s, next);
  });

  test('writeSettings creates file with mode 0600', () => {
    writeSettings(readSettings());
    const p = settingsPath();
    assert.equal(existsSync(p), true);
    // On macOS/Linux check mode bits. Skip on Windows (stat.mode is fake).
    if (process.platform !== 'win32') {
      const mode = statSync(p).mode & 0o777;
      assert.equal(mode, 0o600);
    }
  });

  test('writeSettings is atomic (temp file then rename)', () => {
    writeSettings(readSettings());
    const p = settingsPath();
    const stray = p + '.tmp';
    assert.equal(existsSync(stray), false, 'temp file should not survive');
  });

  test('readSettings on malformed JSON throws a clear error', () => {
    require('node:fs').mkdirSync(tmp, { recursive: true });
    require('node:fs').writeFileSync(settingsPath(), '{not json', 'utf8');
    assert.throws(() => readSettings(), /settings\.json.*invalid/i);
  });
});
```

- [ ] **Step 2: Implement `src/lib/settings.ts`**

```ts
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';

export type LLMBackend = 'openrouter' | 'ollama' | 'none' | 'auto';

export type Settings = {
  llm: {
    backend: LLMBackend;
    openrouter: { apiKey: string | null; model: string };
    ollama: { baseUrl: string; model: string };
  };
};

const DEFAULTS: Settings = {
  llm: {
    backend: 'auto',
    openrouter: { apiKey: null, model: 'anthropic/claude-haiku-4.5' },
    ollama: { baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:3b' },
  },
};

let testDir: string | null = null;
/** Test hook — production code should never call this. */
export function _setSettingsDirForTest(dir: string | null): void {
  testDir = dir;
}

export function settingsDir(): string {
  if (testDir) return testDir;
  if (platform() === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Tokentrail');
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  return join(xdg && xdg.trim() ? xdg : join(homedir(), '.config'), 'tokentrail');
}

export function settingsPath(): string {
  return join(settingsDir(), 'settings.json');
}

export function readSettings(): Settings {
  const path = settingsPath();
  if (!existsSync(path)) return structuredClone(DEFAULTS);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    throw new Error(`settings.json unreadable at ${path}: ${(e as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`settings.json invalid JSON at ${path}: ${(e as Error).message}`);
  }
  return mergeWithDefaults(parsed);
}

export function writeSettings(next: Settings): void {
  const path = settingsPath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + '.tmp';
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
  if (process.platform !== 'win32') chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

function mergeWithDefaults(parsed: unknown): Settings {
  const merged = structuredClone(DEFAULTS);
  if (!parsed || typeof parsed !== 'object') return merged;
  const llm = (parsed as { llm?: unknown }).llm;
  if (llm && typeof llm === 'object') {
    const l = llm as Record<string, any>;
    if (l.backend && ['openrouter','ollama','none','auto'].includes(l.backend)) {
      merged.llm.backend = l.backend;
    }
    if (l.openrouter && typeof l.openrouter === 'object') {
      if (typeof l.openrouter.apiKey === 'string') merged.llm.openrouter.apiKey = l.openrouter.apiKey;
      if (typeof l.openrouter.model === 'string') merged.llm.openrouter.model = l.openrouter.model;
    }
    if (l.ollama && typeof l.ollama === 'object') {
      if (typeof l.ollama.baseUrl === 'string') merged.llm.ollama.baseUrl = l.ollama.baseUrl;
      if (typeof l.ollama.model === 'string') merged.llm.ollama.model = l.ollama.model;
    }
  }
  return merged;
}
```

- [ ] **Step 3: Run the settings tests (they should pass)**

Run: `pnpm test -- --test-name-pattern 'settings'`
Expected: PASS (5 tests).

- [ ] **Step 4: Write LLM factory tests**

Create `tests/llm.test.ts`:

```ts
import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getLLMClient, _setOllamaReachableForTest } from '../src/lib/llm.js';
import { _setSettingsDirForTest, writeSettings } from '../src/lib/settings.js';

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'tokentrail-llm-'));
  _setSettingsDirForTest(tmp);
  _setOllamaReachableForTest(null);
  delete process.env.TOKENTRAIL_LLM_BACKEND;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_MODEL;
  delete process.env.OLLAMA_BASE_URL;
  delete process.env.OLLAMA_MODEL;
});
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); _setSettingsDirForTest(null); _setOllamaReachableForTest(null); });

describe('getLLMClient()', () => {
  test('backend=none returns null', () => {
    process.env.TOKENTRAIL_LLM_BACKEND = 'none';
    assert.equal(getLLMClient(), null);
  });

  test('backend=openrouter without API key returns null', () => {
    process.env.TOKENTRAIL_LLM_BACKEND = 'openrouter';
    assert.equal(getLLMClient(), null);
  });

  test('backend=openrouter with env API key returns OpenAI client', () => {
    process.env.TOKENTRAIL_LLM_BACKEND = 'openrouter';
    process.env.OPENROUTER_API_KEY = 'sk-or-test';
    const c = getLLMClient();
    assert.equal(c?.backend, 'openrouter');
    assert.equal(c?.model, 'anthropic/claude-haiku-4.5');
  });

  test('backend=openrouter with settings.json API key returns client', () => {
    writeSettings({
      llm: {
        backend: 'openrouter',
        openrouter: { apiKey: 'sk-or-from-file', model: 'anthropic/claude-haiku-4.5' },
        ollama: { baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:3b' },
      },
    });
    const c = getLLMClient();
    assert.equal(c?.backend, 'openrouter');
  });

  test('backend=ollama returns client without contacting network', () => {
    process.env.TOKENTRAIL_LLM_BACKEND = 'ollama';
    const c = getLLMClient();
    assert.equal(c?.backend, 'ollama');
    assert.equal(c?.model, 'qwen2.5:3b');
  });

  test('auto: ollama reachable wins', () => {
    process.env.TOKENTRAIL_LLM_BACKEND = 'auto';
    _setOllamaReachableForTest(true);
    process.env.OPENROUTER_API_KEY = 'sk-or-test';
    const c = getLLMClient();
    assert.equal(c?.backend, 'ollama');
  });

  test('auto: no ollama, openrouter key set → openrouter', () => {
    process.env.TOKENTRAIL_LLM_BACKEND = 'auto';
    _setOllamaReachableForTest(false);
    process.env.OPENROUTER_API_KEY = 'sk-or-test';
    const c = getLLMClient();
    assert.equal(c?.backend, 'openrouter');
  });

  test('auto: nothing available → null', () => {
    process.env.TOKENTRAIL_LLM_BACKEND = 'auto';
    _setOllamaReachableForTest(false);
    assert.equal(getLLMClient(), null);
  });

  test('env OPENROUTER_MODEL override respected', () => {
    process.env.TOKENTRAIL_LLM_BACKEND = 'openrouter';
    process.env.OPENROUTER_API_KEY = 'sk-or-test';
    process.env.OPENROUTER_MODEL = 'anthropic/claude-sonnet-4-6';
    assert.equal(getLLMClient()?.model, 'anthropic/claude-sonnet-4-6');
  });
});
```

- [ ] **Step 5: Implement `src/lib/llm.ts`**

```ts
import OpenAI from 'openai';
import { readSettings, type LLMBackend } from './settings.js';

export type LLMClient = {
  backend: 'openrouter' | 'ollama';
  model: string;
  client: OpenAI;
};

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

let ollamaReachableOverride: boolean | null = null;
/** Test hook only. */
export function _setOllamaReachableForTest(v: boolean | null): void {
  ollamaReachableOverride = v;
}

export function getLLMClient(): LLMClient | null {
  const settings = readSettings();
  const backend = resolveBackend(settings.llm.backend);

  if (backend === 'openrouter') {
    const apiKey = process.env.OPENROUTER_API_KEY ?? settings.llm.openrouter.apiKey;
    if (!apiKey) return null;
    const model = process.env.OPENROUTER_MODEL ?? settings.llm.openrouter.model;
    return {
      backend: 'openrouter',
      model,
      client: new OpenAI({ apiKey, baseURL: OPENROUTER_BASE_URL }),
    };
  }
  if (backend === 'ollama') {
    const baseURL = process.env.OLLAMA_BASE_URL ?? settings.llm.ollama.baseUrl;
    const model = process.env.OLLAMA_MODEL ?? settings.llm.ollama.model;
    return {
      backend: 'ollama',
      model,
      // Ollama's OpenAI-compatible endpoint ignores apiKey but the SDK
      // requires a non-empty string.
      client: new OpenAI({ apiKey: 'ollama', baseURL }),
    };
  }
  return null;
}

function resolveBackend(setting: LLMBackend): 'openrouter' | 'ollama' | 'none' {
  const envOverride = process.env.TOKENTRAIL_LLM_BACKEND as LLMBackend | undefined;
  const choice = envOverride ?? setting;
  if (choice === 'openrouter' || choice === 'ollama') return choice;
  if (choice === 'none') return 'none';
  // auto
  if (ollamaReachableOverride === true) return 'ollama';
  if (ollamaReachableOverride === false) {
    return process.env.OPENROUTER_API_KEY ? 'openrouter' : 'none';
  }
  // Live probe (synchronous-ish via short fetch with AbortController)
  return probeOllamaThenOpenRouter();
}

function probeOllamaThenOpenRouter(): 'openrouter' | 'ollama' | 'none' {
  const url = (process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434/v1').replace(/\/v1\/?$/, '');
  const reachable = probeUrl(`${url}/api/tags`, 250);
  if (reachable) return 'ollama';
  if (process.env.OPENROUTER_API_KEY) return 'openrouter';
  return 'none';
}

function probeUrl(url: string, timeoutMs: number): boolean {
  // Use the synchronous spawn pattern from node:net — but since this is
  // hot path and bg fetch is async, we cheat: do an async probe but
  // resolve before any other LLM-needing code runs. For the test
  // injection point above we use the override. In production the first
  // call after process start does a one-time blocking probe.
  try {
    const ctrl = new AbortController();
    const id = setTimeout(() => ctrl.abort(), timeoutMs);
    // node:test environment doesn't have global fetch sync, so we use a
    // synchronous net check via dns lookup as a cheap heuristic.
    const u = new URL(url);
    const port = Number(u.port || '80');
    // require('node:net') sync connect attempt
    const net = require('node:net') as typeof import('node:net');
    return new Promise<boolean>((resolve) => {
      const sock = net.createConnection({ host: u.hostname, port, timeout: timeoutMs });
      let done = false;
      sock.once('connect', () => { if (!done) { done = true; sock.destroy(); resolve(true); } });
      sock.once('error', () => { if (!done) { done = true; resolve(false); } });
      sock.once('timeout', () => { if (!done) { done = true; sock.destroy(); resolve(false); } });
    }) as unknown as boolean; // not actually sync — see fallback below
  } catch {
    return false;
  }
  // NOTE: the async-as-sync above can't actually be synchronous in JS.
  // Implementer: replace the probe with a CACHED async probe done at
  // module load (top-level await is available because tsx supports it),
  // OR force the user to pick a backend explicitly (skip auto-detect).
  // The test hook _setOllamaReachableForTest avoids this complexity
  // entirely in tests.
}
```

NOTE TO IMPLEMENTER: the `probeUrl` synchronous approximation above is sketchy. Pick ONE of these resolutions:

  - **A. Drop "auto" backend.** Make `auto` resolve to `openrouter` if `OPENROUTER_API_KEY` set, else `none`. No live Ollama probe. User explicitly picks `ollama` in settings to enable it. **Recommended** — keeps `getLLMClient()` synchronous and well-tested.
  - **B. Top-level async probe.** `getLLMClient` becomes async; everything that calls it becomes async. Larger refactor.
  - **C. Cached probe with module-level init.** Probe once at process start in `init.ts` and stash result in a module variable.

Implement **A**: rewrite `resolveBackend` so `auto` does no network probe, just chooses openrouter if key present else none. Drop `probeUrl` and `probeOllamaThenOpenRouter` entirely. Update the test `'auto: ollama reachable wins'` to reflect the new contract: with `auto` and no explicit ollama backend, ollama is NOT chosen — change that test to verify openrouter wins when key present, ollama only when explicitly selected.

- [ ] **Step 6: Apply resolution A**

Replace the body of `resolveBackend` with:

```ts
function resolveBackend(setting: LLMBackend): 'openrouter' | 'ollama' | 'none' {
  const envOverride = process.env.TOKENTRAIL_LLM_BACKEND as LLMBackend | undefined;
  const choice = envOverride ?? setting;
  if (choice === 'openrouter' || choice === 'ollama') return choice;
  if (choice === 'none') return 'none';
  // auto: no network probe — pick openrouter if key set, else none.
  // Users wanting ollama must select it explicitly in settings.
  if (process.env.OPENROUTER_API_KEY || readSettings().llm.openrouter.apiKey) {
    return 'openrouter';
  }
  return 'none';
}
```

Update `tests/llm.test.ts`:

```ts
  test('auto with openrouter key set → openrouter', () => {
    process.env.TOKENTRAIL_LLM_BACKEND = 'auto';
    process.env.OPENROUTER_API_KEY = 'sk-or-test';
    assert.equal(getLLMClient()?.backend, 'openrouter');
  });

  test('auto with no key → null', () => {
    process.env.TOKENTRAIL_LLM_BACKEND = 'auto';
    assert.equal(getLLMClient(), null);
  });
```

Delete the test `'auto: ollama reachable wins'` and `_setOllamaReachableForTest` from the test setup.

Update `src/lib/llm.ts` to remove `_setOllamaReachableForTest`, `probeUrl`, `probeOllamaThenOpenRouter`, the `node:net` require, and the corresponding lines in `tests/llm.test.ts`.

- [ ] **Step 7: Run all llm tests**

Run: `pnpm test -- --test-name-pattern 'getLLMClient|settings'`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/lib/settings.ts src/lib/llm.ts tests/settings.test.ts tests/llm.test.ts
git commit -m "feat(llm): settings storage + backend factory (openrouter, ollama, none)"
```

---

## Task 5: Refactor `clustering.ts` to use `getLLMClient()`

**Files:**
- Modify: `src/services/clustering.ts:53-66` (API key check + `new OpenAI(...)` block)
- Modify: `tests/clustering.test.ts` (replace direct OpenAI mock with `getLLMClient` mock)

**Interfaces:**
- Consumes: `getLLMClient` from `src/lib/llm.ts` (Task 4).
- Produces: unchanged public surface of `clustering.ts`.

- [ ] **Step 1: Replace the OpenAI instantiation in clustering.ts**

Edit `src/services/clustering.ts`. Replace the API-key check block (the part that reads `process.env.OPENROUTER_API_KEY` and constructs `new OpenAI(...)`) with:

```ts
import { getLLMClient } from '../lib/llm.js';

// ... inside recomputeClusters():
const llm = getLLMClient();
if (!llm) {
  console.log(
    'No LLM backend configured. Run `tokentrail llm setup` (or set OPENROUTER_API_KEY) to enable topic clustering.'
  );
  return summary;
}
const model = llm.model;
const client = llm.client;
```

Delete the `DEFAULT_MODEL`, `OPENROUTER_BASE_URL`, and the `new OpenAI({apiKey, baseURL: OPENROUTER_BASE_URL})` lines they replace.

- [ ] **Step 2: Update `tests/clustering.test.ts`**

Find any test that mocks `OpenAI` directly. Replace with a mock of `getLLMClient` using `node:test` mock helpers or a small DI shim. If the existing tests don't exercise the LLM call (only the early-return when no key), update them to set `TOKENTRAIL_LLM_BACKEND=none` and assert the same skip behavior.

- [ ] **Step 3: Run clustering tests**

Run: `pnpm test -- --test-name-pattern clustering`
Expected: PASS.

- [ ] **Step 4: Run full test suite to catch regressions**

Run: `pnpm test`
Expected: PASS (everything that passed before still passes).

- [ ] **Step 5: Commit**

```bash
git add src/services/clustering.ts tests/clustering.test.ts
git commit -m "refactor(clustering): consume getLLMClient instead of direct OpenAI"
```

---

## Task 6: Mainline-inference DB pass (Rule A + C only)

**Files:**
- Create: `src/services/mainline-inference.ts`
- Test: `tests/mainline-inference.test.ts`

**Interfaces:**
- Consumes: `classifyCommit` (Task 2), `sliceEventsByCommits` (Task 3). The Database type is `better-sqlite3.Database` as elsewhere in the codebase.
- Produces:

  ```ts
  export type MainlineInferenceDeps = {
    getLLMClient: typeof import('../lib/llm.js').getLLMClient;
  };
  export type MainlineInferenceSummary = {
    sessionsConsidered: number;
    sessionsRelabeled: number;
    eventsRelabeled: number;
    llmCalls: number;
  };
  export async function inferMainlineFeatures(
    db: Database,
    deps?: MainlineInferenceDeps
  ): Promise<MainlineInferenceSummary>;
  ```

**DI seam:** `getLLMClient` is injected via the `deps` parameter so Task 7's tests can pass a fake. Default `deps = { getLLMClient: (await import('../lib/llm.js')).getLLMClient }` — production callers pass nothing.

This task implements RULE A (commit-scope) and RULE C (no-signal) only. RULE B (LLM) lands in Task 7.

- [ ] **Step 1: Write integration tests**

Create `tests/mainline-inference.test.ts`:

```ts
import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { applyMigrations } from '../src/db/migrations.js';
import { inferMainlineFeatures } from '../src/services/mainline-inference.js';

type DB = ReturnType<typeof Database>;

function seed(db: DB) {
  // Mainline work_unit
  db.exec(`
    INSERT INTO work_units (id, repo, branch, feature_key, feature_name, first_seen_at, last_seen_at, status)
    VALUES ('w1', 'octo/tokentrail', 'main', 'mainline-octo-tokentrail-main', 'tokentrail (main)',
            '2026-06-29T09:00:00Z', '2026-06-29T13:00:00Z', 'active');
  `);
  // Non-mainline work_unit (should be ignored)
  db.exec(`
    INSERT INTO work_units (id, repo, branch, feature_key, feature_name, first_seen_at, last_seen_at, status)
    VALUES ('w2', 'octo/tokentrail', 'feat/x', 'cool-thing', 'Cool thing',
            '2026-06-29T09:00:00Z', '2026-06-29T10:00:00Z', 'active');
  `);
  db.exec(`
    INSERT INTO sessions (session_id, title, project_dir, first_seen_at, last_seen_at)
    VALUES ('s1', 'work on menubar then marketing', '/x', '2026-06-29T09:00:00Z', '2026-06-29T13:00:00Z'),
           ('s2', 'override session', '/y', '2026-06-29T09:00:00Z', '2026-06-29T10:00:00Z'),
           ('s3', 'no-commits session', '/z', '2026-06-29T09:00:00Z', '2026-06-29T10:00:00Z');
    UPDATE sessions SET feature_override = 'explicit-feature' WHERE session_id = 's2';
  `);
}

function makeDb(): DB {
  const db = new Database(':memory:');
  applyMigrations(db);
  return db;
}

describe('inferMainlineFeatures()', () => {
  test('single-commit session: all events get the same key', async () => {
    const db = makeDb();
    seed(db);
    db.exec(`
      INSERT INTO session_commits (session_id, commit_sha, subject, authored_at)
      VALUES ('s1', 'sha1', 'feat(menubar): redesign', '2026-06-29T10:00:00Z');
      INSERT INTO usage_events (id, session_id, timestamp, repo, branch, model, estimated_cost_usd)
      VALUES ('e1', 's1', '2026-06-29T09:30:00Z', 'octo/tokentrail', 'main', 'claude-sonnet', 0.5),
             ('e2', 's1', '2026-06-29T11:00:00Z', 'octo/tokentrail', 'main', 'claude-sonnet', 0.5);
    `);
    const summary = await inferMainlineFeatures(db);
    assert.equal(summary.sessionsRelabeled, 1);
    const rows = db.prepare(`SELECT id, inferred_feature_key FROM usage_events WHERE session_id='s1' ORDER BY id`).all() as Array<{id: string; inferred_feature_key: string}>;
    assert.deepEqual(rows.map(r => r.inferred_feature_key), ['menubar', 'menubar']);
  });

  test('multi-scope split by time window', async () => {
    const db = makeDb();
    seed(db);
    db.exec(`
      INSERT INTO session_commits (session_id, commit_sha, subject, authored_at) VALUES
        ('s1', 'a', 'feat(menubar): X', '2026-06-29T10:00:00Z'),
        ('s1', 'b', 'feat(marketing): Y', '2026-06-29T12:00:00Z');
      INSERT INTO usage_events (id, session_id, timestamp, repo, branch, model, estimated_cost_usd) VALUES
        ('pre',  's1', '2026-06-29T09:30:00Z', 'octo/tokentrail', 'main', 'm', 0.1),
        ('mid',  's1', '2026-06-29T11:00:00Z', 'octo/tokentrail', 'main', 'm', 0.1),
        ('tail', 's1', '2026-06-29T12:30:00Z', 'octo/tokentrail', 'main', 'm', 0.1);
    `);
    await inferMainlineFeatures(db);
    const r = db.prepare(`SELECT id, inferred_feature_key FROM usage_events WHERE session_id='s1'`).all() as Array<{id:string;inferred_feature_key:string}>;
    const map = Object.fromEntries(r.map(x => [x.id, x.inferred_feature_key]));
    assert.equal(map.pre, 'menubar', 'preamble → first commit');
    assert.equal(map.mid, 'menubar', 'between A and B → A');
    assert.equal(map.tail, 'marketing', 'tail → last commit');
  });

  test('feature_override short-circuits — no inference written', async () => {
    const db = makeDb();
    seed(db);
    db.exec(`
      INSERT INTO session_commits (session_id, commit_sha, subject, authored_at) VALUES
        ('s2', 'a', 'feat(menubar): X', '2026-06-29T10:00:00Z');
      INSERT INTO usage_events (id, session_id, timestamp, repo, branch, model, estimated_cost_usd) VALUES
        ('e', 's2', '2026-06-29T09:30:00Z', 'octo/tokentrail', 'main', 'm', 0.1);
    `);
    await inferMainlineFeatures(db);
    const r = db.prepare(`SELECT inferred_feature_key FROM usage_events WHERE session_id='s2'`).get() as {inferred_feature_key: string | null};
    assert.equal(r.inferred_feature_key, null);
  });

  test('non-mainline work_units are skipped', async () => {
    const db = makeDb();
    seed(db);
    db.exec(`
      INSERT INTO session_commits (session_id, commit_sha, subject, authored_at) VALUES
        ('s3', 'a', 'feat(menubar): X', '2026-06-29T10:00:00Z');
      INSERT INTO usage_events (id, session_id, timestamp, repo, branch, model, estimated_cost_usd) VALUES
        ('e', 's3', '2026-06-29T09:30:00Z', 'octo/tokentrail', 'feat/x', 'm', 0.1);
    `);
    await inferMainlineFeatures(db);
    const r = db.prepare(`SELECT inferred_feature_key FROM usage_events WHERE session_id='s3'`).get() as {inferred_feature_key: string | null};
    assert.equal(r.inferred_feature_key, null);
  });

  test('session with no commits and no LLM → no-signal feature', async () => {
    const db = makeDb();
    seed(db);
    db.exec(`
      INSERT INTO usage_events (id, session_id, timestamp, repo, branch, model, estimated_cost_usd) VALUES
        ('e', 's3', '2026-06-29T09:30:00Z', 'octo/tokentrail', 'main', 'm', 0.1);
    `);
    process.env.TOKENTRAIL_LLM_BACKEND = 'none';
    await inferMainlineFeatures(db);
    const r = db.prepare(`SELECT inferred_feature_key, inference_source FROM usage_events WHERE session_id='s3'`).get() as {inferred_feature_key: string; inference_source: string};
    assert.equal(r.inferred_feature_key, 'uncategorized-mainline');
    assert.equal(r.inference_source, 'no-signal');
  });

  test('second run with unchanged commit_set_hash is a no-op', async () => {
    const db = makeDb();
    seed(db);
    db.exec(`
      INSERT INTO session_commits (session_id, commit_sha, subject, authored_at) VALUES
        ('s1', 'a', 'feat(menubar): X', '2026-06-29T10:00:00Z');
      INSERT INTO usage_events (id, session_id, timestamp, repo, branch, model, estimated_cost_usd) VALUES
        ('e', 's1', '2026-06-29T09:30:00Z', 'octo/tokentrail', 'main', 'm', 0.1);
    `);
    const first = await inferMainlineFeatures(db);
    const second = await inferMainlineFeatures(db);
    assert.equal(first.sessionsRelabeled, 1);
    assert.equal(second.sessionsRelabeled, 0);
  });
});
```

- [ ] **Step 2: Run the tests (they should fail — module doesn't exist)**

Run: `pnpm test -- --test-name-pattern inferMainlineFeatures`
Expected: FAIL (module not found / cannot find module).

- [ ] **Step 3: Implement `src/services/mainline-inference.ts` (Rules A + C only)**

```ts
import { createHash } from 'node:crypto';
import type DatabaseType from 'better-sqlite3';
import { classifyCommit } from './mainline-inference-rules.js';
import { sliceEventsByCommits } from './mainline-inference-slicing.js';

export type MainlineInferenceSummary = {
  sessionsConsidered: number;
  sessionsRelabeled: number;
  eventsRelabeled: number;
  llmCalls: number;
};

type SessionRow = { session_id: string; title: string | null };
type CommitRow = { session_id: string; sha: string; subject: string; authored_at: string };
type EventRow = { id: string; timestamp: string };

export async function inferMainlineFeatures(
  db: DatabaseType.Database
): Promise<MainlineInferenceSummary> {
  const summary: MainlineInferenceSummary = {
    sessionsConsidered: 0,
    sessionsRelabeled: 0,
    eventsRelabeled: 0,
    llmCalls: 0,
  };

  // Sessions to process: at least one mainline-bucket event, no override.
  const sessions = db.prepare(`
    SELECT DISTINCT s.session_id AS session_id, s.title AS title
    FROM usage_events e
    JOIN work_units w ON w.repo = e.repo AND w.branch = e.branch
    JOIN sessions s ON s.session_id = e.session_id
    WHERE w.feature_key GLOB 'mainline-*'
      AND (s.feature_override IS NULL OR s.feature_override = '')
  `).all() as SessionRow[];

  summary.sessionsConsidered = sessions.length;

  const getCommits = db.prepare(`
    SELECT commit_sha AS sha, subject, authored_at
    FROM session_commits
    WHERE session_id = ?
    ORDER BY authored_at ASC
  `);
  const getEvents = db.prepare(`
    SELECT e.id AS id, e.timestamp AS timestamp
    FROM usage_events e
    JOIN work_units w ON w.repo = e.repo AND w.branch = e.branch
    WHERE e.session_id = ? AND w.feature_key GLOB 'mainline-*'
    ORDER BY e.timestamp ASC
  `);
  const getRun = db.prepare(`
    SELECT commit_set_hash FROM mainline_inference_runs WHERE session_id = ?
  `);
  const upsertRun = db.prepare(`
    INSERT INTO mainline_inference_runs (session_id, ran_at, events_relabeled, llm_calls, commit_set_hash)
    VALUES (@session_id, @ran_at, @events_relabeled, @llm_calls, @commit_set_hash)
    ON CONFLICT(session_id) DO UPDATE SET
      ran_at = excluded.ran_at,
      events_relabeled = excluded.events_relabeled,
      llm_calls = excluded.llm_calls,
      commit_set_hash = excluded.commit_set_hash
  `);
  const updateEvent = db.prepare(`
    UPDATE usage_events
       SET inferred_feature_key = @key,
           inferred_feature_name = @name,
           inference_source = @source
     WHERE id = @id
  `);

  for (const s of sessions) {
    const commits = getCommits.all(s.session_id) as Array<{
      sha: string; subject: string; authored_at: string;
    }>;
    const hash = hashCommitSet(commits.map((c) => c.sha));
    const prev = getRun.get(s.session_id) as { commit_set_hash: string } | undefined;
    if (prev && prev.commit_set_hash === hash) continue; // short-circuit

    const events = getEvents.all(s.session_id) as EventRow[];
    if (events.length === 0) continue;

    let labeled = 0;
    db.transaction(() => {
      if (commits.length === 0) {
        // No commits → fall to Rule C uncategorized (LLM lands in Task 7).
        for (const e of events) {
          updateEvent.run({
            id: e.id,
            key: 'uncategorized-mainline',
            name: 'Uncategorized mainline',
            source: 'no-signal',
          });
          labeled++;
        }
      } else {
        const slices = sliceEventsByCommits(
          events,
          commits.map((c) => ({ sha: c.sha, authoredAt: c.authored_at }))
        );
        // Build sha→classification map (Rule A first).
        const classBySha = new Map<string, { key: string; name: string; source: string }>();
        for (const c of commits) {
          const r = classifyCommit(c.subject);
          if (r) classBySha.set(c.sha, r);
          else classBySha.set(c.sha, {
            key: 'uncategorized-mainline',
            name: 'Uncategorized mainline',
            source: 'no-signal',
          });
        }
        for (const slice of slices) {
          const cls = classBySha.get(slice.commitSha)!;
          for (const e of slice.events) {
            updateEvent.run({
              id: e.id,
              key: cls.key,
              name: cls.name,
              source: cls.source,
            });
            labeled++;
          }
        }
      }
      upsertRun.run({
        session_id: s.session_id,
        ran_at: new Date().toISOString(),
        events_relabeled: labeled,
        llm_calls: 0,
        commit_set_hash: hash,
      });
    })();

    if (labeled > 0) summary.sessionsRelabeled++;
    summary.eventsRelabeled += labeled;
  }

  return summary;
}

function hashCommitSet(shas: string[]): string {
  const h = createHash('sha256');
  for (const sha of [...shas].sort()) h.update(sha);
  return h.digest('hex');
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm test -- --test-name-pattern inferMainlineFeatures`
Expected: PASS (6 tests). If the seed inserts violate NOT NULL constraints on `usage_events` (input_tokens/output_tokens default to 0 already — verify in `src/db/schema.ts`), add the missing columns to the seed inserts.

- [ ] **Step 5: Commit**

```bash
git add src/services/mainline-inference.ts tests/mainline-inference.test.ts
git commit -m "feat(infer): mainline-inference pass (Rule A + C, no LLM yet)"
```

---

## Task 7: Add Rule B (LLM fallback)

**Files:**
- Modify: `src/services/mainline-inference.ts` (add LLM call inside the per-session transaction)
- Modify: `tests/mainline-inference.test.ts` (add LLM-mocked test)

**Interfaces:**
- Consumes: `getLLMClient` from `src/lib/llm.ts` (Task 4).
- Produces: same `MainlineInferenceSummary` shape with `llmCalls` populated.

- [ ] **Step 1: Add a failing test for Rule B**

Add to `tests/mainline-inference.test.ts`:

```ts
import { mock } from 'node:test';

test('Rule B: non-conventional commit subjects get LLM-named features', async () => {
  const db = makeDb();
  seed(db);
  db.exec(`
    INSERT INTO session_commits (session_id, commit_sha, subject, authored_at) VALUES
      ('s1', 'a', 'whatever I did today', '2026-06-29T10:00:00Z'),
      ('s1', 'b', 'more progress on the thing', '2026-06-29T12:00:00Z');
    INSERT INTO usage_events (id, session_id, timestamp, repo, branch, model, estimated_cost_usd) VALUES
      ('e1', 's1', '2026-06-29T11:00:00Z', 'octo/tokentrail', 'main', 'm', 0.1),
      ('e2', 's1', '2026-06-29T12:30:00Z', 'octo/tokentrail', 'main', 'm', 0.1);
  `);

  const fakeClient = {
    backend: 'openrouter' as const,
    model: 'anthropic/claude-haiku-4.5',
    client: {
      chat: {
        completions: {
          create: mock.fn(async () => ({
            choices: [{ message: { content: JSON.stringify({
              labels: [
                { commit_sha: 'a', topic_slug: 'menubar-rework' },
                { commit_sha: 'b', topic_slug: 'menubar-rework' },
              ],
            })}}],
          })),
        },
      },
    } as any,
  };
  const summary = await inferMainlineFeatures(db, { getLLMClient: () => fakeClient });
  assert.equal(summary.llmCalls, 1);
  const rows = db.prepare(`SELECT inferred_feature_key, inference_source FROM usage_events WHERE session_id='s1'`).all() as Array<{inferred_feature_key:string; inference_source:string}>;
  assert.ok(rows.every(r => r.inferred_feature_key === 'menubar-rework'));
  assert.ok(rows.every(r => r.inference_source === 'session-title-llm'));
});

test('Rule B malformed response → falls to no-signal, summary.llmCalls still 1', async () => {
  const db = makeDb();
  seed(db);
  db.exec(`
    INSERT INTO session_commits (session_id, commit_sha, subject, authored_at) VALUES
      ('s1', 'a', 'whatever I did today', '2026-06-29T10:00:00Z');
    INSERT INTO usage_events (id, session_id, timestamp, repo, branch, model, estimated_cost_usd) VALUES
      ('e1', 's1', '2026-06-29T11:00:00Z', 'octo/tokentrail', 'main', 'm', 0.1);
  `);
  const fakeClient = {
    backend: 'openrouter' as const,
    model: 'anthropic/claude-haiku-4.5',
    client: { chat: { completions: { create: mock.fn(async () => ({ choices: [{ message: { content: 'not json' }}]})) }} } as any,
  };

  const summary = await inferMainlineFeatures(db, { getLLMClient: () => fakeClient });
  assert.equal(summary.llmCalls, 1);
  const r = db.prepare(`SELECT inferred_feature_key, inference_source FROM usage_events WHERE session_id='s1'`).get() as {inferred_feature_key:string; inference_source:string};
  assert.equal(r.inferred_feature_key, 'uncategorized-mainline');
  assert.equal(r.inference_source, 'no-signal');
});
```

- [ ] **Step 2: Run the new tests (expected fail — LLM not yet wired)**

Run: `pnpm test -- --test-name-pattern 'Rule B'`
Expected: FAIL — `llmCalls` is 0, no LLM is invoked.

- [ ] **Step 3: Wire Rule B into the pass**

Edit `src/services/mainline-inference.ts`:

```ts
import { getLLMClient as defaultGetLLMClient } from '../lib/llm.js';
import { slugify } from '../lib/attribution.js';

// Change the function signature to accept optional deps:
//   export async function inferMainlineFeatures(
//     db: DatabaseType.Database,
//     deps: MainlineInferenceDeps = { getLLMClient: defaultGetLLMClient }
//   ): Promise<MainlineInferenceSummary>

// Inside inferMainlineFeatures, BEFORE the for-loop:
const llm = deps.getLLMClient();
// We'll reuse the same client for all sessions in this run; cheaper than
// per-session connect.

// Inside the per-session block, replace the Rule-A fallback:
// REPLACE the simple `if (r) ... else uncategorized-mainline` with:

const unresolved: Array<{ sha: string; subject: string }> = [];
for (const c of commits) {
  const r = classifyCommit(c.subject);
  if (r) classBySha.set(c.sha, r);
  else unresolved.push({ sha: c.sha, subject: c.subject });
}

if (unresolved.length > 0 && llm) {
  summary.llmCalls++;
  try {
    const resp = await llm.client.chat.completions.create({
      model: llm.model,
      messages: [
        {
          role: 'system',
          content: 'You label engineering work by topic. Output STRICT JSON only matching schema {"labels":[{"commit_sha":string,"topic_slug":string}]}. Slugs are kebab-case, ≤30 chars, no commit-type words (feat/fix/chore/refactor/docs/test/perf/style/build/ci/revert).',
        },
        {
          role: 'user',
          content: JSON.stringify({
            session_title: s.title ?? '',
            commits: unresolved.slice(0, 80).map((c) => ({ sha: c.sha, subject: c.subject })),
          }),
        },
      ],
      response_format: { type: 'json_object' },
      max_tokens: 800,
    });
    const content = resp.choices[0]?.message?.content ?? '';
    const parsed = JSON.parse(content) as { labels?: Array<{ commit_sha: string; topic_slug: string }> };
    if (Array.isArray(parsed.labels)) {
      for (const lbl of parsed.labels) {
        const key = slugify(lbl.topic_slug ?? '');
        if (!key) continue;
        classBySha.set(lbl.commit_sha, {
          key,
          name: humanizeFromSlug(key),
          source: 'session-title-llm',
        });
      }
    }
  } catch (e) {
    console.log(
      `[infer-mainline] LLM call failed for session ${s.session_id}: ${(e as Error).message}`
    );
  }
}

// Final fallback for any commit still unresolved:
for (const c of commits) {
  if (!classBySha.has(c.sha)) {
    classBySha.set(c.sha, {
      key: 'uncategorized-mainline',
      name: 'Uncategorized mainline',
      source: 'no-signal',
    });
  }
}
```

Add helper at bottom of file:

```ts
function humanizeFromSlug(slug: string): string {
  const s = slug.replace(/-/g, ' ').trim();
  if (!s) return 'Uncategorized';
  return s.charAt(0).toUpperCase() + s.slice(1);
}
```

Also: extend the no-commits path to call the LLM with session title only. Replace the "if (commits.length === 0)" branch with:

```ts
if (commits.length === 0) {
  let cls = {
    key: 'uncategorized-mainline',
    name: 'Uncategorized mainline',
    source: 'no-signal' as const,
  };
  if (llm) {
    summary.llmCalls++;
    try {
      const resp = await llm.client.chat.completions.create({
        model: llm.model,
        messages: [
          { role: 'system', content: 'Pick a single kebab-case topic_slug (≤30 chars) for this engineering session. STRICT JSON: {"topic_slug":string}' },
          { role: 'user', content: JSON.stringify({ session_title: s.title ?? '' }) },
        ],
        response_format: { type: 'json_object' },
        max_tokens: 200,
      });
      const parsed = JSON.parse(resp.choices[0]?.message?.content ?? '') as { topic_slug?: string };
      const key = slugify(parsed.topic_slug ?? '');
      if (key) cls = { key, name: humanizeFromSlug(key), source: 'session-title-llm' };
    } catch (e) {
      console.log(`[infer-mainline] LLM call failed (no-commits) for ${s.session_id}: ${(e as Error).message}`);
    }
  }
  for (const e of events) {
    updateEvent.run({ id: e.id, key: cls.key, name: cls.name, source: cls.source });
    labeled++;
  }
}
```

- [ ] **Step 4: Run all mainline-inference tests**

Run: `pnpm test -- --test-name-pattern 'inferMainlineFeatures|Rule B'`
Expected: PASS (all 8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/mainline-inference.ts tests/mainline-inference.test.ts
git commit -m "feat(infer): Rule B LLM fallback with malformed-response handling"
```

---

## Task 8: Update rollup to consume `inferred_feature_key`

**Files:**
- Modify: `src/commands/rollup.ts:24-79` (the SELECT + bucketing block)
- Test: extend an existing rollup test if one exists, or add a small in-memory test asserting that an `inferred_feature_key` overrides the work_units key.

**Interfaces:**
- Consumes: `usage_events.inferred_feature_key` written by Task 6/7.
- Produces: `feature_rollups` rows keyed by inferred feature when present, otherwise work_units feature.

- [ ] **Step 1: Update the SELECT in `runRollup`**

In `src/commands/rollup.ts`, change the SELECT body. Replace:

```sql
w.feature_key                            AS feature_key,
w.feature_name                           AS feature_name,
```

with:

```sql
COALESCE(e.inferred_feature_key, w.feature_key)   AS feature_key,
COALESCE(e.inferred_feature_name, w.feature_name) AS feature_name,
```

Update the GROUP BY accordingly:

```sql
GROUP BY date(e.timestamp, 'localtime'), e.repo, e.branch, e.project_dir,
         COALESCE(e.inferred_feature_key, w.feature_key),
         COALESCE(e.inferred_feature_name, w.feature_name),
         s.feature_override, s.feature_override_name
```

No change to the in-JS bucketing — `r.feature_key` / `r.feature_name` now already reflect the COALESCE.

- [ ] **Step 2: Confirm or add a rollup test**

Search for `tests/rollup.test.ts` or similar. If none exists, add a minimal `tests/rollup-inferred.test.ts`:

```ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { applyMigrations } from '../src/db/migrations.js';

describe('runRollup COALESCE', () => {
  test('inferred_feature_key wins over work_units.feature_key', async () => {
    const db = new Database(':memory:');
    applyMigrations(db);
    // setDb so runRollup uses our in-memory connection.
    const dbModule = await import('../src/db/db.js');
    (dbModule as any).setDb?.(db);

    db.exec(`
      INSERT INTO work_units (id, repo, branch, feature_key, feature_name, first_seen_at, last_seen_at)
      VALUES ('w','octo/x','main','mainline-octo-x-main','x (main)','2026-06-29T09:00:00Z','2026-06-29T10:00:00Z');
      INSERT INTO sessions (session_id, title, first_seen_at, last_seen_at)
      VALUES ('s','t','2026-06-29T09:00:00Z','2026-06-29T10:00:00Z');
      INSERT INTO usage_events
        (id, session_id, timestamp, repo, branch, model, estimated_cost_usd, inferred_feature_key, inferred_feature_name)
      VALUES
        ('e','s','2026-06-29T09:30:00Z','octo/x','main','m',0.5,'menubar','Menubar');
    `);

    const { runRollup } = await import('../src/commands/rollup.js');
    await runRollup();

    const row = db.prepare(`SELECT feature_key, feature_name, total_cost_usd FROM feature_rollups`).get() as any;
    assert.equal(row.feature_key, 'menubar');
    assert.equal(row.feature_name, 'Menubar');
  });
});
```

If `src/db/db.ts` doesn't expose a `setDb` test hook, add one (a single setter that lets tests inject a Database instance and resets between tests). Look for an existing seam — many tests already need one; reuse it.

- [ ] **Step 3: Run rollup tests**

Run: `pnpm test -- --test-name-pattern 'runRollup'`
Expected: PASS.

- [ ] **Step 4: Run full test suite**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/commands/rollup.ts tests/rollup-inferred.test.ts src/db/db.ts
git commit -m "feat(rollup): prefer inferred_feature_key over work_units.feature_key"
```

---

## Task 9: CLI command + `run-all` integration

**Files:**
- Create: `src/commands/infer-mainline.ts`
- Modify: `src/commands/run-all.ts`
- Modify: `src/index.ts` (register the command)

**Interfaces:**
- Consumes: `inferMainlineFeatures` (Tasks 6/7).
- Produces: `tokentrail infer-mainline` CLI; new step in `run-all`.

- [ ] **Step 1: Create `src/commands/infer-mainline.ts`**

```ts
import { getDb } from '../db/db.js';
import { inferMainlineFeatures } from '../services/mainline-inference.js';

export type InferMainlineOptions = {
  dryRun?: boolean;
};

export async function runInferMainline(opts: InferMainlineOptions = {}): Promise<void> {
  const db = getDb();
  if (opts.dryRun) {
    console.log('Dry-run mode not yet implemented; aborting without writes.');
    return;
  }
  const t0 = Date.now();
  const summary = await inferMainlineFeatures(db);
  const seconds = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `Infer-mainline: considered ${summary.sessionsConsidered}, relabeled ${summary.sessionsRelabeled} sessions (${summary.eventsRelabeled} events), LLM calls ${summary.llmCalls}. ${seconds}s.`
  );
}
```

(NOTE: `--repo`, `--since`, `--force` from the spec are deferred. The pass-level short-circuit covers re-run safety; per-repo/per-time filtering can be added later without affecting any callers.)

- [ ] **Step 2: Register the command in `src/index.ts`**

After the existing `enrich` command block, add:

```ts
program
  .command('infer-mainline')
  .description('Infer per-feature attribution for work on mainline branches.')
  .option('--dry-run', 'Print what would change without writing.')
  .action(async (opts: { dryRun?: boolean }) => {
    const { runInferMainline } = await import('./commands/infer-mainline.js');
    await runInferMainline({ dryRun: opts.dryRun });
  });
```

- [ ] **Step 3: Insert into `run-all`**

Edit `src/commands/run-all.ts`. After the `enrich` block, before `rollup`:

```ts
if (!opts.skipEnrich) {
  console.log('\n→ enrich');
  await runEnrich();
}

console.log('\n→ infer-mainline');
const { runInferMainline } = await import('./infer-mainline.js');
await runInferMainline();

console.log('\n→ rollup');
await runRollup();
```

- [ ] **Step 4: Smoke-test the CLI**

Run: `pnpm tokentrail infer-mainline`
Expected: prints a summary line with zero or more relabeled sessions. Does not throw.

Run: `pnpm tokentrail` (no args)
Expected: `infer-mainline` appears in `--help` output.

- [ ] **Step 5: Run the test suite**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/commands/infer-mainline.ts src/commands/run-all.ts src/index.ts
git commit -m "feat(cli): add infer-mainline command and wire into run-all"
```

---

## Task 10: `tokentrail llm` CLI + README updates

**Files:**
- Create: `src/commands/llm.ts`
- Modify: `src/index.ts` (register `llm` command)
- Modify: `README.md` (LLM setup + privacy note)

**Interfaces:**
- Consumes: `readSettings`, `writeSettings` from `src/lib/settings.ts`; `getLLMClient` from `src/lib/llm.ts`.
- Produces: `tokentrail llm status`, `tokentrail llm test`, `tokentrail llm setup`.

- [ ] **Step 1: Create `src/commands/llm.ts`**

```ts
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { readSettings, writeSettings, settingsPath } from '../lib/settings.js';
import { getLLMClient } from '../lib/llm.js';

export async function runLlmStatus(): Promise<void> {
  const s = readSettings();
  const c = getLLMClient();
  console.log(`Settings: ${settingsPath()}`);
  console.log(`Backend setting:  ${s.llm.backend}`);
  console.log(`Effective backend: ${c?.backend ?? 'none'}`);
  if (c) console.log(`Model: ${c.model}`);
  if (s.llm.openrouter.apiKey || process.env.OPENROUTER_API_KEY) {
    console.log('OpenRouter API key: set');
  } else {
    console.log('OpenRouter API key: (none)');
  }
  console.log(`Ollama URL: ${s.llm.ollama.baseUrl}`);
}

export async function runLlmTest(): Promise<void> {
  const c = getLLMClient();
  if (!c) {
    console.error('No LLM backend configured. Run `tokentrail llm setup`.');
    process.exitCode = 1;
    return;
  }
  const t0 = Date.now();
  try {
    const r = await c.client.chat.completions.create({
      model: c.model,
      messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
      max_tokens: 5,
    });
    const ms = Date.now() - t0;
    console.log(`OK ${c.backend}/${c.model} in ${ms}ms → ${r.choices[0]?.message?.content?.trim()}`);
  } catch (e) {
    console.error(`FAIL ${c.backend}/${c.model}: ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

export async function runLlmSetup(): Promise<void> {
  const s = readSettings();
  const rl = createInterface({ input: stdin, output: stdout });
  console.log('\nLLM backend for topic inference + clustering.');
  console.log('  ollama     local, free, private');
  console.log('  openrouter cloud (third-party LLM); sends commit subjects + session titles off-device');
  console.log('  none       deterministic rules only');
  const choice = (await rl.question(`Choose [ollama/openrouter/none] (current: ${s.llm.backend}): `)).trim() || s.llm.backend;
  if (!['ollama', 'openrouter', 'none', 'auto'].includes(choice)) {
    console.error(`Invalid choice: ${choice}`);
    process.exitCode = 1;
    rl.close();
    return;
  }
  s.llm.backend = choice as typeof s.llm.backend;

  if (choice === 'openrouter') {
    const cur = s.llm.openrouter.apiKey ? '(stored)' : '(none)';
    const key = (await rl.question(`OpenRouter API key ${cur}: `)).trim();
    if (key) s.llm.openrouter.apiKey = key;
    const model = (await rl.question(`Model (current: ${s.llm.openrouter.model}): `)).trim();
    if (model) s.llm.openrouter.model = model;
  }
  if (choice === 'ollama') {
    const url = (await rl.question(`Ollama base URL (current: ${s.llm.ollama.baseUrl}): `)).trim();
    if (url) s.llm.ollama.baseUrl = url;
    const model = (await rl.question(`Model (current: ${s.llm.ollama.model}): `)).trim();
    if (model) s.llm.ollama.model = model;
  }
  rl.close();
  writeSettings(s);
  console.log(`\nSaved → ${settingsPath()}`);
  await runLlmStatus();
}
```

- [ ] **Step 2: Register `llm` command in `src/index.ts`**

Add after the `infer-mainline` block:

```ts
const llm = program.command('llm').description('Configure the LLM backend for topic inference.');

llm.command('status').description('Show current LLM backend + model.').action(async () => {
  const { runLlmStatus } = await import('./commands/llm.js');
  await runLlmStatus();
});

llm.command('test').description('Send a one-token ping to the configured backend.').action(async () => {
  const { runLlmTest } = await import('./commands/llm.js');
  await runLlmTest();
});

llm.command('setup').description('Interactive backend setup.').action(async () => {
  const { runLlmSetup } = await import('./commands/llm.js');
  await runLlmSetup();
});
```

- [ ] **Step 3: README updates**

Find the existing "Setup" / "Configuration" section in `README.md`. Add a subsection:

```markdown
## LLM backend (optional)

Topic inference for work-on-`main` and session clustering both benefit from a
small LLM. Tokentrail supports two backends:

- **Ollama** (recommended) — local, free, private. Commit subjects and session
  titles stay on your machine.

      brew install ollama
      ollama pull qwen2.5:3b
      tokentrail llm setup           # pick "ollama"

- **OpenRouter** — cloud; sends commit subjects + session titles to a
  third-party LLM. Cheap (Haiku is ≈ $0.001 / session) but not private.

      tokentrail llm setup           # pick "openrouter", paste key

- **none** — deterministic rules only. Still useful: conventional commit
  scopes (`feat(menubar): …`) become features without any LLM.

Settings live in `~/Library/Application Support/Tokentrail/settings.json`
(macOS) or `$XDG_CONFIG_HOME/tokentrail/settings.json` (Linux). You can also
edit them from the dashboard at `http://127.0.0.1:<port>/settings`.

Environment variables (`OPENROUTER_API_KEY`, `OLLAMA_BASE_URL`, `OLLAMA_MODEL`,
`TOKENTRAIL_LLM_BACKEND`) override `settings.json`.
```

- [ ] **Step 4: Smoke-test the new CLI surface**

Run: `pnpm tokentrail llm status`
Expected: prints settings path + current/effective backend.

Run: `pnpm tokentrail llm --help`
Expected: lists `status`, `test`, `setup`.

- [ ] **Step 5: Commit**

```bash
git add src/commands/llm.ts src/index.ts README.md
git commit -m "feat(cli): tokentrail llm setup/status/test + README setup notes"
```

---

## Task 11: Dashboard `/settings` page + endpoints

**Files:**
- Create: `src/dashboard/data/settings.ts`
- Create: `src/dashboard/render/settings.ts`
- Modify: `src/dashboard/server.ts` (mount the page + 3 endpoints)
- Test: `tests/dashboard-settings.test.ts`

**Interfaces:**
- Consumes: `readSettings`, `writeSettings`, `settingsPath` (Task 4); `getLLMClient` (Task 4).
- Produces:
  - `GET /settings` → HTML page.
  - `GET  /api/settings` → JSON with masked API key.
  - `POST /api/settings` → JSON body validated, written atomically.
  - `POST /api/settings/test` → `{ backend, model }` → returns `{ ok, latencyMs, error? }`.

- [ ] **Step 1: Write endpoint tests**

Create `tests/dashboard-settings.test.ts`:

```ts
import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServer } from '../src/dashboard/server.js';
import { _setSettingsDirForTest, writeSettings } from '../src/lib/settings.js';

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'td-settings-'));
  _setSettingsDirForTest(tmp);
});
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); _setSettingsDirForTest(null); });

describe('dashboard /api/settings', () => {
  test('GET /api/settings returns defaults with no key', async () => {
    const app = buildServer({ defaultDays: 30 });
    const r = await app.inject({ method: 'GET', url: '/api/settings' });
    assert.equal(r.statusCode, 200);
    const body = r.json();
    assert.equal(body.llm.openrouter.hasKey, false);
    assert.equal(body.llm.openrouter.keyTail, null);
    assert.equal(body.llm.backend, 'auto');
  });

  test('GET /api/settings masks API key with last-4 tail', async () => {
    writeSettings({
      llm: {
        backend: 'openrouter',
        openrouter: { apiKey: 'sk-or-v1-abcdefg1234', model: 'anthropic/claude-haiku-4.5' },
        ollama: { baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:3b' },
      },
    });
    const app = buildServer({ defaultDays: 30 });
    const r = await app.inject({ method: 'GET', url: '/api/settings' });
    const body = r.json();
    assert.equal(body.llm.openrouter.hasKey, true);
    assert.equal(body.llm.openrouter.keyTail, '1234');
    assert.equal(body.llm.openrouter.apiKey, undefined);
  });

  test('POST /api/settings persists', async () => {
    const app = buildServer({ defaultDays: 30 });
    const r = await app.inject({
      method: 'POST',
      url: '/api/settings',
      payload: {
        llm: {
          backend: 'ollama',
          openrouter: { apiKey: null, model: 'anthropic/claude-haiku-4.5' },
          ollama: { baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:7b' },
        },
      },
    });
    assert.equal(r.statusCode, 200);
    const r2 = await app.inject({ method: 'GET', url: '/api/settings' });
    assert.equal(r2.json().llm.backend, 'ollama');
    assert.equal(r2.json().llm.ollama.model, 'qwen2.5:7b');
  });

  test('POST /api/settings rejects malformed body', async () => {
    const app = buildServer({ defaultDays: 30 });
    const r = await app.inject({ method: 'POST', url: '/api/settings', payload: { llm: { backend: 'nonsense' } } });
    assert.equal(r.statusCode, 400);
  });
});
```

- [ ] **Step 2: Implement settings data + render**

Create `src/dashboard/data/settings.ts`:

```ts
import { readSettings } from '../../lib/settings.js';

export type SettingsViewModel = {
  llm: {
    backend: string;
    openrouter: { hasKey: boolean; keyTail: string | null; model: string };
    ollama: { baseUrl: string; model: string };
  };
};

export function buildSettingsVM(): SettingsViewModel {
  const s = readSettings();
  const key = s.llm.openrouter.apiKey ?? null;
  return {
    llm: {
      backend: s.llm.backend,
      openrouter: {
        hasKey: !!key,
        keyTail: key ? key.slice(-4) : null,
        model: s.llm.openrouter.model,
      },
      ollama: { baseUrl: s.llm.ollama.baseUrl, model: s.llm.ollama.model },
    },
  };
}
```

Create `src/dashboard/render/settings.ts`:

```ts
import type { SettingsViewModel } from '../data/settings.js';

export function renderSettings(vm: SettingsViewModel): string {
  return `
<section class="settings">
  <h1>Settings</h1>
  <form id="llm-form">
    <fieldset>
      <legend>LLM backend</legend>
      <label><input type="radio" name="backend" value="auto" ${vm.llm.backend === 'auto' ? 'checked' : ''}> Auto</label>
      <label><input type="radio" name="backend" value="ollama" ${vm.llm.backend === 'ollama' ? 'checked' : ''}> Ollama (local, private)</label>
      <label><input type="radio" name="backend" value="openrouter" ${vm.llm.backend === 'openrouter' ? 'checked' : ''}> OpenRouter (cloud)</label>
      <label><input type="radio" name="backend" value="none" ${vm.llm.backend === 'none' ? 'checked' : ''}> Off</label>
    </fieldset>

    <fieldset>
      <legend>Ollama</legend>
      <label>Base URL <input name="ollama.baseUrl" value="${escapeHtml(vm.llm.ollama.baseUrl)}"></label>
      <label>Model    <input name="ollama.model" value="${escapeHtml(vm.llm.ollama.model)}"></label>
      <button type="button" data-test="ollama">Test</button>
    </fieldset>

    <fieldset>
      <legend>OpenRouter</legend>
      <label>API key  <input name="openrouter.apiKey" type="password" placeholder="${vm.llm.openrouter.hasKey ? '••• …' + vm.llm.openrouter.keyTail : '(none)'}"></label>
      <label>Model    <input name="openrouter.model" value="${escapeHtml(vm.llm.openrouter.model)}"></label>
      <button type="button" data-test="openrouter">Test</button>
    </fieldset>

    <button type="submit">Save</button>
  </form>
  <script src="/static/settings.js"></script>
</section>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
}
```

Also create `src/dashboard/static/settings.js` (vanilla, no framework):

```js
const form = document.getElementById('llm-form');
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(form);
  const body = {
    llm: {
      backend: fd.get('backend'),
      openrouter: {
        apiKey: fd.get('openrouter.apiKey') || null,
        model: fd.get('openrouter.model') || 'anthropic/claude-haiku-4.5',
      },
      ollama: {
        baseUrl: fd.get('ollama.baseUrl') || 'http://localhost:11434/v1',
        model: fd.get('ollama.model') || 'qwen2.5:3b',
      },
    },
  };
  // Preserve existing key if user left the field blank.
  if (!body.llm.openrouter.apiKey) {
    const cur = await (await fetch('/api/settings')).json();
    if (cur.llm.openrouter.hasKey) body.llm.openrouter.apiKey = '__KEEP__';
  }
  const r = await fetch('/api/settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (r.ok) location.reload();
  else alert('Save failed: ' + r.status);
});

document.querySelectorAll('button[data-test]').forEach((b) => {
  b.addEventListener('click', async () => {
    const backend = b.getAttribute('data-test');
    const model = backend === 'ollama'
      ? form.querySelector('input[name="ollama.model"]').value
      : form.querySelector('input[name="openrouter.model"]').value;
    const r = await fetch('/api/settings/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ backend, model }),
    });
    const out = await r.json();
    alert(out.ok ? `OK in ${out.latencyMs}ms` : `Error: ${out.error}`);
  });
});
```

- [ ] **Step 3: Mount endpoints in `src/dashboard/server.ts`**

Add inside `buildServer(...)`:

```ts
import { buildSettingsVM } from './data/settings.js';
import { renderSettings } from './render/settings.js';
import { readSettings, writeSettings, type Settings } from '../lib/settings.js';
import { getLLMClient } from '../lib/llm.js';

app.get('/settings', async (_req, reply) => {
  const vm = buildSettingsVM();
  const body = renderSettings(vm);
  reply.type('text/html; charset=utf-8');
  return renderShell({ title: 'Tokentrail · Settings', activeTab: 'settings', days: opts.defaultDays }, body);
});

app.get('/api/settings', async () => buildSettingsVM());

app.post('/api/settings', async (req, reply) => {
  const body = req.body as Partial<Settings>;
  // Validate backend enum.
  const backend = body?.llm?.backend;
  if (!backend || !['ollama','openrouter','none','auto'].includes(backend)) {
    reply.code(400);
    return { error: 'invalid backend' };
  }
  const current = readSettings();
  const next: Settings = {
    llm: {
      backend,
      openrouter: {
        apiKey: body.llm?.openrouter?.apiKey === '__KEEP__'
          ? current.llm.openrouter.apiKey
          : (body.llm?.openrouter?.apiKey ?? null),
        model: body.llm?.openrouter?.model ?? current.llm.openrouter.model,
      },
      ollama: {
        baseUrl: body.llm?.ollama?.baseUrl ?? current.llm.ollama.baseUrl,
        model: body.llm?.ollama?.model ?? current.llm.ollama.model,
      },
    },
  };
  writeSettings(next);
  return { ok: true };
});

app.post('/api/settings/test', async (req) => {
  const { backend, model } = req.body as { backend: string; model?: string };
  // Temporarily override env so getLLMClient picks the requested backend.
  const prev = process.env.TOKENTRAIL_LLM_BACKEND;
  process.env.TOKENTRAIL_LLM_BACKEND = backend;
  try {
    const c = getLLMClient();
    if (!c) return { ok: false, error: 'backend not configured' };
    const t0 = Date.now();
    await c.client.chat.completions.create({
      model: model ?? c.model,
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 1,
    });
    return { ok: true, latencyMs: Date.now() - t0 };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  } finally {
    if (prev === undefined) delete process.env.TOKENTRAIL_LLM_BACKEND;
    else process.env.TOKENTRAIL_LLM_BACKEND = prev;
  }
});
```

- [ ] **Step 4: Run endpoint tests**

Run: `pnpm test -- --test-name-pattern 'dashboard /api/settings'`
Expected: PASS (4 tests).

- [ ] **Step 5: Smoke test in the browser**

Run: `pnpm tokentrail dashboard --port 5391`
Open: `http://127.0.0.1:5391/settings`
Expected: page renders with three fieldsets (backend, Ollama, OpenRouter). Submitting persists. The Test buttons return alerts. The API key field shows last-4 placeholder when one is saved.

- [ ] **Step 6: Commit**

```bash
git add src/dashboard/data/settings.ts src/dashboard/render/settings.ts src/dashboard/static/settings.js src/dashboard/server.ts tests/dashboard-settings.test.ts
git commit -m "feat(dashboard): /settings page + endpoints with key masking"
```

---

## Task 12: SwiftBar `Settings…` menu item

**Files:**
- Modify: `scripts/menubar/tokentrail.1m.sh`

**Interfaces:**
- Consumes: dashboard port (currently hard-coded or read from launchd plist; check the existing script).
- Produces: a new menu item that opens `http://127.0.0.1:<port>/settings`.

- [ ] **Step 1: Locate the actions section in the SwiftBar plugin**

Open `scripts/menubar/tokentrail.1m.sh`. Find where existing actions are emitted (look for `bash=open` or `href=`).

- [ ] **Step 2: Add the menu item**

Insert near the other actions:

```bash
echo "Settings… | href=http://127.0.0.1:${DASHBOARD_PORT:-5391}/settings"
```

If the existing script reads the port from elsewhere (env file, plist), reuse that variable instead of hard-coding `5391`. If no port variable exists, add `: "${DASHBOARD_PORT:=5391}"` near the top of the script and use it consistently.

- [ ] **Step 3: Reload SwiftBar manually and verify**

Right-click the menubar icon → Refresh. The "Settings…" item should appear under Actions and open the dashboard at `/settings` in the default browser.

- [ ] **Step 4: Commit**

```bash
git add scripts/menubar/tokentrail.1m.sh
git commit -m "feat(menubar): add Settings… menu item linking to dashboard /settings"
```

---

## Self-Review

### Spec coverage check

| Spec section | Implemented in |
|---|---|
| Pipeline position (between enrich + rollup) | Task 9 |
| Inference unit = commit-scope group | Task 2 + Task 6 |
| Time-window split | Task 3 + Task 6 |
| Schema changes (3 columns + table + index) | Task 1 |
| Rollup COALESCE | Task 8 |
| Rule A conventional scope | Task 2 |
| Rule B LLM fallback | Task 7 |
| Rule C uncategorized-mainline | Task 6 |
| Sessions with no commits | Task 7 (LLM-only path) |
| Meta-work (chore(release)) | Task 2 (no filtering) |
| Override interaction (`sessions.feature_override`) | Task 6 (selection clause) |
| LLM backend factory (`src/lib/llm.ts`) | Task 4 |
| Settings precedence (env > settings > defaults) | Task 4 |
| Refactor clustering.ts | Task 5 |
| Privacy posture (README mention) | Task 10 |
| `tokentrail infer-mainline` CLI | Task 9 |
| `run-all` integration | Task 9 |
| Failure handling (no key, HTTP, malformed) | Task 4 (no key) + Task 7 (HTTP + malformed) |
| Settings storage | Task 4 |
| `tokentrail llm` CLI | Task 10 |
| Dashboard /settings page + endpoints | Task 11 |
| Key masking, atomic write, mode 0600 | Task 4 + Task 11 |
| SwiftBar Settings link | Task 12 |
| Tests (rules / slicing / pass / llm / clustering / dashboard) | Tasks 2, 3, 4, 5, 6, 7, 11 |

No gaps.

### Auto-detect resolution

Spec mentions auto-detect of Ollama. Task 4 explicitly drops live Ollama probe to keep `getLLMClient()` synchronous; user must select `ollama` explicitly. This is a deliberate divergence from the spec's "auto-detect" wording — flagging here so reviewer either accepts the simplification or opts into resolution C (cached probe at init time).

### Deferred from spec into open follow-ups

- `--repo`, `--since`, `--force` flags on `tokentrail infer-mainline` (Task 9 note).
- `tokentrail llm pull <model>` Ollama wrapper (spec already lists this as open question; deferred per recommendation).
- Live Ollama auto-detect (see above).
- Dry-run output content for `infer-mainline` (currently stubs out without writes).

### Type-consistency check

- `classifyCommit` returns `{ key, name, source: 'commit-scope' } | null` everywhere.
- `sliceEventsByCommits` produces `{ commitSha, events }[]` — Task 6 destructures `slice.commitSha`, `slice.events` matching.
- `Settings` shape identical in `settings.ts`, `llm.ts`, dashboard endpoint, and test file.
- `inference_source` values `'commit-scope' | 'session-title-llm' | 'no-signal'` used consistently in Tasks 6/7 and tests.

### Placeholder scan

- Task 4 contains a NOTE TO IMPLEMENTER with an explicit resolution (A) and a follow-up step (Step 6) that applies it. This is documentation of a decision, not a placeholder.
- No "TBD" / "TODO" / "fill in details" anywhere.

### Plan-level commit cadence

Each task ends in its own commit. 12 commits expected for completion. Tasks 1, 5, 8, 9 are smaller; 6 and 7 are the heaviest (the inference pass itself).
