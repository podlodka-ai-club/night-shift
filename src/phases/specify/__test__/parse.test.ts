import { describe, expect, it } from "vitest";
import { parseResponse } from "../parse.js";
import { SpecifyAgentError } from "../errors.js";
import { SpecifierResponseJsonSchema } from "../response.js";

const goodFiles = [
  { path: "proposal.md", content: "## Why\nbecause\n## What Changes\n- x\n" },
  { path: "tasks.md", content: "- [ ] 1.1 do stuff\n" },
];

describe("parseResponse", () => {
  it("returns the parsed response on happy path", () => {
    const raw = JSON.stringify({
      files: goodFiles,
      openQuestions: [],
      assumptions: [],
      risks: [],
    });
    const out = parseResponse(raw);
    expect(out.files).toHaveLength(2);
  });

  it("admits design.md and specs/<cap>/spec.md deltas", () => {
    const raw = JSON.stringify({
      files: [
        ...goodFiles,
        { path: "design.md", content: "notes" },
        { path: "specs/my-cap/spec.md", content: "## ADDED Requirements\n" },
      ],
      openQuestions: [],
      assumptions: [],
      risks: [],
    });
    expect(() => parseResponse(raw)).not.toThrow();
  });

  it("non-JSON input throws parse", () => {
    try {
      parseResponse("not json");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SpecifyAgentError);
      expect((err as SpecifyAgentError).code).toBe("parse");
    }
  });

  it("missing proposal.md throws schema", () => {
    const raw = JSON.stringify({
      files: [{ path: "tasks.md", content: "x" }],
      openQuestions: [],
      assumptions: [],
      risks: [],
    });
    try {
      parseResponse(raw);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SpecifyAgentError);
      expect((err as SpecifyAgentError).code).toBe("schema");
    }
  });

  it("path escape attempts throw schema", () => {
    const raw = JSON.stringify({
      files: [
        { path: "../escape.md", content: "x" },
        { path: "tasks.md", content: "x" },
      ],
      openQuestions: [],
      assumptions: [],
      risks: [],
    });
    try {
      parseResponse(raw);
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as SpecifyAgentError).code).toBe("schema");
    }
  });

  it("wrong extension throws schema", () => {
    const raw = JSON.stringify({
      files: [
        { path: "proposal.txt", content: "x" },
        { path: "tasks.md", content: "x" },
      ],
      openQuestions: [],
      assumptions: [],
      risks: [],
    });
    expect(() => parseResponse(raw)).toThrow(SpecifyAgentError);
  });

  it("empty arrays for openQuestions/assumptions/risks are allowed", () => {
    const raw = JSON.stringify({
      files: goodFiles,
      openQuestions: [],
      assumptions: [],
      risks: [],
    });
    expect(() => parseResponse(raw)).not.toThrow();
  });
});

describe("SpecifierResponseJsonSchema", () => {
  it("is a plain object schema ready for outputSchema consumption", () => {
    expect(typeof SpecifierResponseJsonSchema).toBe("object");
    const s = SpecifierResponseJsonSchema as Record<string, unknown>;
    expect(s.type).toBe("object");
    expect(s.$ref).toBeUndefined();
    expect(s.definitions).toBeUndefined();
  });
});
