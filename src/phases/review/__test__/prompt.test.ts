import { describe, expect, it } from "vitest";
import {
  parseReviewerResponse,
  renderReviewerMessage,
  ReviewerResponseSchema,
} from "../prompt.js";
import { ReviewAgentError } from "../errors.js";
import type { Ticket } from "../../../contracts/ticket.js";
import type { ChangedFile, ReviewComment } from "../../../github/types.js";

const ticket: Ticket = {
  id: "acme/widgets#1",
  title: "Add feature",
  description: "Implement the feature",
  status: "In review",
  labels: [],
  url: "https://github.com/acme/widgets/issues/1",
  source: "github",
  sourceRef: {
    kind: "github",
    projectNodeId: "PVT_1",
    projectItemId: "PVTI_1",
    repoOwner: "acme",
    repoName: "widgets",
    issueNumber: 1,
  },
};

const specBundle = [
  { path: "proposal.md", content: "# Proposal\nSome proposal" },
];

const changedFiles: ChangedFile[] = [
  { path: "src/a.ts", additions: 10, deletions: 2, status: "modified" },
  { path: "src/b.ts", additions: 5, deletions: 0, status: "added" },
];

describe("parseReviewerResponse", () => {
  it("parses a valid response", () => {
    const input = JSON.stringify({
      summary: "Looks good",
      findings: [
        { severity: "warning", message: "minor style issue" },
      ],
    });
    const result = parseReviewerResponse(input);
    expect(result.summary).toBe("Looks good");
    expect(result.findings).toHaveLength(1);
  });

  it("throws parse error on non-JSON", () => {
    expect(() => parseReviewerResponse("LGTM")).toThrow(ReviewAgentError);
    try {
      parseReviewerResponse("LGTM");
    } catch (err) {
      expect((err as ReviewAgentError).code).toBe("parse");
    }
  });

  it("throws schema error on bad severity", () => {
    const input = JSON.stringify({
      summary: "ok",
      findings: [{ severity: "oops", message: "x" }],
    });
    expect(() => parseReviewerResponse(input)).toThrow(ReviewAgentError);
    try {
      parseReviewerResponse(input);
    } catch (err) {
      expect((err as ReviewAgentError).code).toBe("schema");
    }
  });

  it("accepts empty findings", () => {
    const input = JSON.stringify({ summary: "All clear", findings: [] });
    const result = parseReviewerResponse(input);
    expect(result.findings).toEqual([]);
  });
});

describe("renderReviewerMessage", () => {
  it("includes diff truncation sentinel when diff exceeds cap", () => {
    const largeDiff = "a".repeat(200_000);
    const msg = renderReviewerMessage(
      ticket,
      specBundle,
      largeDiff,
      changedFiles,
      [],
      65536,
    );
    expect(msg).toContain("diff truncated at 65536 bytes");
  });

  it("includes files breakdown when truncated", () => {
    const largeDiff = "a".repeat(200_000);
    const msg = renderReviewerMessage(
      ticket,
      specBundle,
      largeDiff,
      changedFiles,
      [],
      65536,
    );
    expect(msg).toContain("src/a.ts");
    expect(msg).toContain("src/b.ts");
    expect(msg).toContain("Changed files breakdown");
  });

  it("passes through short diff unchanged", () => {
    const shortDiff = "diff --git a/src/a.ts b/src/a.ts\n+added line";
    const msg = renderReviewerMessage(
      ticket,
      specBundle,
      shortDiff,
      changedFiles,
      [],
      65536,
    );
    expect(msg).toContain(shortDiff);
    expect(msg).not.toContain("diff truncated");
  });

  it("filters Night-Shift marker comments from review comments", () => {
    const comments: ReviewComment[] = [
      { id: 1, body: "<!-- night-shift:marker=review:summary -->\nOld review", path: "src/a.ts", line: 1 },
      { id: 2, body: "Human comment", path: "src/b.ts", line: 5 },
    ];
    const msg = renderReviewerMessage(
      ticket,
      specBundle,
      "diff",
      changedFiles,
      comments,
      65536,
    );
    expect(msg).toContain("Human comment");
    expect(msg).not.toContain("Old review");
  });
});
