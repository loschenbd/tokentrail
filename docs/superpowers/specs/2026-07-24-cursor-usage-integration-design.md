# Cursor usage integration — design

**Date:** 2026-07-24
**Status:** Approved design, pre-implementation
**Scope:** Add Cursor as a tracked source alongside Claude Code. Two data
lanes: (A) account-level cloud spend, (B) local AI-authored-code attribution.

---

## 1. Motivation & constraint

Tokentrail's spine is `usage_events` (token-based, per-event estimated cost)
→ `work_units(repo, branch)` → `feature_rollups` → report / Notion. Every
downstream stage assumes a row is a token-priced event.

**Cursor exposes neither tokens nor per-event cost in any local, attributable
form.** Investigation of a real install (2026-07-24) found:

- `~/.cursor/ai-tracking/ai-code-tracking.db` — a **lines-of-AI-code** ledger.
  Table `scored_commits` (567 rows) has `commitHash`, `branchName`,
  `composerLinesAdded` (agent), `tabLinesAdded` (autocomplete),
  `humanLinesAdded`, `v2AiPercentage`, `commitDate`, `commitMessage`.
  **No tokens, no cost**, `model` mostly empty.
- `state.vscdb` (globalStorage) — billing UI flags, `cursorAuth/accessToken`,
  `stripeMembershipType`. **No usage/cost numbers.**
- Actual spend lives **server-side** at cursor.com, reachable only via a
  web-session cookie.

**Therefore Cursor data MUST NOT enter `usage_events`.** Mixing lines or
account-wide dollars into the token/cost spine would corrupt USD totals and
violate rule #3 (all costs estimated from tokens). Cursor is modeled as a
**parallel lane** with dedicated tables and its own report section. Two
currencies — AI lines and account dollars — that are **never summed** into the
token-cost trail or into each other.

This decision is the backbone of the whole design.

---

## 2. Source B — local AI-line attribution (categorized)

The valuable, low-fragility half. Fully local, no auth, and it carries the
branch signal that is Tokentrail's whole point.

