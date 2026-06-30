# Mainline feature inference — design

**Date:** 2026-06-29
**Status:** Draft, pending implementation plan
**Owner:** Ben

## Problem

`src/lib/attribution.ts` collapses every event whose branch is `main` /
`master` / `develop` / `staging` into a single `mainline-<repo>-<branch>`
feature_key. Reports, daily Notion digests, and the rollup all read from
that key, so a day of work-on-main shows up as one opaque row — "Mainline
(main): $X" — with no way to see what was actually being built.

The bucket is a leak in the per-feature accounting model. Solo-dev /
trunk-based workflows spend most of their time on `main`, so most of the
spend ends up in this bucket and the rest of Tokentrail's feature-aware
reporting is wasted on it.

The fix is to infer features for mainline events from signals we already
capture (conventional commit scope, session title, optional LLM) and write
a per-event `inferred_feature_key` that the rollup picks up via COALESCE.

Non-goals:

- Inference for non-mainline branches. Those already attribute well via
  PR / branch-prefix / override rules.
- Auto-confirmation UX. Silent reassignment is fine — `feature_overrides`
  and `sessions.feature_override` exist as escape hatches.
- File-path-based inference. Deferred to a follow-up; commit-scope plus
  LLM covers the common case.

## Architecture

### Pipeline position

Add a new pass — `infer-mainline` — between `enrich` and `rollup`:

```
ingest
  └─ commits --backfill
       └─ prs --backfill
            └─ enrich
                 └─ infer-mainline       ← NEW
                      └─ rollup
                           └─ sync
```

Rationale for a separate pass (vs folding into `attribute()`):

- `attribute()` is pure / repo+branch-only by design (project rule 5).
  Inference needs `session_commits`, which doesn't exist at ingest time.
- Non-mainline sessions don't pay any cost.
- Re-runs flip features when a follow-up commit changes the dominant
  scope — natural fit for a separate idempotent pass.

### Inference unit

The unit is **commit-scope group**. The feature_key is the conventional
commit scope, slugified. `fix(menubar):` + `feat(menubar):` +
`refactor(menubar):` all attribute to one feature `menubar` regardless of
how many commits or sessions touched it.

A session that spans multiple scopes is split **proportionally by
time-window**: events between commit N and commit N+1 attribute to
commit N's scope. Events before the first commit attribute to the first
commit's scope; events after the last commit attribute to the last
commit's scope.

## Schema changes

Three new columns on `usage_events`, one new table, no other tables touched.

```sql
ALTER TABLE usage_events ADD COLUMN inferred_feature_key  TEXT;
ALTER TABLE usage_events ADD COLUMN inferred_feature_name TEXT;
ALTER TABLE usage_events ADD COLUMN inference_source      TEXT;
-- inference_source ∈ { 'commit-scope', 'session-title-llm', 'no-signal' }

CREATE INDEX IF NOT EXISTS idx_usage_events_inferred_feature
  ON usage_events (inferred_feature_key);

CREATE TABLE IF NOT EXISTS mainline_inference_runs (
  session_id         TEXT PRIMARY KEY,
  ran_at             TEXT NOT NULL,
  events_relabeled   INTEGER NOT NULL,
  llm_calls          INTEGER NOT NULL DEFAULT 0,
  commit_set_hash    TEXT NOT NULL
);
```

`inferred_feature_key` is NULL on every row at ingest. Only the
`infer-mainline` pass writes to it. The rollup's grouping is amended:

```sql
SELECT
  COALESCE(ue.inferred_feature_key,  wu.feature_key)  AS feature_key,
  COALESCE(ue.inferred_feature_name, wu.feature_name) AS feature_name,
  ...
FROM usage_events ue
JOIN work_units wu USING (repo, branch)
GROUP BY 1, 2, date(ue.timestamp), ue.repo;
```

`mainline_inference_runs.commit_set_hash` mirrors the existing
`feature_cluster_runs` short-circuit pattern (see
`src/services/clustering.ts`): one row per session, hash of that
session's sorted commit SHAs. If the hash matches the latest row for the
session, skip — nothing new to attribute.

Explicitly NOT added:

- No `confidence` column — categorical `inference_source` is enough to
  debug "why was this labeled X".
- No `event_attributions` join table — single-key per event suffices
  because the time-window split assigns each event to exactly one slice.

## Inference rules

### Step 1: slice the session timeline

For each mainline session, sort `session_commits` by `authored_at`. Build
half-open intervals `[prev.authored_at, this.authored_at)`. The first
interval starts at session start (covers preamble); the last extends to
session end (covers tail). Each usage_event falls in exactly one slice;
its inferred_feature_key is the slice's owning commit's feature.

### Step 2: classify each commit

Apply rules in order, stop at first hit:

