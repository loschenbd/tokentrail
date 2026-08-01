# Plan: Add GitHub Copilot as a third usage source

Status: proposal · Author: research + codebase map + **on-machine schema capture**, 2026-08-01

> **Revised after inspecting a real install (Copilot CLI v1.0.77 on this Mac).** The
> earlier "parse `events.jsonl`" plan was based on docs + community tooling. On disk, the
> canonical usage store turned out to be a **typed SQLite DB**, and **cost is pre-computed**
> — which makes this simpler and more stable than originally scoped. See §2a.

## Implementation status (2026-08-01)

**Built + tested + tsc-clean (411 tests green), smoke-tested against the live store:**
- Phase 1 — `src/services/copilot-store-reader.ts` (read-only SQLite, `schema_version`
  guard, non-fatal). Phase 2 — `src/commands/copilot.ts` (→ `usage_events` `source='copilot'`,
  watermark on max row id, dedup `copilot:{session}:{row}`, native-branch preference),
  registered as `tokentrail copilot`, wired into `run-all` (non-fatal stage). Phase 3 —
  `config/pricing-copilot.ts` + `copilotCostUsd()` (nano-AIU cost primary, rate card
  fallback). Phase 4 (blend) — `sources.ts` splits Copilot out of the Claude line into its
  own per-source entry without changing the total. Config key `copilotStorePath` added.
  New tests: `tests/copilot-store-reader.test.ts`.
- **Runs live:** `tokentrail copilot` reads the real `~/.copilot/session-store.db`, passes
  the v6 guard, reports "no new usage events" (0 rows — the org block), no crash.

**Also built + tested:** Phase 4 dedicated CLI view — `tokentrail report --source copilot`
(spend by repo/branch + per-model breakdown, straight from `usage_events`; excludes other
sources). Phase 5 — README "GitHub Copilot integration" section + command list + config key.

**Not built (out of scope this pass):** the native menubar-app *Copilot panel* — the
per-source blend already reaches the app via `TodayResponse.sourcesToday/sources30d` (it
will render a "GitHub Copilot" line), but a dedicated Copilot detail panel is Swift work in
`scripts/menubar-native/` on a separate build/deploy channel (see the tokentrail-release-flow
skill). The web `dashboard.js` renders no per-source breakdown today, so there's no web panel
to extend. Phase 0 value-verification still gated on an unblocked account.

## TL;DR

