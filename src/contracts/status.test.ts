import { describe, expect, it } from "vitest";
import {
  TICKET_STATUSES,
  TicketStatusSchema,
  canTransition,
  type TicketStatus,
} from "./status.js";

describe("TicketStatus", () => {
  it("accepts all 7 declared values", () => {
    for (const s of TICKET_STATUSES) {
      expect(TicketStatusSchema.parse(s)).toBe(s);
    }
  });

  it("rejects unknown status literal", () => {
    expect(() => TicketStatusSchema.parse("Done")).toThrow();
  });
});

describe("canTransition", () => {
  const happyPath: [TicketStatus, TicketStatus][] = [
    ["Backlog", "Refinement"],
    ["Refinement", "Refined"],
    ["Refined", "Ready"],
    ["Ready", "In progress"],
    ["In progress", "In review"],
    ["In review", "Ready to merge"],
  ];

  it.each(happyPath)("allows %s -> %s", (from, to) => {
    expect(canTransition(from, to)).toBe(true);
  });

  it("allows escalation In review -> Refinement", () => {
    expect(canTransition("In review", "Refinement")).toBe(true);
  });

  it("allows escalation In review -> Ready", () => {
    expect(canTransition("In review", "Ready")).toBe(true);
  });

  it("rejects skipping phases (Backlog -> Ready)", () => {
    expect(canTransition("Backlog", "Ready")).toBe(false);
  });

  it("rejects reverse transitions (Ready to merge -> In review)", () => {
    expect(canTransition("Ready to merge", "In review")).toBe(false);
  });

  it("rejects identity (Ready -> Ready)", () => {
    expect(canTransition("Ready", "Ready")).toBe(false);
  });
});
