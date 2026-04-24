import { describe, expect, it } from "vitest";
import { parseImplementerResponse } from "./parse.js";
import { ImplementAgentError } from "./errors.js";

const valid = {
  filesWritten: [{ path: "src/a.ts", content: "export {}" }],
  commitMessage: "feat: a",
  summary: "ok",
};

describe("parseImplementerResponse", () => {
  it("parses a valid response", () => {
    const out = parseImplementerResponse(JSON.stringify(valid));
    expect(out.filesWritten[0]!.path).toBe("src/a.ts");
  });

  it("throws `parse` on non-JSON", () => {
    try {
      parseImplementerResponse("not json");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ImplementAgentError);
      expect((err as ImplementAgentError).code).toBe("parse");
    }
  });

  it("throws `schema` on empty filesWritten", () => {
    try {
      parseImplementerResponse(
        JSON.stringify({ ...valid, filesWritten: [] }),
      );
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as ImplementAgentError).code).toBe("schema");
    }
  });

  it("rejects `..` path segments", () => {
    try {
      parseImplementerResponse(
        JSON.stringify({
          ...valid,
          filesWritten: [{ path: "../outside.ts", content: "x" }],
        }),
      );
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as ImplementAgentError).code).toBe("schema");
    }
  });

  it("rejects absolute paths", () => {
    try {
      parseImplementerResponse(
        JSON.stringify({
          ...valid,
          filesWritten: [{ path: "/etc/passwd", content: "x" }],
        }),
      );
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as ImplementAgentError).code).toBe("schema");
    }
  });

  it("rejects duplicate paths", () => {
    try {
      parseImplementerResponse(
        JSON.stringify({
          ...valid,
          filesWritten: [
            { path: "a.ts", content: "1" },
            { path: "a.ts", content: "2" },
          ],
        }),
      );
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as ImplementAgentError).code).toBe("schema");
    }
  });
});
