# Tokentrail — improvement roadmap

Synthesis of a codebase/app review + external market research (competitors, unmet
needs, 2026 billing shifts), 2026-08-01.

## Strategic position (why this matters for prioritization)

The market splits in two, and **no one occupies Tokentrail's square**:
- **Local-first CLIs** (ccusage) — read on-disk JSONL, estimate USD, span 15+ agent CLIs,
  never upload. But: **no git attribution, no native UX, no budgets, no reconciliation.**
- **Cloud LLMOps** (Langfuse, Datadog, Braintrust) — rich per-user/feature/session
  attribution + (Datadog) invoice reconciliation. But: you ship prompts/traces to a
  platform; overkill for an individual dev / small team.

Tokentrail already has the three things neither camp combines: **git branch/PR/feature
attribution + a native menu-bar surface + local-first privacy.** The highest-ROI moves
lean into that wedge rather than chasing table-stakes.

Reconciliation caveat worth stating up front: for **Claude Code Max/Pro subscription**
users there is no per-token bill to reconcile — the "estimated cost" is a *notional
API-equivalent value*. Reconciliation is meaningful for **API-billed** Claude, **Cursor
metered overage**, and **Copilot credits**. So for subscription users the *attribution/ROI*
story ("where did my subscription value go") is stronger than the *reconciliation* story.

## The convergence (internal gap ↔ external opportunity)

| Theme | Internal (code) | External (market) |
|---|---|---|
| Budgets/forecast/alerts | none exist; all rolling windows, no billing-cycle view | **#1 unmet need**; urgent post token-billing (Uber burned 2026 AI budget by April) |
| Per-PR/feature ROI + chargeback | attribution engine already built (`attribution.ts`) but under-surfaced | **biggest differentiation lever**; no local tool does it at git level |
| Per-model spend / model-mix | computed in CLI only (`report.ts:162`), no GUI | underserved; the highest-leverage cost knob |
| Estimate accuracy / freshness | no dated price registry; silent Claude fallback; hardcoded credit const | drift from stale prices + cache/batch is the top trust-eroder |
| Reconciliation vs real bills | none | trust differentiator only heavyweights attempt |
| Sub-agent / agent-run cost | not distinguished (no `isSidechain`) | new need; track median+p99 to catch runaway loops |
| Web per-source parity | web UI shows no per-source split at all | (internal) closes the biggest surface inconsistency |
| More agent sources | 3 bespoke ingest paths, no `Source` abstraction | ccusage spans 15+; breadth play gated on the abstraction |

## Ranked roadmap

### 🥇 Bet 1 — Budgets, burn-rate forecast, and alerts (the wedge)
> **Status: core shipped in v0.9.0** — global monthly budget (`monthlyBudgetUsd` +
> `budgetCycleStartDay`), cycle-to-date blended spend, run-rate forecast (with honest
> early-cycle suppression), `tokentrail budget`, and the menu-bar budget bar. **Still
> open:** per-dev/repo/branch budgets + a `budgets` table, and native push
> notifications when a threshold trips (deferred fast-follow).

Most-wanted, cheap on this foundation, and it lands on Tokentrail's unique surface (the
menu bar = the perfect ambient alert channel). Own the "don't blow your budget" job.
- **Monthly billing-cycle view** alongside the rolling windows (align to the 1st, or a
  configurable cycle start). Today everything is 7d/30d (`Tokentrail.swift` stat block).
- **Soft budgets** per dev / team / repo / branch, stored in config + a `budgets` table.
- **Burn-rate forecast**: projected month-end spend from EWMA/linear on existing
  `feature_rollups` daily data. Simple SQL; data already there.
- **Threshold alerts**: native macOS notification at 50/80/100% of budget and on daily
  anomaly spikes (anomalies already computed — `anomalies.ts` — just not alerted).
- Scope note: *reporting/soft-caps/alerts only.* Hard request-blocking is a gateway
  concern (proxy path), out of scope for a local reader — say so, don't overpromise.
- Effort: **LOW-MEDIUM.** Impact: **highest.**

### 🥈 Bet 2 — Lean into git attribution: per-PR/feature ROI + model-mix
Tokentrail's structural moat; the data exists, it's under-shown.
- **Per-PR / per-feature cost card** with model breakdown (surface `report.ts:162`'s
  `byModel` in both GUIs). "This PR cost $X, 70% Opus."
