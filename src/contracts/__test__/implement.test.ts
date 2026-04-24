import { describe, expect, it } from "vitest";
import {
  ImplementationResultSchema,
  QualityGateResultSchema,
  type ImplementationResult,
} from "../implement.js";

const validResult: ImplementationResult = {
  pr: {
    number: 42,
    url: "https://github.com/acme/ns/pull/42",
    branch: "night-shift/T-12-x",
    baseBranch: "main",
    headSha: "deadbeefcafe",
  },
  qualityGates: [
    { name: "typecheck", status: "passed", durationMs: 1200 },
    { name: "test", status: "passed", durationMs: 3400, logsTail: "ok" },
  ],
  summary: "Implemented login.",
};

describe("ImplementationResultSchema", () => {
  it("parses a valid result", () => {
    expect(ImplementationResultSchema.parse(validResult)).toEqual(validResult);
  });

  it("accepts empty qualityGates", () => {
    const r = { ...validResult, qualityGates: [] };
    expect(() => ImplementationResultSchema.parse(r)).not.toThrow();
  });
});

describe("QualityGateResultSchema", () => {
  it("rejects oversized logsTail", () => {
    const r = {
      name: "test",
      status: "failed" as const,
      durationMs: 10,
      logsTail: "x".repeat(4097),
    };
    expect(() => QualityGateResultSchema.parse(r)).toThrow();
  });

  it("accepts logsTail at max length", () => {
    const r = {
      name: "test",
      status: "failed" as const,
      durationMs: 10,
      logsTail: "x".repeat(4096),
    };
    expect(() => QualityGateResultSchema.parse(r)).not.toThrow();
  });
});
