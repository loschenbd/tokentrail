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
  return priceTokens(inputs, copilotPricingFor(inputs.model));
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
