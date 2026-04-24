import { describe, expect, it } from "vitest";
import { renderUserMessage } from "../prompt.js";
import type { Ticket } from "../../../contracts/ticket.js";
import type { Comment } from "../../../github/types.js";

function ticket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: "TICKET-1",
    title: "Add feature",
    description: "Body",
    status: "Backlog",
    labels: ["feat"],
    url: "https://example.com/1",
    source: "github",
    sourceRef: {
      kind: "github",
      projectNodeId: "PN",
      projectItemId: "PI",
      repoOwner: "o",
      repoName: "r",
      issueNumber: 1,
    },
    ...overrides,
  };
}

function comment(body: string, authorLogin = "alice"): Comment {
  return {
    id: 1,
    body,
    authorLogin,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

describe("renderUserMessage", () => {
  it("includes title, description, labels, and comments", () => {
    const msg = renderUserMessage(ticket(), [comment("first thought")]);
    expect(msg).toContain("TICKET-1: Add feature");
    expect(msg).toContain("Labels: feat");
    expect(msg).toContain("Body");
    expect(msg).toContain("first thought");
    expect(msg).toContain("@alice");
  });

  it("omits Comments section when none present", () => {
    const msg = renderUserMessage(ticket(), []);
    expect(msg).not.toContain("## Comments");
  });

  it("renders prior draft section when provided", () => {
    const msg = renderUserMessage(ticket(), [], [
      { path: "proposal.md", content: "## Why\nold\n" },
    ]);
    expect(msg).toContain("## Current draft");
    expect(msg).toContain("### proposal.md");
    expect(msg).toContain("## Why");
  });
});
