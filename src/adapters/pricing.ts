import { ModelPricingSchema, type ModelPricing, type TokenUsage } from "./types.js";

/**
 * Built-in pricing table. Values are USD per 1M tokens.
 *
 * TODO: verify exact gpt-5.4 pricing against upstream; placeholder values
 * are based on the GPT-5 family at the time of writing. Callers can
 * override via `pricingOverrides` on `createAgent` / adapter constructor.
 */
export const PRICING: Readonly<Record<string, ModelPricing>> = Object.freeze({
  "gpt-5.4": {
    inputPer1M: 1.25,
    outputPer1M: 10.0,
    cachedInputPer1M: 0.125,
  },
  // Cheap placeholder used in examples/tests.
  "gpt-5.4-mini": {
    inputPer1M: 0.25,
    outputPer1M: 2.0,
    cachedInputPer1M: 0.025,
  },
});

/**
 * Compute the cost of a turn in integer micro-USD.
 *
 * Rules:
 * - Unknown model → returns 0 (never throws; caller may emit a warning).
 * - Cached input tokens are priced at `cachedInputPer1M` when present,
 *   otherwise they share `inputPer1M`.
 * - Uncached input tokens = `input_tokens - cached_input_tokens`.
 *   (Codex reports `input_tokens` as the grand total.)
 * - Output tokens priced at `outputPer1M`.
 *
 * Result is rounded to the nearest integer micro-USD to avoid float drift.
 */
export function computeCost(
  model: string,
  usage: TokenUsage,
  overrides?: Readonly<Record<string, ModelPricing>>,
): number {
  const pricing = overrides?.[model] ?? PRICING[model];
  if (!pricing) return 0;

  // Validate pricing shape for safety when callers pass overrides.
  ModelPricingSchema.parse(pricing);

  const cached = Math.min(usage.cached_input_tokens, usage.input_tokens);
  const uncachedInput = usage.input_tokens - cached;

  // micro-USD = tokens * USDper1M, since 1 USD = 1_000_000 micro-USD and
  // "USD per 1M tokens" over 1M tokens numerically cancels to "micro-USD per token".
  const microFromInput = uncachedInput * pricing.inputPer1M;
  const cachedRate = pricing.cachedInputPer1M ?? pricing.inputPer1M;
  const microFromCached = cached * cachedRate;
  const microFromOutput = usage.output_tokens * pricing.outputPer1M;

  return Math.round(microFromInput + microFromCached + microFromOutput);
}
