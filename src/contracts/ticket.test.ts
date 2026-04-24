import { describe, expect, it } from "vitest";
import {
  TicketSchema,
  type Ticket,
} from "./ticket.js";
import type { GitHubSourceRef } from "./sources.js";

const validTicket: Ticket = {
  id: "T-12",
  title: "Add user login",
  description: "Let users log in with GitHub OAuth.",
  status: "Refinement",
  labels: ["feature", "auth"],
  url: "https://github.com/acme/night-shift/issues/12",
  source: "github",
  sourceRef: {
    kind: "github",
    projectNodeId: "PVT_kwDOB1abc",
    projectItemId: "PVTI_lADOB1abc",
    repoOwner: "acme",
    repoName: "night-shift",
    issueNumber: 12,
  } satisfies GitHubSourceRef,
};

describe("TicketSchema", () => {
  it("round-trips through JSON unchanged", () => {
    const raw = JSON.parse(JSON.stringify(validTicket));
    const parsed = TicketSchema.parse(raw);
    expect(parsed).toEqual(validTicket);
  });

  it("rejects missing required fields", () => {
    const { id: _id, ...missingId } = validTicket;
    expect(() => TicketSchema.parse(missingId)).toThrow();
  });

  it("rejects unknown source", () => {
    const bad = { ...validTicket, source: "gitlab" };
    expect(() => TicketSchema.parse(bad)).toThrow();
  });

  it("rejects mismatched sourceRef.kind", () => {
    const bad = {
      ...validTicket,
      sourceRef: { ...validTicket.sourceRef, kind: "gitlab" },
    };
    expect(() => TicketSchema.parse(bad)).toThrow();
  });
});
