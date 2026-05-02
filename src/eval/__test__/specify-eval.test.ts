import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  evaluateSpecifyFixture,
  evaluateSpecifySuite,
  replayRunner,
  summarise,
  type SpecifyTurnRunner,
} from "../specify-eval.js";
import { SpecifyEvalFixtureSchema, type SpecifyEvalFixture } from "../types.js";

const FIXTURES_DIR = join(process.cwd(), "eval", "fixtures", "specify");

async function loadFixture(name: string): Promise<SpecifyEvalFixture> {
  const raw = await readFile(join(FIXTURES_DIR, name), "utf8");
  return SpecifyEvalFixtureSchema.parse(JSON.parse(raw));
}

const REFINED_TEXT = JSON.stringify({
  files: [
    { path: "proposal.md", content: "# Title\n\nbody" },
    { path: "tasks.md", content: "- [ ] task" },
  ],
  openQuestions: [],
  assumptions: ["a"],
  risks: ["r"],
});

const NEEDS_INPUT_TEXT = JSON.stringify({
  files: [
    { path: "proposal.md", content: "# pending\n" },
    { path: "tasks.md", content: "- [ ] pending\n" },
  ],
  openQuestions: ["what does X mean?"],
  assumptions: [],
  risks: [],
});

const baseFixture: SpecifyEvalFixture = SpecifyEvalFixtureSchema.parse({
  id: "synthetic",
  ticket: { title: "t", description: "d" },
  recordedFinalText: REFINED_TEXT,
  recordedUsage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 50 },
  recordedCostMicroUsd: 1000,
});

describe("evaluateSpecifyFixture (replay)", () => {
  it("classifies refined when openQuestions is empty", async () => {
    const result = await evaluateSpecifyFixture(baseFixture, replayRunner);
    expect(result).toMatchObject({
      id: "synthetic",
      status: "refined",
      openQuestionsCount: 0,
      assumptionsCount: 1,
      risksCount: 1,
      filesCount: 2,
      costMicroUsd: 1000,
      totalTokens: 150,
    });
  });

  it("classifies needs_input when openQuestions is non-empty", async () => {
    const fx: SpecifyEvalFixture = {
      ...baseFixture,
      id: "needs",
      recordedFinalText: NEEDS_INPUT_TEXT,
    };
    const result = await evaluateSpecifyFixture(fx, replayRunner);
    expect(result.status).toBe("needs_input");
    expect(result.openQuestionsCount).toBe(1);
  });

  it("emits parse_error on invalid JSON", async () => {
    const fx: SpecifyEvalFixture = {
      ...baseFixture,
      id: "broken",
      recordedFinalText: "not valid json {",
    };
    const result = await evaluateSpecifyFixture(fx, replayRunner);
    expect(result.status).toBe("parse_error");
    expect(result.errorMessage).toMatch(/JSON/i);
    expect(result.costMicroUsd).toBe(1000);
  });

  it("emits schema_error on JSON missing required files", async () => {
    const fx: SpecifyEvalFixture = {
      ...baseFixture,
      id: "schema",
      recordedFinalText: JSON.stringify({
        files: [{ path: "proposal.md", content: "x" }],
        openQuestions: [],
        assumptions: [],
        risks: [],
      }),
    };
    const result = await evaluateSpecifyFixture(fx, replayRunner);
    expect(result.status).toBe("schema_error");
    expect(result.errorMessage).toMatch(/missing required file/i);
  });

  it("flags expectation mismatch", async () => {
    const fx: SpecifyEvalFixture = {
      ...baseFixture,
      id: "wrong-expect",
      expected: { status: "needs_input" },
    };
    const result = await evaluateSpecifyFixture(fx, replayRunner);
    expect(result.expectationMismatch).toMatch(/expected status/);
  });

  it("flags expectation mismatch on minOpenQuestions", async () => {
    const fx: SpecifyEvalFixture = {
      ...baseFixture,
      id: "min-questions",
      recordedFinalText: NEEDS_INPUT_TEXT,
      expected: { status: "needs_input", minOpenQuestions: 5 },
    };
    const result = await evaluateSpecifyFixture(fx, replayRunner);
    expect(result.expectationMismatch).toMatch(/openQuestions 1 < min 5/);
  });
});

describe("replayRunner", () => {
  it("throws when fixture lacks recordedFinalText", async () => {
    const { recordedFinalText: _omit, ...rest } = baseFixture;
    void _omit;
    await expect(replayRunner.run(rest as SpecifyEvalFixture)).rejects.toThrow(
      /recordedFinalText/,
    );
  });
});

describe("evaluateSpecifySuite + summarise", () => {
  it("aggregates a mixed suite via a custom runner", async () => {
    const fixtures = [
      { ...baseFixture, id: "a", recordedFinalText: REFINED_TEXT, recordedCostMicroUsd: 100 },
      { ...baseFixture, id: "b", recordedFinalText: NEEDS_INPUT_TEXT, recordedCostMicroUsd: 200 },
      { ...baseFixture, id: "c", recordedFinalText: "garbage", recordedCostMicroUsd: 50 },
    ];

    const { results, summary } = await evaluateSpecifySuite(fixtures, replayRunner);

    expect(results).toHaveLength(3);
    expect(summary).toMatchObject({
      total: 3,
      byStatus: { refined: 1, needs_input: 1, parse_error: 1, schema_error: 0 },
      totalCostMicroUsd: 350,
      avgCostMicroUsd: 117,
      expectationMismatches: 0,
    });
  });

  it("supports a fully custom runner (live-mode shape)", async () => {
    const liveRunner: SpecifyTurnRunner = {
      async run(fixture) {
        return {
          finalText: REFINED_TEXT,
          usage: { input_tokens: fixture.ticket.description.length, cached_input_tokens: 0, output_tokens: 10 },
          costMicroUsd: 42,
        };
      },
    };
    const result = await evaluateSpecifyFixture(baseFixture, liveRunner);
    expect(result.status).toBe("refined");
    expect(result.costMicroUsd).toBe(42);
  });

  it("summarise handles empty input", () => {
    expect(summarise([])).toMatchObject({ total: 0, avgCostMicroUsd: 0 });
  });
});

describe("disk fixtures replay end-to-end", () => {
  it("refined-bug-fix → refined and matches expectation", async () => {
    const fx = await loadFixture("refined-bug-fix.json");
    const result = await evaluateSpecifyFixture(fx, replayRunner);
    expect(result.status).toBe("refined");
    expect(result.expectationMismatch).toBeUndefined();
  });

  it("needs-input-vague → needs_input and matches expectation", async () => {
    const fx = await loadFixture("needs-input-vague.json");
    const result = await evaluateSpecifyFixture(fx, replayRunner);
    expect(result.status).toBe("needs_input");
    expect(result.openQuestionsCount).toBeGreaterThanOrEqual(2);
    expect(result.expectationMismatch).toBeUndefined();
  });
});
