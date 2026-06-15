import { pricingFor } from '../../config/pricing.js';

export type CostInputs = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
};

export function estimateCostUsd(inputs: CostInputs): number {
  const price = pricingFor(inputs.model);
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
