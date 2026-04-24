import { describe, expect, it } from "vitest";
import { PRICING, computeCost } from "./pricing.js";
import type { ModelPricing } from "./types.js";

describe("computeCost", () => {
  const testPricing: ModelPricing = { inputPer1M: 1.5, outputPer1M: 10.0 };
  const overrides = { "test-model": testPricing };

  it("returns integer micro-USD for a known model", () => {
    const cost = computeCost(
      "test-model",
      { input_tokens: 1_000_000, output_tokens: 0, cached_input_tokens: 0 },
      overrides,
    );
    expect(Number.isInteger(cost)).toBe(true);
    expect(cost).toBe(1_500_000);
  });

  it("prices input and output independently", () => {
    const cost = computeCost(
      "test-model",
      { input_tokens: 100_000, output_tokens: 50_000, cached_input_tokens: 0 },
      overrides,
    );
    // 100k * 1.5 = 150_000; 50k * 10 = 500_000; total 650_000
    expect(cost).toBe(650_000);
  });

  it("returns 0 for an unknown model", () => {
    const cost = computeCost("nope", {
      input_tokens: 999_999,
      output_tokens: 999_999,
      cached_input_tokens: 0,
    });
    expect(cost).toBe(0);
  });

  it("prices cached tokens separately when configured", () => {
    const cost = computeCost(
      "cached-model",
      { input_tokens: 1_000_000, output_tokens: 0, cached_input_tokens: 200_000 },
      {
        "cached-model": {
          inputPer1M: 1.0,
          outputPer1M: 0,
          cachedInputPer1M: 0.1,
        },
      },
    );
    // 800k * 1.0 = 800_000 ; 200k * 0.1 = 20_000 ; total 820_000
    expect(cost).toBe(820_000);
  });

  it("falls back to inputPer1M when cachedInputPer1M is missing", () => {
    const cost = computeCost(
      "flat-model",
      { input_tokens: 500_000, output_tokens: 0, cached_input_tokens: 100_000 },
      { "flat-model": { inputPer1M: 2.0, outputPer1M: 0 } },
    );
    // All 500k input at 2.0 → 1_000_000
    expect(cost).toBe(1_000_000);
  });

  it("built-in gpt-5.4 entry exists and is valid", () => {
    expect(PRICING["gpt-5.4"]).toBeDefined();
    const cost = computeCost("gpt-5.4", {
      input_tokens: 1_000,
      output_tokens: 100,
      cached_input_tokens: 0,
    });
    expect(cost).toBeGreaterThan(0);
    expect(Number.isInteger(cost)).toBe(true);
  });

  it("rejects negative pricing in an override", () => {
    expect(() =>
      computeCost(
        "bad-model",
        { input_tokens: 1, output_tokens: 0, cached_input_tokens: 0 },
        { "bad-model": { inputPer1M: -1, outputPer1M: 0 } },
      ),
    ).toThrow();
  });
});
