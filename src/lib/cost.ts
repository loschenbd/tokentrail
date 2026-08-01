import { pricingFor } from '../../config/pricing.js';
import { copilotPricingFor } from '../../config/pricing-copilot.js';

export type CostInputs = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
};

export function estimateCostUsd(inputs: CostInputs): number {
  return priceTokens(inputs, pricingFor(inputs.model));
}

// GitHub Copilot's nano-AI-Unit → USD constant. The CLI records a pre-computed
// cost per turn in assistant_usage_events.total_nano_aiu; 1 AI credit = $0.01
// (official) and "AIU" is Copilot's internal name for the credit, so:
//   usd = total_nano_aiu / 1e9 (→ credits) * 0.01 = total_nano_aiu * 1e-11.
// See docs/plans/copilot-pricing-reference.md for the derivation + cross-check.
const NANO_AIU_TO_USD = 1e-11;

// Cost of one Copilot turn. Prefer the CLI's own pre-computed cost
// (total_nano_aiu); fall back to GitHub's resale per-token rate card only when
// it is null/0 (e.g. base-model or legacy rows). These are estimates (rule 3).
export function copilotCostUsd(
  inputs: CostInputs & { totalNanoAiu?: number | null }
): number {
  if (inputs.totalNanoAiu != null && inputs.totalNanoAiu > 0) {
    return round6(inputs.totalNanoAiu * NANO_AIU_TO_USD);
  }
  // Copilot's input_tokens is INCLUSIVE of the cached buckets — verified
  // against a real row (gpt-5-mini: 14494 in / 4352 cache_read / 182 out,
  // total_nano_aiu 300830000 → only input−cache_read reproduces the exact
  // $0.0030083). This differs from Anthropic's API (where input_tokens
  // EXCLUDES cache, so estimateCostUsd adds them). Subtract the cache buckets
  // here so the fallback doesn't bill cached tokens twice.
  const billableInput = Math.max(
    0,
    inputs.inputTokens - inputs.cacheReadTokens - inputs.cacheWriteTokens
  );
  return priceTokens({ ...inputs, inputTokens: billableInput }, copilotPricingFor(inputs.model));
}

function priceTokens(
  inputs: CostInputs,
  price: { input: number; output: number; cacheWrite: number; cacheRead: number }
): number {
  const per = 1_000_000;
  const cost =
    (inputs.inputTokens * price.input) / per +
    (inputs.outputTokens * price.output) / per +
    (inputs.cacheWriteTokens * price.cacheWrite) / per +
    (inputs.cacheReadTokens * price.cacheRead) / per;
  return round6(cost);
}

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}
