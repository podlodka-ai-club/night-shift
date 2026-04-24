import { describe, expect, it } from "vitest";
import { renderLineCommentBody, renderSummaryBody } from "../rendering.js";
import type { ReviewResult, Finding } from "../../../contracts/review.js";

const basePr = { number: 42, url: "https://github.com/acme/widgets/pull/42" };

function makeResult(overrides: Partial<ReviewResult> = {}): ReviewResult {
  return {
    verdict: "ready-to-merge",
    findings: [],
    iteration: 0,
    summary: "All clear",
    ...overrides,
  };
}

describe("renderSummaryBody", () => {
  it("ready-to-merge with no findings", () => {
    const body = renderSummaryBody("ready-to-merge", makeResult(), basePr);
    expect(body).toContain("✅ Ready to merge");
    expect(body).toContain("#42");
    expect(body).toContain("All clear");
  });

  it("ready-to-merge with warnings", () => {
    const result = makeResult({
      findings: [
        { severity: "warning", message: "minor issue", location: { file: "src/a.ts", line: 10 } },
      ],
    });
    const body = renderSummaryBody("ready-to-merge", result, basePr);
    expect(body).toContain("✅ Ready to merge");
    expect(body).toContain("### Warnings");
    expect(body).toContain("minor issue");
    expect(body).not.toContain("### Errors");
  });

  it("needs-fix with errors", () => {
    const result = makeResult({
      verdict: "needs-fix",
      findings: [
        { severity: "error", message: "missing test", location: { file: "src/b.ts" } },
      ],
    });
    const body = renderSummaryBody("needs-fix", result, basePr);
    expect(body).toContain("❌ Needs fix");
    expect(body).toContain("### Errors");
    expect(body).toContain("missing test");
  });

  it("escalate with errors", () => {
    const result = makeResult({
      verdict: "escalate",
      findings: [
        { severity: "error", message: "design flaw" },
      ],
    });
    const body = renderSummaryBody("escalate", result, basePr);
    expect(body).toContain("⚠️ Escalated");
    expect(body).toContain("### Errors");
  });
});

describe("renderLineCommentBody", () => {
  it("renders message only", () => {
    const finding: Finding = { severity: "warning", message: "style issue" };
    expect(renderLineCommentBody(finding)).toBe("style issue");
  });

  it("renders message with specRef", () => {
    const finding: Finding = {
      severity: "error",
      message: "missing validation",
      specRef: "spec.md#requirement-1",
    };
    const body = renderLineCommentBody(finding);
    expect(body).toContain("missing validation");
    expect(body).toContain("_Ref: spec.md#requirement-1_");
  });
});