### Read
- New reader `src/services/cursor-tracking-reader.ts`.
- Open `~/.cursor/ai-tracking/ai-code-tracking.db` **read-only**
  (`?mode=ro&immutable=1`) via better-sqlite3 (rule #4) so it never contends
  with a running Cursor. Honor a `CURSOR_HOME` / config override for the path.
- Select from `scored_commits`: `commitHash`, `branchName`,
  `composerLinesAdded`, `tabLinesAdded`, `humanLinesAdded`, `v2AiPercentage`,
  `commitDate`, `commitMessage`, `scoredAt`.
- Treat AI lines = `composerLinesAdded + tabLinesAdded`; human lines =
  `humanLinesAdded`. Store the components too, so the split stays inspectable.
- **Guard every column read** — Cursor's schema can drift. A missing column or
  missing db is a skip-with-log, never a crash (rule #6).

### Repo resolution (the crux)
`branchName` alone is ambiguous — "main" appears 466× across unrelated repos.
The unique key is `commitHash`.

- For each unresolved `commitHash`, test membership across the repos Tokentrail
  already knows (derive candidate repo roots from `usage_events.repo` /
  `sessions.project_dir` / existing git-history services) with
  `git cat-file -e <sha>^{commit}`. First repo that contains the commit wins.
- Cache `commitHash → repo`. Commits resolving to no known repo are **parked**
  (`repo = NULL`) and retried on later runs (the repo may become known after a
  clone or after Claude/Codex activity registers it).
- This resolution and the `(repo, branch) → feature` mapping live in
  `src/lib/attribution.ts` (rule #5), reusing the existing work-unit logic — a
  resolved `(repo, branch)` grouping is identical to the token lane's.

### Store
New table `cursor_code_attribution`:

```
commit_hash    TEXT PRIMARY KEY
repo           TEXT              -- NULL while unresolved
branch         TEXT NOT NULL
ai_lines       INTEGER NOT NULL  -- composer + tab
composer_lines INTEGER NOT NULL
tab_lines      INTEGER NOT NULL
human_lines    INTEGER NOT NULL
ai_pct         REAL
committed_at   TEXT
message        TEXT
scored_at      INTEGER NOT NULL  -- source watermark basis
source         TEXT NOT NULL DEFAULT 'cursor'
```

Incremental: track `max(scored_at)` already ingested (a `cursor_ingest_state`
row, mirroring `ingest_file_state`). Rows are upserted so re-scores update.

---

## 3. Source A — cloud spend (uncategorized $ tile)

Account-level dollars for a top-line "Cursor spend" number. Cannot be
attributed to branch/feature — it is a single figure by nature. Grounded in
CodexBar's working implementation (`docs/cursor.md`).

### Auth — cookie, not bearer
Cursor's usage endpoints authenticate with a **web-session cookie**
(`WorkosCursorSessionToken`), **not** a bearer token. `cursorAuth/accessToken`
is not directly usable.

- **Primary:** derive Cursor's first-party web-session cookie from the local
  `state.vscdb` (macOS `~/Library/Application Support/Cursor/User/globalStorage/`,
  Linux `$XDG_CONFIG_HOME/Cursor/User/globalStorage/`). This is CodexBar's
  fallback #4 but is the correct **primary** for a local daemon — fully local,
  no browser dependency.
- **Fallback:** a `cursor.sessionCookie` value pasted into config / env.
- **Explicitly out of scope for MVP:** scraping cookies from Safari/Chrome/
  Firefox. That multi-browser surface is precisely CodexBar's fragile path
  (issue #371, "No Cursor session found", `area:auth-keychain`). We skip it.

### Endpoint — MVP
- `GET https://cursor.com/api/usage-summary` → included usage, on-demand usage,
  billing-cycle window. This is the entire spend tile.
- `GET https://cursor.com/api/auth/me` only if a user id is needed to
  disambiguate the account.

### Store
New table `cursor_spend`:

```
period_start  TEXT
period_end    TEXT
spend_usd     REAL
quota_usd     REAL
requests      INTEGER
plan          TEXT
fetched_at    TEXT NOT NULL
stale         INTEGER NOT NULL DEFAULT 0
```

- Refresh **≤ once per day**, gated so the ~60s menubar poll never calls the
  network. On any failure (no cookie, expired session, non-200, shape drift):
  log cleanly, keep the last-good row, set `stale = 1`, continue (rule #6).
- Config `cursor.cloudSpend: false` disables the network path entirely
  (offline / privacy). Source B is unaffected.

### Deferred to phase 2 (not built now — YAGNI)
`POST https://cursor.com/api/dashboard/get-filtered-usage-events` returns
paginated events with `meteredCostUSD` + model per event (cookie + matching
`Origin` header for CSRF; 1000/page, up to 200 pages). It enables per-model
dollar itemization but still carries no branch, and the pagination/CSRF weight
is high. Noted as a future enrichment; explicitly excluded from this spec.

---

## 4. Wiring & presentation

### Command
- New `tokentrail cursor` with `--ingest` (Source B), `--spend` (Source A),
  default = both. Mirrors `tokentrail ingest`.
- Add to `run-all` after enrich. **Absence of Cursor is a clean no-op** — no
  db and no cookie prints "No Cursor data found" and returns, never errors.

### Report / dashboard
- A distinct **Cursor lane**, visually separated from the token-cost trail.
- Per feature (Source B): **AI lines** (with composer/tab split available) and
  **AI %**, grouped through the same `feature` mapping as the token lane.
- Separate top-line (Source A): *"Cursor spend (account-wide, estimated):
  $X of $Y plan — not attributable per-feature."*
- **Invariant:** Cursor lines are never summed into USD; Cursor dollars are
  never summed into token-cost totals; the two Cursor metrics are never summed
  into each other. Two lanes, clearly labeled, `estimated` on all dollars
  (rule #3).

---

## 5. Error handling

- Local db missing / schema drift / locked → skip-with-log, continue.
- Read the foreign SQLite `mode=ro&immutable=1` to avoid lock contention.
- Cloud: missing cookie / expired / non-200 / shape drift → log, serve stale,
  continue. Cursor failures never crash the pipeline (rule #6).

---

## 6. Testing

- Fixture `ai-code-tracking.db` with `scored_commits` across two repos and
  multiple branches (incl. an ambiguous shared "main") → assert `commitHash`
  repo resolution and correct per-feature grouping; assert unresolved commits
  park and later resolve.
- Mocked `usage-summary` response → assert parse into `cursor_spend` and the
  stale-fallback path on failure.
- **Invariant test:** after a Cursor ingest, `usage_events` is unchanged and
  USD token totals are byte-identical — Cursor never touches the token spine.

---

## 7. Risk & first implementation step

**Biggest risk:** whether the Cursor web-session cookie can be derived from
`state.vscdb` and authenticates `usage-summary`. If it cannot (cookie-only /
undocumented derivation), Source A degrades to the pasted-cookie fallback, and
if that is also unavailable we ship **B-only** without blocking.

**Task #1 of implementation is a spike** to confirm cookie derivation +
`usage-summary` before any spend-storage code is written. Source B (local,
no auth) has no such risk and can proceed in parallel.

---

## 8. Build order

1. Spike: confirm Source A cookie derivation + `usage-summary`. (Degrade plan
   ready if it fails.)
2. Source B reader + `cursor_code_attribution` table + watermark.
3. Repo resolution + feature mapping in `attribution.ts`.
4. `tokentrail cursor --ingest`; wire into `run-all`; no-op guards.
5. Source A service + `cursor_spend` table (gated daily, non-fatal).
6. `tokentrail cursor --spend`.
7. Report + dashboard Cursor lane.
8. Tests incl. the never-summed invariant.
