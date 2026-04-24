import { describe, expect, it } from "vitest";
import { SpecBundleSchema, validateSpecBundle, type SpecBundle } from "../specify.js";
import type { Ticket } from "../ticket.js";

const ticket: Ticket = {
  id: "T-12",
  title: "Add user login",
  description: "",
  status: "Refined",
  labels: [],
  url: "https://github.com/acme/ns/issues/12",
  source: "github",
  sourceRef: {
    kind: "github",
    projectNodeId: "p",
    projectItemId: "i",
    repoOwner: "acme",
    repoName: "ns",
    issueNumber: 12,
  },
};

const validBundle: SpecBundle = {
  specPath: "/repo/openspec/changes/T-12/",
  branch: "night-shift/T-12-add-user-login",
  openQuestions: ["Which OAuth provider?"],
  assumptions: ["User accounts exist"],
  risks: ["Scope creep"],
  commitSha: "abc1234def5678",
};

describe("SpecBundleSchema", () => {
  it("parses a valid bundle", () => {
    expect(SpecBundleSchema.parse(validBundle)).toEqual(validBundle);
  });

  it("allows empty arrays", () => {
    const b = { ...validBundle, openQuestions: [], assumptions: [], risks: [] };
    expect(() => SpecBundleSchema.parse(b)).not.toThrow();
  });

  it("rejects non-hex commitSha", () => {
    const b = { ...validBundle, commitSha: "not-a-sha" };
    expect(() => SpecBundleSchema.parse(b)).toThrow();
  });
});

describe("validateSpecBundle", () => {
  it("returns ok when branch matches", () => {
    expect(validateSpecBundle(ticket, validBundle)).toEqual({ ok: true });
  });

  it("returns error when branch mismatches", () => {
    const bad = { ...validBundle, branch: "wrong" };
    const r = validateSpecBundle(ticket, bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("does not match");
  });
});
