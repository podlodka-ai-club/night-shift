import { describe, expect, it } from "vitest";
import {
  FindingSchema,
  ReviewResultSchema,
  decideVerdict,
  type Finding,
} from "../review.js";

const err: Finding = { severity: "error", message: "bad" };
const warn: Finding = { severity: "warning", message: "meh" };

describe("decideVerdict", () => {
  it("no errors yields ready-to-merge regardless of warnings", () => {
    expect(decideVerdict([warn, warn], 0)).toBe("ready-to-merge");
    expect(decideVerdict([], 2)).toBe("ready-to-merge");
  });

  it("errors on iteration 0 yield needs-fix", () => {
    expect(decideVerdict([err], 0)).toBe("needs-fix");
  });

  it("errors on iteration 1 yield needs-fix", () => {
    expect(decideVerdict([err], 1)).toBe("needs-fix");
  });

  it("errors on iteration 2 escalate", () => {
    expect(decideVerdict([err], 2)).toBe("escalate");
  });
});

describe("FindingSchema", () => {
  it("rejects severity info", () => {
    expect(() => FindingSchema.parse({ severity: "info", message: "x" })).toThrow();
  });

  it("accepts optional location and specRef", () => {
    const f = {
      severity: "error",
      message: "x",
      location: { file: "a.ts", line: 10 },
      specRef: "phase-contracts#R1",
    };
    expect(() => FindingSchema.parse(f)).not.toThrow();
  });
});

describe("ReviewResultSchema", () => {
  it("parses a valid result", () => {
    const r = {
      verdict: "ready-to-merge",
      findings: [],
      iteration: 0,
      summary: "ok",
    };
    expect(ReviewResultSchema.parse(r)).toEqual(r);
  });
});
