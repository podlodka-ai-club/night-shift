import { describe, expect, it } from "vitest";
import {
  ImplementAgentError,
  ImplementGitError,
  ImplementIoError,
  ImplementPhaseError,
  ImplementValidationError,
} from "./errors.js";

describe("implement phase errors", () => {
  it("codes are exhaustive for the known subclasses", () => {
    const agent = new ImplementAgentError("agent", "x");
    const parse = new ImplementAgentError("parse", "x");
    const schema = new ImplementAgentError("schema", "x");
    const val = new ImplementValidationError("x");
    const git = new ImplementGitError("x");
    const push = new ImplementGitError("x", { code: "push_rejected" });
    const io = new ImplementIoError("x");
    expect(agent.code).toBe("agent");
    expect(parse.code).toBe("parse");
    expect(schema.code).toBe("schema");
    expect(val.code).toBe("validation");
    expect(git.code).toBe("git");
    expect(push.code).toBe("push_rejected");
    expect(io.code).toBe("io");
  });

  it("every subclass is an ImplementPhaseError and an Error", () => {
    const e = new ImplementValidationError("oops", { ticketId: "t-1" });
    expect(e).toBeInstanceOf(ImplementPhaseError);
    expect(e).toBeInstanceOf(Error);
    expect(e.ticketId).toBe("t-1");
  });

  it("message includes the worktree path when provided", () => {
    const e = new ImplementGitError("push failed", {
      worktreePath: "/tmp/ns/t-1",
    });
    expect(e.message).toContain("/tmp/ns/t-1");
    expect(e.worktreePath).toBe("/tmp/ns/t-1");
  });

  it("latencyMs is preserved when provided", () => {
    const e = new ImplementAgentError("agent", "slow", { latencyMs: 1234 });
    expect(e.latencyMs).toBe(1234);
  });

  it("wraps a cause when provided", () => {
    const cause = new Error("boom");
    const e = new ImplementIoError("read failed", { cause });
    expect(e.cause).toBe(cause);
  });
});
