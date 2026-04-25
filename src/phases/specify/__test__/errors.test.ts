import { describe, expect, it } from "vitest";
import {
  SpecifyAgentError,
  SpecifyGitError,
  SpecifyItemMissingError,
  SpecifyPhaseError,
  SpecifyValidationError,
} from "../errors.js";

describe("specify errors", () => {
  it("SpecifyItemMissingError carries item_missing code", () => {
    const e = new SpecifyItemMissingError("PVTI_x");
    expect(e).toBeInstanceOf(SpecifyPhaseError);
    expect(e.code).toBe("item_missing");
    expect(e.message).toContain("PVTI_x");
  });

  it("SpecifyAgentError admits parse/schema/agent codes and preserves ticketId/latencyMs", () => {
    const e = new SpecifyAgentError("parse", "nope", { ticketId: "T1", latencyMs: 42 });
    expect(e).toBeInstanceOf(SpecifyPhaseError);
    expect(e.code).toBe("parse");
    expect(e.ticketId).toBe("T1");
    expect(e.latencyMs).toBe(42);
  });

  it("SpecifyValidationError code is validation", () => {
    const e = new SpecifyValidationError("bad");
    expect(e).toBeInstanceOf(SpecifyPhaseError);
    expect(e.code).toBe("validation");
  });

  it("SpecifyGitError code is git", () => {
    const e = new SpecifyGitError("push failed");
    expect(e).toBeInstanceOf(SpecifyPhaseError);
    expect(e.code).toBe("git");
  });

  it("propagates cause through Error options", () => {
    const root = new Error("root");
    const e = new SpecifyAgentError("agent", "outer", { cause: root });
    expect(e.cause).toBe(root);
  });
});