- **Ingest path:** read `~/.copilot/session-store.db` (SQLite, `schema_version` 6), table
  **`assistant_usage_events`** — a typed, indexed table with per-turn `input_tokens`,
  `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `reasoning_tokens`, `model`,
  and a pre-computed cost field. This is the **Cursor reader pattern** (read-only
  better-sqlite3), *not* the Claude JSONL-parsing pattern. `events.jsonl` is demoted to a
  secondary/legacy surface (see §2a).
- **Storage:** write into the **existing `usage_events` table with `source='copilot'`**.
  This inherits attribution, rollup, sessions, reporting, and Notion sync for free.
- **Cost is basically free** (inverts the old plan). `assistant_usage_events.total_nano_aiu`
  holds Copilot's own computed cost in **nano AI Units**. Official GitHub docs confirm
  **1 AI credit = $0.01** ("AIU" is Copilot's internal name for the credit), so
  **`usd = total_nano_aiu × 1e-11`** (nano → credit → $0.01). No per-model rate card needed
  on the happy path. `request_multiplier` is also stored, bridging the legacy premium-request
  regime. The token-rate card (§Phase 3) is only a **null-row fallback**. Full researched
  rate table + the constant's derivation live in `docs/plans/copilot-pricing-reference.md`.
- **Attribution is native.** The `sessions` table records `cwd`, `repository`, and `branch`
  per session — Copilot stamps repo/branch itself when run inside a git repo. Tokentrail can
  use these directly (and still cross-check via its own cwd→git resolution).
- **What you do NOT get from GitHub APIs:** no per-request tokens for an individual user
  (billing/metrics APIs are dollars + request counts, org/enterprise-scoped, admin-gated);
  no server-side branch/PR linkage. Irrelevant now — the local SQLite has everything.
- **Load-bearing risk is lower but real:** the SQLite schema is undocumented (no GitHub
  contract) but *typed and versioned* (`schema_version`), so far safer than parsing JSONL.
  Guard on `schema_version`; degrade non-fatally on drift. **The AIU→USD constant is the one
  assumption that must be validated with real data.**
- **⚠ Blocker:** this GitHub account is under an **org policy that disables the Copilot CLI
  AI feature** ("not authorized… requires an enterprise or organization policy"), so *zero
  usage rows* will ever be written on this account. The schema is fully captured (enough to
  build the reader), but value-level verification needs one successful turn on an unblocked
  account. See §Phase 0.

---

## 1. The two existing setups (what we're extending)

Tokentrail has **two bespoke pipelines with no shared source abstraction**. A third
source clones whichever pattern matches its data shape.

| | **Claude Code** ("token path") | **Cursor** ("dollar/line path") |
|---|---|---|
| CLI command | `tokentrail ingest` | `tokentrail cursor [--ingest] [--spend]` |
| Source | JSONL under `~/.claude/projects` | `~/.cursor/.../ai-code-tracking.db` (lines) + cursor.com API (spend) |
| Reader | `src/services/jsonl-reader.ts` | `cursor-tracking-reader.ts`, `cursor-cloud.ts` |
| Normalized type | `AssistantUsage` | `CursorScoredCommit` / metered |
| Dedup key | `usage_events.id` (message id) | `commit_hash` |
| Dest table | **`usage_events`** (`source='jsonl'`) | `cursor_code_attribution`, `cursor_usage`, `cursor_daily_cost` |
| Cost | tokens → `config/pricing.ts` → `estimateCostUsd` | dollars reported directly; **bypasses pricing table** |
| Watermark | `ingest_file_state` (size/mtime/scan_version) | `cursor_ingest_state` (last_scored_at) |

Cursor took the dollar path **because it never exposes per-request tokens** — only
lines-of-code and account-wide `chargedCents`. Copilot's `events.jsonl` *does* expose
tokens, so it belongs on the Claude token path. That single fact is why this is a small
change and not a Cursor-sized one.

**Attribution is already source-agnostic.** `src/lib/attribution.ts::attribute()` takes
only `{ repo, branch, prLabels?, prTitle? }` — it never sees a source. `repo`/`branch`
are stamped at ingest time from cwd → git (`services/git.ts`). A new source only has to
supply a project dir (or a commit hash resolvable to a repo). No attribution changes needed.

---

## 2. What GitHub Copilot actually exposes (research findings)

Verified against primary GitHub docs/changelogs (24/25 claims confirmed 3-0). Full cited
report in the deep-research output; the decisive points:

**Local disk — the good path (Q1).**
- The **standalone `copilot` CLI** persists sessions under `~/.copilot` (config root,
  overridable via `COPILOT_HOME`), including `session-state/{session-id}/` artifacts and a
  top-level SQLite store. Primary-sourced (config-dir reference + "chronicle" doc).
- The docs point at `events.jsonl`; **on a real install the canonical usage store is SQLite
  instead** — see §2a for what's actually on disk. Community parsers referencing
  `events.jsonl` (ccusage #1174, rajbos/github-copilot-token-usage) likely predate the
  SQLite store or read a different surface; either way, the SQLite table is typed and
  versioned and is the better target.
- The **old `gh copilot` extension** is a different tool (shell-command suggester); it is
  not the token-bearing surface. Target the standalone CLI.

### 2a. On-machine capture — the actual local data model (Copilot CLI v1.0.77)

Verified by installing the CLI and inspecting the files it wrote. Full DDL captured at
`docs/plans/copilot-session-store-schema.sql`.

- **Store:** `~/.copilot/session-store.db` — SQLite, `schema_version = 6`. Read it
  **read-only** with better-sqlite3 (the Cursor reader pattern). Also present:
  `session-state/{id}/workspace.yaml`, `checkpoints/`, per-session lock files, and a
  `logs/` dir — but the structured usage lives in the DB.
- **`assistant_usage_events`** (the feed) — one row per model turn. Columns:
  `id` (autoincrement PK), `session_id` (FK), `turn_index`, `agent_id`,
  `parent_tool_call_id`, **`model`** (NOT NULL), **`input_tokens`**, **`output_tokens`**,
  **`cache_read_tokens`**, **`cache_write_tokens`**, **`reasoning_tokens`**,
  **`total_nano_aiu`** (pre-computed cost, nano AI Units), **`request_multiplier`** (legacy
  premium-request multiplier), `duration_ms`, `time_to_first_token_ms`,
  `inter_token_latency_ms`, `initiator` (user vs. autonomous), `api_endpoint`,
  `reasoning_effort`, `finish_reason`, `content_filter_triggered`, `token_details_json`
  (detail blob), `created_at`. Indexed on `(session_id, id)`, `(session_id, turn_index)`,
  and `model`.
- **`sessions`** (attribution, native) — `id, cwd, repository, branch, host_type, summary,
  created_at, updated_at`. So Copilot records repo + branch itself when the session runs in
  a git repo. (In the captured run `cwd=~/Projects`, which isn't a git repo, so
  `repository`/`branch` were empty — expected.)
- **Cost is pre-computed** → `usd ≈ total_nano_aiu × 1e-11` (nano → AIU → $0.01/credit).
  This is the single biggest change from the doc-based plan: we don't need a per-model rate
  card to price Copilot. **Caveat:** the AIU→USD constant is *inferred* — must be confirmed
  against a real non-zero row and the account's billing dashboard.
- **What's NOT here vs. Claude's JSONL:** no stable global message id (PK is a local
  autoincrement) → dedup on `(session_id, id)` or `(session_id, turn_index, agent_id,
  model)`; and a `reasoning_tokens` bucket that `usage_events` has no column for (fold into
  cost via `total_nano_aiu`, or add a column).

**APIs — the weak path (Q2/Q3).**
- Billing/usage family (`.../settings/billing/usage`, `premium_request/usage`,
  `ai_credit/usage`, usage summary) returns **dollars + quantities only, never tokens**,
  and is **org/enterprise-scoped, admin-token gated** — not usable by an individual
  Pro/Pro+ user tracking their own spend.
- **One exception:** Copilot Metrics API "Copilot app" section (added 2026-07-17) exposes
  **aggregate** `output_tokens_sum` / `prompt_tokens_sum` / `avg_tokens_per_request` at
  org/enterprise/per-user 1-day & 28-day rollups. Aggregate only, never per-request, still
  admin-scoped. Useful at most as a **reconciliation check**, not a primary feed.
- Cloud/async coding agent: **1 premium request per session**, no per-PR token or cost
  surface.

**Pricing — dual regime (Q4).**
- **Legacy (pre-2026-06-01, still active for un-migrated annual plans):** premium requests
  × per-model multiplier; overage flat **$0.04/request**. Only user-initiated prompts count.
- **Current (usage-based, from 2026-06-01):** per-million-token rates published **per
  model**; **1 AI credit = $0.01**. e.g. Claude Sonnet 4.5 = $3 in / $0.30 cached /
  $3.75 cache-write / $15 out per 1M; GPT-5.4 = $2.50 in / $0.25 cached / $15 out.
- These are **GitHub's rates**, distinct from Anthropic direct pricing already in
  `config/pricing.ts`. A Copilot cost must use a Copilot card.

**Attribution (Q5).** No GitHub surface maps usage to branch or PR. Finest server-side
attribution is session/feature-level. Branch/PR linkage must be reconstructed **locally**
(session timestamp + workspace root/cwd → git state) — exactly Tokentrail's existing model.

---

## 3. Design decision

> **Read `~/.copilot/session-store.db` (`assistant_usage_events`) read-only via
> better-sqlite3 — the Cursor reader pattern. Store rows into `usage_events` with
> `source='copilot'` (the Claude destination). Take cost from the DB's pre-computed
> `total_nano_aiu`; a per-model rate card is a fallback only.**

This is a **hybrid of the two existing patterns**: the *reader* is Cursor-shaped (read-only
foreign SQLite, watermark row, non-fatal), but the *destination* is Claude-shaped
(`usage_events` with real tokens + cost), so everything downstream works unchanged.

Why `usage_events` over a `copilot_*` side table:
- `assistant_usage_events` gives real per-turn tokens + model + cost → `usage_events` is the
  natural home (Cursor only got side tables because it has no per-request tokens).
- Everything downstream (work_units, feature_rollups, sessions, report, Notion sync,
  dashboard totals) already keys off `usage_events`.
- The `source` column already exists (`schema.ts:17`, default `'jsonl'`) — only the insert
  (hardcoded `'jsonl'`, `ingest.ts:96`) and the TS union (`types.ts:16`) need widening.

Cost no longer needs a per-provider rate card on the happy path: `total_nano_aiu` is
Copilot's own computed cost. The rate card (§Phase 3) is demoted to a validation/fallback
for rows where `total_nano_aiu` is null or the AIU→USD constant proves wrong.

---

## 4. Implementation phases

Small, testable phases per the project constitution. Each ends with a manual-verify step.

### Phase 0 — Verify record *values* (schema already captured; ⚠ blocked on this account)
The schema is **done** (§2a; DDL at `docs/plans/copilot-session-store-schema.sql`). What
remains needs one **successful** model turn to populate `assistant_usage_events` with a real
non-zero row — which **this GitHub account cannot do** (org policy disables the CLI AI
feature). Unblock via one of: a personal Copilot Pro/Pro+ account not under that org, an
org-admin enabling the CLI policy, or a colleague's install. Then confirm:
- The exact **`model`** string format (e.g. `claude-sonnet-4.5` vs `gpt-5.4`) — drives the
  fallback rate-card matcher and per-model report labels.
- **`total_nano_aiu` → USD**: the constant is confirmed (`× 1e-11`; 1 credit = $0.01, per
  GitHub docs). Verify with a **self-consistent arithmetic check on one real row** — no
  billing-admin access needed: `total_nano_aiu × 1e-11` must equal
  `(input_tokens×in + cache_read×cached + cache_write×cw + output_tokens×out) / 1e6` using
  the model's published rate (see `copilot-pricing-reference.md`). If they match, both the
  constant and the model→rate matcher are validated at once.
- Whether `total_nano_aiu` / `request_multiplier` are populated on **all** rows or null for
  base-model/legacy turns (decides when the fallback card is needed).
- Shape of **`token_details_json`** (may split ephemeral cache tiers, like Claude's JSONL).
- That `sessions.repository` / `branch` populate when run **inside a git repo** (the capture
  ran in `~/Projects`, a non-repo, so both were empty).

Exit: a real row captured as a test fixture + the AIU→USD constant confirmed against billing.
**Until then, Phases 1–3 can be built against the known schema but not value-verified.**

### Phase 1 — Reader + normalized type (Cursor-shaped)
New `src/services/copilot-store-reader.ts`, mirroring `cursor-tracking-reader.ts`:
- `copilotStorePath()` → `$COPILOT_HOME/session-store.db` else `~/.copilot/session-store.db`
  (config override, mirrors `cursorTrackingDbPath()`).
- Open **read-only, immutable** (`{ readonly: true, fileMustExist: true }`, per
  cursor-tracking-reader.ts:40). Any failure → `[]` + warning, never fatal.
- **Guard on `schema_version`** (read the `schema_version` table): if it's not a version the
  reader was written for, warn and return `[]` rather than mis-parsing.
- Query `assistant_usage_events` JOIN `sessions` for rows newer than the watermark, mapping
  to a `CopilotUsage` type: `{ sessionId, rowId, turnIndex, model, inputTokens,
  outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens, totalNanoAiu,
  requestMultiplier, initiator, createdAt, cwd, repository, branch }`.
- **Dedup key:** `(sessionId, rowId)` (rowId = the autoincrement PK, stable per DB).

Exit: unit test reads a fixture DB (from Phase 0, or a hand-built one on the captured DDL)
into `CopilotUsage[]`.

### Phase 2 — Persistence + watermark + command (Cursor-shaped stage, Claude destination)
New `src/commands/copilot.ts` (model on `commands/cursor.ts` for the read side):
- **Watermark:** a single-row watermark in a new `copilot_ingest_state` table (mirror
  `cursor_ingest_state`), tracking the max `(created_at)` or max seen `rowid` — only read
  newer rows.
- **Insert:** `INSERT OR IGNORE INTO usage_events (...)` with `source='copilot'`, dedup via a
  synthesized stable `id` = `copilot:{sessionId}:{rowId}`. Map token buckets directly;
  `estimated_cost_usd` = `totalNanoAiu × 1e-11` when present, else the fallback card (Phase 3).
- **Attribution:** prefer `sessions.repository`/`branch` when populated; otherwise resolve
  from `sessions.cwd` via `repoContextFor()` (services/git.ts) exactly like Claude does from
  its project dir (ingest.ts:161-176). Attribution module itself is untouched.
- Widen the TS union `types.ts:16` → add `'copilot'`; register `tokentrail copilot` in
  `src/index.ts`.
- Decide on `reasoning_tokens`: fold into cost (already in `total_nano_aiu`) for MVP; add a
  `reasoning_tokens` column to `usage_events` only if you want it broken out in reports.

Exit: `tokentrail copilot` populates `usage_events` where `source='copilot'`; re-running is
idempotent; rows carry repo/branch and a cost derived from `total_nano_aiu`.

### Phase 3 — Fallback pricing card (demoted — only for null-cost rows)
Only needed if Phase 0 shows some rows lack `total_nano_aiu` (e.g. base-model or legacy
turns), or to sanity-check the AIU→USD constant.
- Add `config/pricing-copilot.ts` from the captured table in
  `docs/plans/copilot-pricing-reference.md` (Claude + GPT-5.x + Gemini + Grok + others, at
  **GitHub's** resale rates — which differ from Anthropic-direct in `config/pricing.ts`).
  Same `ModelPricing` shape (non-Anthropic models have `cacheWrite: 0`); matcher extended to
  `gpt`/`gemini`/`grok`/etc.; `console.warn` on unknown model. Note some models are
  context-window tiered — the happy path (`total_nano_aiu`) sidesteps this.
- Source-aware selection in `cost.ts`: use `total_nano_aiu` first; fall back to the Copilot
  card when null; never touch the Claude path. Label everything **estimated** (rule 3).

Exit: rows with a native cost use it; null-cost rows get a plausible card estimate; unknown
models warn rather than silently pricing as sonnet.

### Phase 4 — Surfacing (report, dashboard, run-all)
Copilot spend must appear **two ways**: (a) **blended** into the top-level total (it's real
token cost, so it counts toward the headline dollars just like Claude), and (b) **broken
out into its own dedicated view** so Copilot spend can be inspected on its own.

- `src/commands/run-all.ts` — add a Copilot stage wrapped in the same non-fatal try/catch
  as Cursor (run-all.ts:34-40), so a Copilot parser break never breaks the pipeline
  (constitution rule 6).
- **Blend (top-level total):** `src/dashboard/data/sources.ts` — extend the `SourceCost.key`
  union to include `'copilot'` and add it to `buildSources()`. Copilot **has** real dollar
  costs in `usage_events`, so unlike Cursor it **is** summed into `totalUsd` — pull its
  windowed dollars with a `WHERE source='copilot'` sum alongside Claude's. The existing
  per-source breakout list (already used for the Claude/Cursor swatches) gains a third
  `copilot` entry automatically, giving the top-level "blended total + per-source split".
- **Dedicated view (Copilot on its own):** add a Copilot-scoped view that filters
  `usage_events` to `source='copilot'` and reuses the existing `usage_events` aggregations
  — spend over time, per-model breakdown (GPT/Gemini/Claude), and per-branch/PR attribution
  (which comes for free since attribution already ran at ingest). Concretely:
  - CLI: a `--source copilot` filter on `tokentrail report` (or a `tokentrail copilot
    --report` sub-view) that renders the standard `usage_events` report scoped to Copilot.
    Copilot does **not** need a `renderCursorLane()`-style special case — that lane exists
    only because Cursor isn't in `usage_events`; Copilot rides the normal path, just filtered.
  - Dashboard: a Copilot tab/panel (mirror how a single source is drilled into) backed by a
    `source='copilot'` query, showing the same charts as the main view but Copilot-only.
- Frontend (`dashboard.js`/`.css`) — add a Copilot source swatch/label for the blended
  breakout **and** the dedicated-view entry point (tab/toggle); audit that existing
  `cursor` string hits are the source, not CSS `cursor:` properties.

Exit: the top-level total includes Copilot dollars with a per-source breakout, **and** a
dedicated Copilot view shows Copilot-only spend (over time, by model, by branch/PR);
`run-all` stays green when `~/.copilot` is absent.

### Phase 5 — Config + docs
- `src/lib/config.ts` — add keys mirroring the Cursor ones: `copilotHome` /
  `copilotSessionDir` path override and a `copilotEnabled` flag (config.ts:57-77).
- Update README / brand-consistent microcopy; keep flavor in copy, not architecture
  (constitution rules 7-8).

---

## 5. Files touched (grounded map)

New: `src/services/copilot-store-reader.ts` (read-only SQLite), `src/commands/copilot.ts`,
`config/pricing-copilot.ts` (fallback only), test fixtures (a fixture `session-store.db`).

Edited:
- `src/lib/types.ts:16` — widen source union to include `'copilot'`.
- `src/lib/cost.ts` — cost = `total_nano_aiu × 1e-11`, fall back to Copilot card if null.
- `src/index.ts:37-43` — register `copilot` command.
- `src/commands/run-all.ts:34-40` — non-fatal Copilot stage.
- `src/dashboard/data/sources.ts:3-44` — `key` union + `buildSources()` (blended total) +
  the dedicated Copilot view query.
- `src/commands/report.ts` — `--source copilot` filter for the dedicated CLI view.
- `src/lib/config.ts:57-77` — Copilot config keys (`copilotHome` / `copilotStorePath`).
- `src/dashboard/static/dashboard.js` / `.css` — source swatch + dedicated-view tab.
- `src/db/schema.ts` — add a `copilot_ingest_state` watermark table (mirror
  `cursor_ingest_state`); `usage_events` needs **no** change (`source` column exists) unless
  you break out `reasoning_tokens` as a column.

Unchanged by design: `src/lib/attribution.ts` (source-agnostic), `services/git.ts`,
rollup/enrich/sessions (all key off `usage_events`).

---

## 6. Risks & mitigations

1. **⚠ Org policy blocks usage generation on this account** (highest — a process blocker,
   not a design one). The CLI signs in but the AI feature is org-disabled, so no rows ever
   populate `assistant_usage_events` here. Mitigate: value-verify on an unblocked account
   (personal Pro/Pro+, admin-enabled org, or colleague's install). The build can proceed
   against the captured schema in the meantime.
2. **AIU→USD constant** — now **confirmed** (`× 1e-11`; 1 AI credit = $0.01 per GitHub
   docs; "AIU" = internal name for credit). Residual risk is only that the DB stores some
   other scaling than nano; settle with the one-row arithmetic cross-check (Phase 0), which
   needs no billing access. Downgraded from load-bearing to a quick sanity check.
3. **Undocumented SQLite schema.** No GitHub contract; a CLI update could bump
   `schema_version` or rename columns. Lower risk than JSONL (typed + versioned). Mitigate:
   guard on `schema_version`, degrade to `[]` + warn on mismatch (Cursor's non-fatal
   precedent), pin the versions the reader supports.
4. **Null cost / dual billing.** Some rows (base-model or un-migrated legacy accounts) may
   have null `total_nano_aiu`; `request_multiplier` is stored for the legacy regime.
   Mitigate: fallback rate card (Phase 3); the value is an *estimate* regardless (rule 3).
5. **Time-sensitivity.** Copilot billing changed 2026-06-01; token metrics landed
   2026-07-17 — weeks before this work. Expect churn; keep pricing + the AIU constant in one
   file.

---

## 7. Open questions

1. ~~Exact usage-record schema~~ — **captured** (§2a). Remaining: real *values* (Phase 0),
   gated on an unblocked account.
2. ~~Workspace root / cwd for attribution~~ — **answered:** `sessions` stores `cwd`,
   `repository`, `branch` natively. Confirm repo/branch populate inside a git repo (Phase 0).
3. ~~Per-request id for dedup~~ — **answered:** synthesize `copilot:{sessionId}:{rowId}` from
   the autoincrement PK.
4. Scope: CLI sessions only for v1, or also the cloud coding agent (no token surface —
   premium-request-count only, a separate dollar-path feature)? Recommend **CLI-only for v1**.
5. ~~Blend vs. separate lane~~ — **decided:** both — blended top-level total (per-source
   breakout) **and** a dedicated Copilot-only view (§Phase 4).
6. ~~Confirm the AIU→USD constant~~ — **resolved by research:** 1 AI credit = $0.01,
   `usd = total_nano_aiu × 1e-11`; full rate table captured in `copilot-pricing-reference.md`.
   Only a one-row arithmetic cross-check remains (Phase 0), needing no billing access.
