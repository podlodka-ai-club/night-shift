import { describe, expect, it } from "vitest";
import { ClaudeAgentAdapter } from "./claude-agent.js";

describe("ClaudeAgentAdapter", () => {
  it("throws from openSession", () => {
    const a = new ClaudeAgentAdapter();
    expect(a.provider).toBe("claude-agent");
    expect(() =>
      a.openSession({
        role: "specifier",
        model: "m",
        runId: "r",
        ticketId: "t",
        profileId: "p",
      }),
    ).toThrow(/not implemented/);
  });
});