| Rule | Trigger | feature_key | source |
|---|---|---|---|
| A. Conventional scope | subject matches `^(feat\|fix\|chore\|refactor\|docs\|test\|perf\|style\|build\|ci\|revert)(!?\(([^)]+)\))?(!)?:` and scope group non-empty | `slug(scope)` | `commit-scope` |
| B. LLM fallback | LLM backend configured and Rule A missed | one batched call per session, returns `{commit_sha, topic_slug}` per unresolved commit. Constraint: slug ≤ 30 chars, kebab-case, no commit-type words. | `session-title-llm` |
| C. No signal | LLM unavailable, or returned empty/error | `uncategorized-mainline` | `no-signal` |

`feature_name = humanize(scope)`. Repo is a separate column on
`feature_rollups`, so feature_key does not encode it — matches
PR-titled / branch-prefixed attribution.

### Step 3: sessions with no commits

Run Rule B on session title alone. If LLM unavailable, fall to Rule C.
All events in the session get the same key.

### Meta-work

`chore(release):` legitimately becomes a `release` feature. `deps`,
`ci`, `docs` likewise. Spending $X on releases is real information —
don't filter.

### Override interaction

`sessions.feature_override` (existing column, currently unused as a
reader) short-circuits the whole inference for that session — no events
get `inferred_feature_key` written, no LLM call. The rollup's COALESCE
falls through to `work_units.feature_key`. The override flow remains the
escape hatch.

## LLM backend abstraction

### New module: `src/lib/llm.ts`

Backend-agnostic factory. Both `clustering.ts` (existing) and
`mainline-inference.ts` (new) consume it.

```ts
export type LLMBackend = 'openrouter' | 'ollama' | 'none';

export type LLMClient = {
  backend: LLMBackend;
  model: string;
  client: OpenAI;  // OpenAI SDK works for both via baseURL
};

export function getLLMClient(): LLMClient | null;
```

Selection precedence:

1. Env var (`TOKENTRAIL_LLM_BACKEND` = `openrouter` | `ollama` | `none` | `auto`)
2. `settings.json` (see Settings UI below)
3. Auto-detect — Ollama at `http://localhost:11434/v1` if reachable,
   else OpenRouter if `OPENROUTER_API_KEY` set, else `none`.

`none` is a valid backend — the LLM rule is just unavailable, the
deterministic rule still produces useful labels. Tokentrail works
without an LLM.

### Defaults

- **OpenRouter** — `anthropic/claude-haiku-4.5` (current clustering
  default).
- **Ollama** — `qwen2.5:3b` (small, JSON-mode friendly, runs on 8 GB
  RAM laptops). README documents `llama3.2:3b` and `qwen2.5:7b` as
  alternatives.

### Refactor

`clustering.ts`'s direct `new OpenAI({...})` is replaced with
`getLLMClient()?.client`. ~10 lines changed. Existing "OPENROUTER_API_KEY
not set" message becomes "no LLM backend configured — run `tokentrail llm
setup` to configure".

### Privacy posture

Ollama keeps commit subjects + session titles on-device. OpenRouter
sends them to a third-party LLM. Call this out in both `tokentrail llm
setup` and the README. Default to auto-detect (which prefers local
Ollama if reachable) so the private option wins when both are available.

## Pipeline implementation

### New module: `src/services/mainline-inference.ts` (~200 LOC)

```ts
export async function inferMainlineFeatures(
  db: Database
): Promise<MainlineInferenceSummary>
```

Work selection — sessions where ALL of:

1. At least one `usage_event` whose `(repo, branch)` maps to a
   `work_units` row with `feature_key GLOB 'mainline-*'`.
2. `sessions.feature_override` is NULL.
3. Hash of the session's sorted commit SHAs differs from the row in
   `mainline_inference_runs` for that `session_id` (or no row exists).

Per-session flow (one transaction):

```
load session_commits
  → classify each via Rule A
  → batched Rule B for unresolved commits (if LLM available)
  → Rule C for whatever remains
  → for each commit, compute its slice and:
    UPDATE usage_events
       SET inferred_feature_key  = ?,
           inferred_feature_name = ?,
           inference_source      = ?
     WHERE session_id = ?
       AND timestamp >= ? AND timestamp < ?
  → INSERT INTO mainline_inference_runs (...)
```

### New CLI command: `tokentrail infer-mainline`

Mirrors `enrich` / `commits` / `prs`:

- `--repo <owner/name>` — limit to one repo
- `--since <iso>` — limit to sessions in window
- `--dry-run` — print proposed labels without writing
- `--force` — bypass session-set-hash short-circuit

### Integration with `run-all`

Insert between `enrich` and `rollup` (see Architecture). No reordering
of existing steps.

### Failure handling

Per project rule 6 (clean failure, no pipeline crash):

- No LLM backend configured → log once at pass start, skip Rule B, no
  retries. Pass returns success.
- LLM HTTP error → log per session, fall through to Rule C, continue.
- Malformed LLM response → drop, fall through to Rule C, log once.

## Settings UI

Configuration must not require editing `.env` or running CLI. Add a
`/settings` page to the existing dashboard.

### Storage

`~/Library/Application Support/Tokentrail/settings.json` (macOS),
`$XDG_CONFIG_HOME/tokentrail/settings.json` (Linux). Mode `0600` since
it can hold an API key. Atomic writes via temp-file + rename.

