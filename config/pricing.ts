// Per-million-token USD pricing by Claude model.
// Update as Anthropic publishes new rate cards. These are estimates only.
//
// References:
//   https://docs.anthropic.com/en/docs/about-claude/pricing
//
// `cacheWrite` is billed per "cache_creation_input_tokens" (5m default;
// 1h ephemeral cache is more expensive — we approximate with a single rate
// since the JSONL splits ephemeral_5m vs ephemeral_1h but doesn't always
// surface a clear total). `cacheRead` matches "cache_read_input_tokens".

export type ModelPricing = {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
};

const opus: ModelPricing = {
  input: 15,
  output: 75,
  cacheWrite: 18.75,
  cacheRead: 1.5,
};

const sonnet: ModelPricing = {
  input: 3,
  output: 15,
  cacheWrite: 3.75,
  cacheRead: 0.3,
};

const haiku: ModelPricing = {
  input: 0.8,
  output: 4,
  cacheWrite: 1,
  cacheRead: 0.08,
};

// Match on substring of the model id. First match wins.
const RULES: ReadonlyArray<readonly [RegExp, ModelPricing]> = [
  [/opus/i, opus],
  [/sonnet/i, sonnet],
  [/haiku/i, haiku],
];

const FALLBACK: ModelPricing = sonnet;

export function pricingFor(model: string): ModelPricing {
  for (const [pattern, price] of RULES) {
    if (pattern.test(model)) return price;
  }
  return FALLBACK;
}
