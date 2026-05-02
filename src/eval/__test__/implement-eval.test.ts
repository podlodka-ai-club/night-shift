import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  evaluateImplementFixture,
  evaluateImplementSuite,
  implementReplayRunner,
  summariseImplement,
  type ImplementTurnRunner,
} from "../implement-eval.js";
import { ImplementEvalFixtureSchema, type ImplementEvalFixture } from "../types.js";

const FIXTURES_DIR = join(process.cwd(), "eval", "fixtures", "implement");

async function loadFixture(name: string): Promise<ImplementEvalFixture> {
  const raw = await readFile(join(FIXTURES_DIR, name), "utf8");
  return ImplementEvalFixtureSchema.parse(JSON.parse(raw));
}

const PRODUCED_TEXT = JSON.stringify({
  filesWritten: [
    { path: "src/foo.ts", content: "export const x = 1;\n" },
    { path: "src/foo.test.ts", content: "test('x', () => {});\n" },
  ],
  commitMessage: "feat: add foo",
  summary: "Implements foo per proposal.md AC1.",
  followUps: ["run tests"],
});

const EMPTY_TEXT = JSON.stringify({
  filesWritten: [],
  commitMessage: "chore: no-op",
  summary: "Verified no changes needed.",
  followUps: [],
});

const baseFixture: ImplementEvalFixture = ImplementEvalFixtureSchema.parse({
  id: "synthetic",
  ticket: { title: "t", description: "d" },
  specBundle: [{ path: "proposal.md", content: "# P\n" }],
  recordedFinalText: PRODUCED_TEXT,
  recordedUsage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 50 },
  recordedCostMicroUsd: 1000,
});

describe("evaluateImplementFixture (replay)", () => {
  it("classifies produced when filesWritten is non-empty", async () => {
    const result = await evaluateImplementFixture(baseFixture, implementReplayRunner);
    expect(result).toMatchObject({
      id: "synthetic",
      status: "produced",
      filesWrittenCount: 2,
      followUpsCount: 1,
      costMicroUsd: 1000,
      totalTokens: 150,
    });
    expect(result.totalContentChars).toBeGreaterThan(0);
    expect(result.commitMessageLength).toBeGreaterThan(0);
    expect(result.summaryLength).toBeGreaterThan(0);
  });

  it("classifies empty when filesWritten is []", async () => {
    const fx: ImplementEvalFixture = {
      ...baseFixture,
      id: "empty",
      recordedFinalText: EMPTY_TEXT,
    };
    const result = await evaluateImplementFixture(fx, implementReplayRunner);
    expect(result.status).toBe("empty");
    expect(result.filesWrittenCount).toBe(0);
    expect(result.totalContentChars).toBe(0);
  });

  it("emits parse_error on invalid JSON", async () => {
    const fx: ImplementEvalFixture = {
      ...baseFixture,
      id: "broken",
      recordedFinalText: "not valid json {",
    };
    const result = await evaluateImplementFixture(fx, implementReplayRunner);
    expect(result.status).toBe("parse_error");
    expect(result.errorMessage).toMatch(/JSON/i);
    expect(result.costMicroUsd).toBe(1000);
  });

  it("emits schema_error on JSON missing required fields", async () => {
    const fx: ImplementEvalFixture = {
      ...baseFixture,
      id: "schema-missing",
      recordedFinalText: JSON.stringify({
        filesWritten: [{ path: "src/foo.ts", content: "x" }],
      }),
    };
    const result = await evaluateImplementFixture(fx, implementReplayRunner);
    expect(result.status).toBe("schema_error");
    expect(result.errorMessage).toMatch(/schema/i);
  });

  it("emits schema_error on absolute path", async () => {
    const fx: ImplementEvalFixture = {
      ...baseFixture,
      id: "schema-abs",
      recordedFinalText: JSON.stringify({
        filesWritten: [{ path: "/etc/foo.ts", content: "x" }],
        commitMessage: "c",
        summary: "s",
        followUps: [],
      }),
    };
    const result = await evaluateImplementFixture(fx, implementReplayRunner);
    expect(result.status).toBe("schema_error");
  });

  it("flags expectation mismatch on status", async () => {
    const fx: ImplementEvalFixture = {
      ...baseFixture,
      id: "wrong-expect",
      expected: { status: "empty" },
    };
    const result = await evaluateImplementFixture(fx, implementReplayRunner);
    expect(result.expectationMismatch).toMatch(/expected status/);
  });

  it("flags expectation mismatch on minFilesWritten", async () => {
    const fx: ImplementEvalFixture = {
      ...baseFixture,
      id: "min-files",
      expected: { status: "produced", minFilesWritten: 5 },
    };
    const result = await evaluateImplementFixture(fx, implementReplayRunner);
    expect(result.expectationMismatch).toMatch(/filesWritten 2 < min 5/);
  });

  it("flags expectation mismatch on maxFilesWritten", async () => {
    const fx: ImplementEvalFixture = {
      ...baseFixture,
      id: "max-files",
      expected: { status: "produced", maxFilesWritten: 1 },
    };
    const result = await evaluateImplementFixture(fx, implementReplayRunner);
    expect(result.expectationMismatch).toMatch(/filesWritten 2 > max 1/);
  });
});

