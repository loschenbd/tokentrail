// GitHub Copilot per-million-token USD rates — GitHub's RESALE rates, which
// differ from the model vendors' direct API rates (e.g. Copilot Claude Opus
// 4.8 = $5/$25 vs Anthropic-direct $15/$75). These are a FALLBACK only: the
// Copilot CLI records a pre-computed cost per turn in
// assistant_usage_events.total_nano_aiu, and copilotCostUsd() uses that first.
// This card is consulted only for rows where total_nano_aiu is null/0.
//
// Captured 2026-08-01. Rates churn (Copilot moved to token-based billing
// 2026-06-01); see docs/plans/copilot-pricing-reference.md for the full table
// and provenance. Estimates only.
//
// Reference:
//   https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing

import type { ModelPricing } from './pricing.js';

// Context-window-tiered models (≤200K/≤272K vs above) are represented at their
// LOW tier — agent turns are usually under the threshold. The happy path
// (total_nano_aiu) prices every turn exactly regardless, so this approximation
// only affects null-cost fallback rows. Non-Anthropic models have no published
// cache-write rate → cacheWrite: 0.

const RATES: ReadonlyArray<readonly [RegExp, ModelPricing]> = [
  // --- Anthropic (GitHub resale rates) ---
  [/opus/i, { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 }],
  [/haiku/i, { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 }],
  [/sonnet/i, { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 }],
  [/fable/i, { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 1 }],
  // --- OpenAI ---
  [/gpt-5[.-]?5|gpt-5\.6[ -]?(sol)/i, { input: 5, output: 30, cacheWrite: 0, cacheRead: 0.5 }],
  [/gpt-5\.6[ -]?terra/i, { input: 2, output: 12, cacheWrite: 0, cacheRead: 0.2 }],
  [/gpt-5\.6[ -]?luna/i, { input: 0.2, output: 1.2, cacheWrite: 0, cacheRead: 0.02 }],
  [/gpt-5[.-]?3.*codex/i, { input: 1.75, output: 14, cacheWrite: 0, cacheRead: 0.175 }],
  [/gpt-5[.-]?4[ -]?mini/i, { input: 0.75, output: 4.5, cacheWrite: 0, cacheRead: 0.075 }],
  [/gpt-5[.-]?4[ -]?nano/i, { input: 0.2, output: 1.25, cacheWrite: 0, cacheRead: 0.02 }],
  [/gpt-5[.-]?4/i, { input: 2.5, output: 15, cacheWrite: 0, cacheRead: 0.25 }],
  [/gpt-5[ -]?mini/i, { input: 0.25, output: 2, cacheWrite: 0, cacheRead: 0.025 }],
  // --- Google ---
  [/gemini.*pro/i, { input: 2, output: 12, cacheWrite: 0, cacheRead: 0.2 }],
  [/gemini.*flash/i, { input: 1.5, output: 9, cacheWrite: 0, cacheRead: 0.15 }],
  // --- xAI ---
  [/grok/i, { input: 2, output: 6, cacheWrite: 0, cacheRead: 0.5 }],
  // --- Other vendors ---
  [/kimi/i, { input: 0.95, output: 4, cacheWrite: 0, cacheRead: 0.19 }],
  [/mai-code/i, { input: 0.75, output: 4.5, cacheWrite: 0, cacheRead: 0.075 }],
  [/raptor/i, { input: 0.25, output: 2, cacheWrite: 0, cacheRead: 0.025 }],
];

// Fall back to Sonnet rates — a mid-priced, common default. A warning fires
// (once per unknown model) so a genuinely new model surfaces for a rate-card
// update instead of being silently mispriced.
const FALLBACK: ModelPricing = { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 };

const warned = new Set<string>();

export function copilotPricingFor(model: string): ModelPricing {
  for (const [pattern, price] of RATES) {
    if (pattern.test(model)) return price;
  }
  if (!warned.has(model)) {
    warned.add(model);
    console.warn(
      `Copilot: no rate card for model "${model}"; using Sonnet fallback rates. ` +
        `Add it to config/pricing-copilot.ts.`
    );
  }
  return FALLBACK;
}
