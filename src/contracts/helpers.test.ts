import { describe, expect, it } from "vitest";
import {
  branchNameFor,
  microToUsd,
  slugify,
  usdToMicro,
} from "./helpers.js";

describe("slugify / branchNameFor", () => {
  it("produces a clean slug from a simple title", () => {
    expect(branchNameFor({ id: "T-12", title: "Add user login" })).toBe(
      "night-shift/T-12-add-user-login",
    );
  });

  it("normalises special chars and whitespace", () => {
    expect(
      branchNameFor({ id: "T-7", title: "Fix: FOO/bar   (quick!)" }),
    ).toBe("night-shift/T-7-fix-foo-bar-quick");
  });

  it("truncates slug to at most 50 chars and no trailing dash", () => {
    const longTitle = "word ".repeat(60); // 300 chars
    const name = branchNameFor({ id: "T-9", title: longTitle });
    const slug = name.slice("night-shift/T-9-".length);
    expect(slug.length).toBeLessThanOrEqual(50);
    expect(slug.endsWith("-")).toBe(false);
  });

  it("is deterministic across calls", () => {
    const t = { id: "T-1", title: "Hello World" };
    expect(branchNameFor(t)).toBe(branchNameFor(t));
  });

  it("handles an empty slug by omitting the dash", () => {
    expect(branchNameFor({ id: "T-3", title: "!!!" })).toBe("night-shift/T-3");
  });

  it("handles empty title", () => {
    expect(branchNameFor({ id: "T-4", title: "" })).toBe("night-shift/T-4");
  });

  it("slugify trims leading and trailing separators", () => {
    expect(slugify("  --hello world-- ")).toBe("hello-world");
  });
});

describe("usdToMicro / microToUsd", () => {
  it("round-trips whole cents", () => {
    expect(usdToMicro(0.01)).toBe(10_000);
    expect(microToUsd(10_000)).toBeCloseTo(0.01);
  });

  it("rounds sub-micro values", () => {
    expect(usdToMicro(0.0000005)).toBe(1); // 0.5 micro rounds to 1
  });

  it("rejects negative usd", () => {
    expect(() => usdToMicro(-1)).toThrow(RangeError);
  });

  it("rejects non-integer micro", () => {
    expect(() => microToUsd(1.5)).toThrow(RangeError);
  });
});