- **Model-mix lens**: spend share by model per branch/feature + a heuristic flag for
  high-cost-model use on low-token/low-complexity sessions ("you spent $X on Opus for
  short sessions — Sonnet might do"). Breakdown is LOW; the *recommendation* is MEDIUM
  (needs a complexity proxy).
- **Chargeback/showback** report (per-dev/team roll-up) — extends the existing Notion
  daily-summary sync; push only derived numbers + git labels, never prompts/code
  (local-first team aggregation, the synthesis niche neither camp fills).
- Effort: **LOW** (breakdowns) → **MEDIUM** (recommendations, team roll-up). Impact: high, differentiating.

### 🥉 Bet 3 — Trust: estimate accuracy hygiene now, reconciliation next
- **Now (quick wins):** dated/versioned price registry with an "as-of" date + a staleness
  warning when older than N days (`pricing.ts` has no freshness metadata; `pricing-copilot.ts`
  has a date but no mechanism); make the silent Claude fallback **warn once** like the
  Copilot card does (`pricing.ts:44`); keep cache-read/write/input/output separate in cost
  math (already are for Claude — verify Copilot cache handling). Add `cost.ts` unit tests
  (pure money math, currently untested).
- **Next (bigger):** **reconciliation** — import Anthropic API/Console usage export,
  Cursor `metered_usd` (already pulled!), and Copilot credits; compute per-period
  estimate-vs-billed variance % and surface a reconciliation factor. Converts "estimated"
  into a validated number. MEDIUM; gated on billing-API scope (may need admin keys — see
  open questions).
- Effort: quick wins **LOW**; reconciliation **MEDIUM-HARD**. Impact: trust, especially for API/metered users.

### Timely add — sub-agent / agent-run cost (median + p99)
Capture an agent-run key + `isSidechain` at ingest (`jsonl-reader.ts:199`; Copilot already
has `agent_id`/`parent_tool_call_id`), then percentile SQL over per-run cost. Surfaces
"what did sub-agents cost" and a **p99 runaway-loop alert** — the request that breaks
budgets. Effort **LOW** once the key is captured. Timely as multi-agent spreads.

### Breadth — more agent sources (ccusage parity) + the `Source` abstraction
ccusage covers Codex, Gemini CLI, Amp, Goose, OpenCode, etc.; Tokentrail covers 3 via
three bespoke ingest paths. Unify behind a `Source` interface (read → normalize → upsert
→ watermark), then adding Codex/Gemini-CLI is incremental. Also **make Cursor first-class**
(it's a read-time side-panel today; `sources.ts:20-31` splits it out) or consciously keep
it a side view. Effort: **MEDIUM** (refactor) then **LOW** per new source. Impact: reach.

## Quick-win cleanup (small, high-value, do alongside)
From the code review — each is a small PR:
1. **Web dashboard per-source breakdown** (parity with native `/api/today`) — biggest surface gap; data exists in `sources.ts`.
2. Sub-cent amounts render `<$0.01` not `$0.00` (`Tokentrail.swift:205`; the picker suppression means Copilot tabs read "$0.00 today").
3. Honor `--port` in menu-bar hrefs (hardcoded `:4920` at `api.ts:8` breaks non-default ports).
4. Guard each `run-all` stage in try/catch (`run-all.ts:50-59` — a transient infer-mainline failure currently aborts rollup+sync).
5. Show Cursor plan % / cap (captured in `cursor_usage`, never displayed) — the "about to hit my cap" signal.
6. Implement or delete `infer-mainline --dry-run` (stub at `infer-mainline.ts:11`, advertised at `index.ts:297`).
7. Detached-HEAD handling in attribution (`attribution.ts:166` turns literal "HEAD" into a "Head" feature).
8. Stable event-id (hash a tuple) instead of `${timestamp}-${Math.random()}` fallback (`jsonl-reader.ts:212`) to close a re-read double-count.

## Open questions (gate a couple of the bets)
1. **Reconciliation data access:** do Anthropic/OpenAI/GitHub expose usage/billing at the
   individual-dev tier, or only admin scope? (Datadog needs admin keys.) Determines whether
   reconciliation is a solo-dev feature or team-only.
2. **Agent-run id in Claude JSONL:** is there a durable `agent_run_id` + parent/child link
   at ingest for the median+p99 metric, or must run boundaries be synthesized?
3. **Team feature threshold:** at what team size is cross-dev chargeback worth the sync
   engineering vs. the individual menu-bar+budgets bundle?

## Recommendation
Build **Bet 1 (budgets + forecast + alerts)** first — highest want, lowest effort, lands on
the surface only Tokentrail has — bundled with the **Bet 3 pricing-hygiene quick wins** and
**quick-win #1 (web per-source parity)**. That single release makes Tokentrail the tool that
*warns you before you overspend*, on top of the attribution no competitor has.
