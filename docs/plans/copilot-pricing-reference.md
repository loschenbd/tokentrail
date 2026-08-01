# Copilot pricing reference (for the fallback rate card + AIU→USD verification)

Source: official GitHub docs, captured 2026-08-01. **Rates churn** (Copilot moved to
token-based billing 2026-06-01); treat this as a dated snapshot and keep it in one file.

- Official: https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing
- AI-credit definition: https://docs.github.com/en/copilot/concepts/billing/usage-based-billing-for-organizations-and-enterprises

## The unit: AI credit / AIU

- **1 AI credit = $0.01 USD** (official).
- GitHub's *public* term is "AI credit." The Copilot CLI's local DB column
  `assistant_usage_events.total_nano_aiu` uses "AIU" (AI Unit) as an internal synonym for the
  credit. So:

  ```
  usd = total_nano_aiu * 1e-11        # nano (÷1e9) → AIU/credit → ×$0.01
  ```

- **Self-consistent verification (no billing-admin access needed):** for one real row,
  the token-derived cost must equal the nano-derived cost:

  ```
  token_cost = (input_tokens*in + cache_read*cached + cache_write*cw + output_tokens*out) / 1e6
  nano_cost  = total_nano_aiu * 1e-11
  assert token_cost ≈ nano_cost      # confirms both the 1e-11 constant AND model→rate matching
  ```

  (Copilot almost certainly computes `total_nano_aiu` *from* tokens×rate, so these should
  match to rounding. One real row from any unblocked account settles it.)

## Per-model rates — USD per 1,000,000 tokens (as of 2026-08-01)

Note: several models are **context-window tiered** (rate jumps above a token threshold) and
there are promo/fast-mode variants. The happy path (`total_nano_aiu`) handles all of this
natively; the fallback card only needs these for rows where `total_nano_aiu` is null.

### Anthropic (note: these are GitHub's resale rates, NOT Anthropic-direct)
| Model | Input | Cached input | Cache write | Output |
|---|---|---|---|---|
| Claude Haiku 4.5 | 1.00 | 0.10 | 1.25 | 5.00 |
| Claude Sonnet 4 / 4.5 / 4.6 | 3.00 | 0.30 | 3.75 | 15.00 |
| Claude Sonnet 5 (promo) | 2.00 | 0.20 | 2.50 | 10.00 |
| Claude Opus 4.5 / 4.6 / 4.7 / 4.8 / 5 | 5.00 | 0.50 | 6.25 | 25.00 |
| Claude Opus 4.8 (fast mode) | 10.00 | 1.00 | 12.50 | 50.00 |
| Claude Fable 5 | 10.00 | 1.00 | 12.50 | 50.00 |

> Reality check vs. `config/pricing.ts` (Anthropic-direct): direct Opus = 15/75, Copilot
> Opus = 5/25. **Different rate cards — do not reuse the Claude card for Copilot.**

### OpenAI
| Model | Input | Cached input | Cache write | Output |
|---|---|---|---|---|
| GPT-5 mini | 0.25 | 0.025 | — | 2.00 |
| GPT-5.3-Codex | 1.75 | 0.175 | — | 14.00 |
| GPT-5.4 (≤272K) | 2.50 | 0.25 | — | 15.00 |
| GPT-5.4 (>272K) | 5.00 | 0.50 | — | 22.50 |
| GPT-5.4 mini | 0.75 | 0.075 | — | 4.50 |
| GPT-5.4 nano | 0.20 | 0.02 | — | 1.25 |
| GPT-5.5 (≤272K) | 5.00 | 0.50 | — | 30.00 |
| GPT-5.5 (>272K) | 10.00 | 1.00 | — | 45.00 |
| GPT-5.6 Luna (≤200K / >200K) | 0.20 / 0.40 | 0.02 / 0.04 | — | 1.20 / 1.80 |
| GPT-5.6 Sol (≤272K / >272K) | 5.00 / 10.00 | 0.50 / 1.00 | — | 30.00 / 45.00 |
| GPT-5.6 Terra (≤272K / >272K) | 2.00 / 4.00 | 0.20 / 0.40 | — | 12.00 / 18.00 |

### Google
| Model | Input | Cached input | Cache write | Output |
|---|---|---|---|---|
| Gemini 3.1 Pro (≤200K / >200K) | 2.00 / 4.00 | 0.20 / 0.40 | — | 12.00 / 18.00 |
| Gemini 3.5 Flash | 1.50 | 0.15 | — | 9.00 |
| Gemini 3.6 Flash | 1.50 | 0.15 | — | 7.50 |

### xAI
| Model | Input | Cached input | Cache write | Output |
|---|---|---|---|---|
| Grok 4.5 (≤200K / >200K) | 2.00 / 4.00 | 0.50 / 1.00 | — | 6.00 / 12.00 |

### Other
| Model | Input | Cached input | Cache write | Output |
|---|---|---|---|---|
| Raptor mini (GitHub) | 0.25 | 0.025 | — | 2.00 |
| MAI-Code-1-Flash (Microsoft) | 0.75 | 0.075 | — | 4.50 |
| Kimi K2.7 Code (Moonshot) | 0.95 | 0.19 | — | 4.00 |

## Implementation notes for `config/pricing-copilot.ts`
- Non-Anthropic models (GPT/Gemini/Grok/Raptor/MAI/Kimi) have **no cache-write rate** —
  `cacheWrite: 0`.
- Some models are **tiered by context size** (≤200K/≤272K vs above). The fallback card can
  approximate with the low tier (agent turns are usually under the threshold) and log when a
  turn exceeds it, or read the turn's total input to pick the tier. Happy path avoids this.
- Matcher must handle provider-prefixed / versioned model strings from the DB (exact format
  TBD from a real row — e.g. `claude-sonnet-4.5`, `gpt-5.4`, `gemini-3.6-flash`). Warn on
  unknown model rather than silently defaulting.
