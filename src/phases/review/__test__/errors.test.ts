import { describe, expect, it } from "vitest";
import {
  ReviewAgentError,
  ReviewGitHubError,
  ReviewIoError,
  ReviewPhaseError,
  ReviewValidationError,
} from "../errors.js";

describe("ReviewPhaseError hierarchy", () => {
  const ALL_CODES = ["validation", "parse", "schema", "provider", "github", "io"] as const;

  it("codes are enumerated", () => {
    const instances = [
      new ReviewValidationError("v"),
      new ReviewAgentError("parse", "p"),
      new ReviewAgentError("schema", "s"),
      new ReviewAgentError("provider", "pr"),
      new ReviewGitHubError("g"),
      new ReviewIoError("i"),
    ];
    const actual = instances.map((e) => e.code).sort();
    expect(actual).toEqual([...ALL_CODES].sort());
  });

  it("every subclass is instanceof ReviewPhaseError", () => {
    expect(new ReviewValidationError("x")).toBeInstanceOf(ReviewPhaseError);
    expect(new ReviewAgentError("parse", "x")).toBeInstanceOf(ReviewPhaseError);
    expect(new ReviewGitHubError("x")).toBeInstanceOf(ReviewPhaseError);
    expect(new ReviewIoError("x")).toBeInstanceOf(ReviewPhaseError);
  });

  it("message formatting includes prNumber + iteration when present", () => {
    const err = new ReviewPhaseError("validation", "bad status", {
      prNumber: 42,
      iteration: 1,
    });
    expect(err.message).toContain("pr=#42");
    expect(err.message).toContain("iteration=1");
  });

  it("message omits suffix when no prNumber/iteration", () => {
    const err = new ReviewPhaseError("validation", "bad status");
    expect(err.message).toBe("bad status");
  });

  it("carries optional fields", () => {
    const err = new ReviewPhaseError("io", "missing file", {
      ticketId: "T-1",
      prNumber: 5,
      iteration: 0,
      latencyMs: 123,
    });
    expect(err.ticketId).toBe("T-1");
    expect(err.prNumber).toBe(5);
    expect(err.iteration).toBe(0);
    expect(err.latencyMs).toBe(123);
  });
});