```jsonc
{
  "llm": {
    "backend": "ollama",
    "openrouter": {
      "apiKey": "sk-or-...",
      "model": "anthropic/claude-haiku-4.5"
    },
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "model": "qwen2.5:3b"
    }
  }
}
```

### Precedence (loaded by `src/lib/llm.ts`)

1. Env var
2. `settings.json`
3. Built-in defaults

Project rule 2 — "never hardcode API keys; use .env" — is honored: keys
come from env or from a user-only file the user manages, not from
checked-in code.

### Endpoints (new in `src/dashboard/`)

- `GET  /api/settings` — current effective settings, API key masked
  (server returns `{ hasKey: true, tail: "1234" }` only).
- `POST /api/settings` — body validated against schema, atomic write.
- `POST /api/settings/test` — `{ backend, model }` → one-token ping,
  returns `{ ok, latencyMs, error? }`.

### Page layout

Single `/settings` page, sectioned for future expansion. LLM section
shows both backend cards expanded simultaneously (clearer than
collapsing the inactive one). Radio for `backend`, status pill per card
(`● connected (12 ms ping)` / `● not reachable`), per-card Test button.
Save + Cancel at the bottom. Inline hint when an Ollama model is not
pulled: "Run `ollama pull qwen2.5:3b`".

### Security

- Dashboard is already loopback-bound — `src/commands/dashboard.ts`
  starts Fastify with `host: '127.0.0.1'`. Confirm no override path
  exists before merging the settings endpoints; reject any future
  `--host 0.0.0.0` flag once the dashboard can write keys.
- All settings writes log to `~/Library/Logs/tokentrail-daemon.log` with
  timestamp + changed field names (not key values).

### SwiftBar integration

One new menu item under Actions: `Settings…` → opens
`http://127.0.0.1:<dashboard-port>/settings` in the default browser.
~5 lines in `scripts/menubar/tokentrail.1m.sh`.

### CLI parity

`tokentrail llm setup` (interactive prompts), `tokentrail llm status`,
`tokentrail llm test` stay. Both UIs read/write the same
`settings.json`. CLI for power users, web UI for the common case.

## Testing

Stack: `node:test` + `tsx`, matching existing `tests/*.test.ts`.

### 1. Pure rule tests — `tests/mainline-inference-rules.test.ts`

Extract `classifyCommit(commit, sessionTitle): { key, name, source } | null`.
No DB, no LLM. Cases:

- `feat(menubar): X` → `{menubar, Menubar, commit-scope}`
- `feat(menubar)!: breaking` → `menubar`
- `fix: broken thing` → null (caller decides)
- `whatever I did today` → null
- `chore(release): v0.3` → `release` (meta-work honest)
- empty/whitespace scope → null
- `feat(macos/menubar): X` → `macos-menubar` (slug-normalized)

### 2. Pass-level integration — `tests/mainline-inference.test.ts`

In-memory better-sqlite3, schema via `migrations.ts`. Seed fixtures.
Mock the LLM client at the `getLLMClient()` boundary. Cases:

- single-commit session, conventional scope → all events one key
- multi-commit same scope → one key, no LLM call
- multi-commit multi-scope → time-window split, preamble → first
  commit's key, tail → last commit's key
- session with no commits, title only → Rule B (mocked) writes single
  key
- `sessions.feature_override` set → skipped, no writes, no LLM call
- non-mainline work_units row → skipped
- second run, unchanged session_set_hash → events_relabeled = 0
- second run after new commit → re-attributes, new run row
- LLM returns malformed JSON → Rule C, pass succeeds, logged once

### 3. LLM backend — `tests/llm.test.ts`

Pure factory tests on `getLLMClient()`:

- `TOKENTRAIL_LLM_BACKEND=none` → null
- `=openrouter` without API key → null + log
- `=ollama` → client builds with localhost baseURL, no network call
- auto-detect: stub fetch to localhost → ollama; stub failure + key set
  → openrouter; both absent → null
- model override env vars respected

OpenAI SDK HTTP itself is not integration-tested; mock the client
method and assert prompt structure + parsing.

### 4. Updates to existing tests

- `tests/clustering.test.ts` — point at `getLLMClient()` mock.
- `tests/attribution.test.ts` — unchanged; `attribute()` stays pure.

### Out of scope

- End-to-end `run-all` integration test.
- Actually-running Ollama (covered by the `test` endpoint at runtime).

## Open questions for the plan

- Schema migration: how to populate `inferred_feature_key` for historical
  `usage_events` on first deploy. Option A: leave NULL, let next `run-all`
  fill them. Option B: run `infer-mainline` synchronously as part of the
  migration. Recommend A — it's already idempotent.
- Dashboard hardening: dashboard already binds 127.0.0.1; once it can
  write API keys, ensure no `--host` flag exposes it to LAN.
- Whether `tokentrail llm pull <model>` (wraps `ollama pull`) is in v1
  or deferred. Lean defer; users can run `ollama pull` themselves and
  refresh the settings page.
