import type { Finding, Verdict } from "../../contracts/review.js";
import type { ReviewResult } from "../../contracts/review.js";

export function renderSummaryBody(
  verdict: Verdict,
  result: ReviewResult,
  pr: { number: number; url: string },
): string {
  const parts: string[] = [];

  const header =
    verdict === "ready-to-merge"
      ? "## ✅ Ready to merge"
      : verdict === "needs-fix"
        ? "## ❌ Needs fix"
        : "## ⚠️ Escalated";

  parts.push(header);
  parts.push("");
  parts.push(`**PR:** [#${pr.number}](${pr.url})`);
  parts.push(`**Iteration:** ${result.iteration}`);
  parts.push("");
  parts.push("### Summary");
  parts.push(result.summary);

  const errors = result.findings.filter((f) => f.severity === "error");
  const warnings = result.findings.filter((f) => f.severity === "warning");

  if (errors.length > 0) {
    parts.push("");
    parts.push("### Errors");
    for (const f of errors) {
      const loc = f.location ? ` (${f.location.file}${f.location.line ? `:${f.location.line}` : ""})` : "";
      parts.push(`- ${f.message}${loc}`);
    }
  }

  if (warnings.length > 0) {
    parts.push("");
    parts.push("### Warnings");
    for (const f of warnings) {
      const loc = f.location ? ` (${f.location.file}${f.location.line ? `:${f.location.line}` : ""})` : "";
      parts.push(`- ${f.message}${loc}`);
    }
  }

  return parts.join("\n");
}

export function renderLineCommentBody(finding: Finding): string {
  const parts: string[] = [finding.message];
  if (finding.specRef) {
    parts.push("");
    parts.push(`_Ref: ${finding.specRef}_`);
  }
  return parts.join("\n");
}
