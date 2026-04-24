import { describe, expect, it } from "vitest";
import {
  ImplementationResultSchema,
  PhaseEventSchema,
  ReviewResultSchema,
  SpecBundleSchema,
  TicketSchema,
  type ImplementationResult,
  type PhaseEvent,
  type ReviewResult,
  type SpecBundle,
  type Ticket,
} from "./index.js";

const ticket: Ticket = {
  id: "T-1",
  title: "X",
  description: "",
  status: "Ready",
  labels: [],
  url: "https://example.com/x",
  source: "github",
  sourceRef: {
    kind: "github",
    projectNodeId: "p",
    projectItemId: "i",
    repoOwner: "a",
    repoName: "b",
    issueNumber: 1,
  },
};

const specBundle: SpecBundle = {
  specPath: "/x",
  branch: "night-shift/T-1-x",
  openQuestions: [],
  assumptions: [],
  risks: [],
  commitSha: "abc1234",
};

const implResult: ImplementationResult = {
  pr: {
    number: 1,
    url: "https://example.com/pr/1",
    branch: "b",
    baseBranch: "main",
    headSha: "abc1234",
  },
  qualityGates: [],
  specReview: { subagentSummary: "", blockingIssues: [] },
  summary: "",
};

const reviewResult: ReviewResult = {
  verdict: "ready-to-merge",
  findings: [],
  iteration: 0,
  summary: "",
};

const phaseEvent: PhaseEvent = {
  kind: "PhaseStarted",
  ticketId: "T-1",
  phase: "specify",
  profileId: "default",
  ts: "2026-04-24T12:00:00Z",
  runId: "r1",
  inputSummary: "",
};

describe("JSON-safety", () => {
  it.each([
    ["Ticket", TicketSchema, ticket],
    ["SpecBundle", SpecBundleSchema, specBundle],
    ["ImplementationResult", ImplementationResultSchema, implResult],
    ["ReviewResult", ReviewResultSchema, reviewResult],
    ["PhaseEvent", PhaseEventSchema, phaseEvent],
  ] as const)("%s round-trips through JSON", (_name, schema, fixture) => {
    const roundTripped = JSON.parse(JSON.stringify(fixture));
    const parsed = schema.parse(roundTripped);
    expect(parsed).toEqual(fixture);
  });
});
