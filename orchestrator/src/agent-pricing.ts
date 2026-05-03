import { z } from 'zod';

export interface TokenUsage {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
}

export interface ModelPricing {
  inputPer1M: number;
  outputPer1M: number;
  cachedInputPer1M?: number;
}

const modelPricingSchema = z.object({
  inputPer1M: z.number().nonnegative(),
  outputPer1M: z.number().nonnegative(),
  cachedInputPer1M: z.number().nonnegative().optional(),
});

export const MODEL_PRICING: Readonly<Record<string, ModelPricing>> = Object.freeze({
  'gpt-5.3-codex': {
    inputPer1M: 1.25,
    outputPer1M: 10.0,
    cachedInputPer1M: 0.125,
  },
  'gpt-5.4': {
    inputPer1M: 1.25,
    outputPer1M: 10.0,
    cachedInputPer1M: 0.125,
  },
  'gpt-5.4-mini': {
    inputPer1M: 0.25,
    outputPer1M: 2.0,
    cachedInputPer1M: 0.025,
  },
  'claude-sonnet-4-6': {
    inputPer1M: 3.0,
    outputPer1M: 15.0,
    cachedInputPer1M: 0.3,
  },
  'claude-opus-4-7': {
    inputPer1M: 15.0,
    outputPer1M: 75.0,
    cachedInputPer1M: 1.5,
  },
  'claude-haiku-4-5': {
    inputPer1M: 1.0,
    outputPer1M: 5.0,
    cachedInputPer1M: 0.1,
  },
});

export function computeModelCostMicroUsd(
  model: string,
  usage: TokenUsage,
  overrides?: Readonly<Record<string, ModelPricing>>,
): number | undefined {
  const pricing = overrides?.[model] ?? MODEL_PRICING[model];
  if (!pricing) {
    return undefined;
  }

  modelPricingSchema.parse(pricing);
  const cachedTokens = Math.min(usage.cached_input_tokens, usage.input_tokens);
  const uncachedTokens = usage.input_tokens - cachedTokens;
  const cachedRate = pricing.cachedInputPer1M ?? pricing.inputPer1M;

  return Math.round(
    uncachedTokens * pricing.inputPer1M
      + cachedTokens * cachedRate
      + usage.output_tokens * pricing.outputPer1M,
  );
}