describe("implementReplayRunner", () => {
  it("throws when fixture lacks recordedFinalText", async () => {
    const { recordedFinalText: _omit, ...rest } = baseFixture;
    void _omit;
    await expect(
      implementReplayRunner.run(rest as ImplementEvalFixture),
    ).rejects.toThrow(/recordedFinalText/);
  });
});

describe("evaluateImplementSuite + summariseImplement", () => {
  it("aggregates a mixed suite", async () => {
    const fixtures: ImplementEvalFixture[] = [
      { ...baseFixture, id: "a", recordedFinalText: PRODUCED_TEXT, recordedCostMicroUsd: 100 },
      { ...baseFixture, id: "b", recordedFinalText: EMPTY_TEXT, recordedCostMicroUsd: 200 },
      { ...baseFixture, id: "c", recordedFinalText: "garbage", recordedCostMicroUsd: 50 },
    ];

    const { results, summary } = await evaluateImplementSuite(fixtures, implementReplayRunner);

    expect(results).toHaveLength(3);
    expect(summary).toMatchObject({
      total: 3,
      byStatus: { produced: 1, empty: 1, parse_error: 1, schema_error: 0 },
      totalCostMicroUsd: 350,
      avgCostMicroUsd: 117,
      expectationMismatches: 0,
    });
  });

  it("supports a fully custom runner (live-mode shape)", async () => {
    const liveRunner: ImplementTurnRunner = {
      async run(fixture) {
        return {
          finalText: PRODUCED_TEXT,
          usage: {
            input_tokens: fixture.ticket.description.length,
            cached_input_tokens: 0,
            output_tokens: 10,
          },
          costMicroUsd: 42,
        };
      },
    };
    const result = await evaluateImplementFixture(baseFixture, liveRunner);
    expect(result.status).toBe("produced");
    expect(result.costMicroUsd).toBe(42);
  });

  it("summariseImplement handles empty input", () => {
    expect(summariseImplement([])).toMatchObject({ total: 0, avgCostMicroUsd: 0 });
  });
});

describe("disk fixtures replay end-to-end", () => {
  it("refined-bug-fix → produced", async () => {
    const fx = await loadFixture("refined-bug-fix.json");
    const result = await evaluateImplementFixture(fx, implementReplayRunner);
    expect(result.status).toBe("produced");
    expect(result.filesWrittenCount).toBeGreaterThan(0);
  });

  it("empty-no-changes → empty", async () => {
    const fx = await loadFixture("empty-no-changes.json");
    const result = await evaluateImplementFixture(fx, implementReplayRunner);
    expect(result.status).toBe("empty");
  });

  it("parse-error-prose → parse_error", async () => {
    const fx = await loadFixture("parse-error-prose.json");
    const result = await evaluateImplementFixture(fx, implementReplayRunner);
    expect(result.status).toBe("parse_error");
  });

  it("schema-error-absolute-path → schema_error", async () => {
    const fx = await loadFixture("schema-error-absolute-path.json");
    const result = await evaluateImplementFixture(fx, implementReplayRunner);
    expect(result.status).toBe("schema_error");
  });
});
