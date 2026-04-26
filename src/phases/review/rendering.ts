import type { Finding, Verdict } from "../../contracts/review.js";
import type { ReviewResult } from "../../contracts/review.js";
import { prependNightShiftBadge, prependNightShiftCallout } from "../../github/comment-style.js";

function formatIteration(iteration: number, maxIterations?: number): string {
  const attempt = iteration + 1;
  return maxIterations !== undefined ? `${attempt} of ${maxIterations}` : `${attempt}`;
}

export function renderSummaryBody(
  verdict: Verdict,
  result: ReviewResult,
  pr: { number: number; url: string },
  options: { maxIterations?: number } = {},
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
  parts.push(`**Iteration:** ${formatIteration(result.iteration, options.maxIterations)}`);
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

  return prependNightShiftCallout(parts.join("\n"), {
    label: "Night Shift Reviewer",
    title:
      verdict === "ready-to-merge"
        ? "Automated review approved this change"
        : verdict === "needs-fix"
          ? "Automated review found blocking issues"
          : "Automated review escalated this change",
    tone:
      verdict === "ready-to-merge"
        ? "TIP"
        : verdict === "needs-fix"
          ? "IMPORTANT"
          : "CAUTION",
    details: [
      `Pull request: #${pr.number}`,
      `Review attempt: ${formatIteration(result.iteration, options.maxIterations)}`,
    ],
  });
}

export function renderEscalationCommentBody(
  result: ReviewResult,
  pr: { number: number; url: string },
  maxIterations: number,
): string {
  const errors = result.findings.filter((finding) => finding.severity === "error");
  const warnings = result.findings.filter((finding) => finding.severity === "warning");
  const attempt = formatIteration(result.iteration, maxIterations);
  const parts = [
    "## Review escalation",
    "",
    `Night Shift moved this ticket to **Blocked** because the final allowed review attempt (${attempt}) still found ${errors.length} blocking issue${errors.length === 1 ? "" : "s"} in [PR #${pr.number}](${pr.url}).`,
    "",
    "### Why this was escalated",
    `The workflow is configured for ${maxIterations} review attempt${maxIterations === 1 ? "" : "s"}. Any error-level finding that remains on the final attempt triggers escalation instead of another automatic implement/review loop.`,
  ];

  if (errors.length > 0) {
    parts.push("");
    parts.push("### Blocking issues");
    for (const finding of errors) {
      const location = finding.location
        ? ` (${finding.location.file}${finding.location.line ? `:${finding.location.line}` : ""})`
        : "";
      parts.push(`- ${finding.message}${location}`);
    }
  }

  if (warnings.length > 0) {
    parts.push("");
    parts.push("### Additional warnings");
    for (const finding of warnings) {
      const location = finding.location
        ? ` (${finding.location.file}${finding.location.line ? `:${finding.location.line}` : ""})`
        : "";
      parts.push(`- ${finding.message}${location}`);
    }
  }

  parts.push("");
  parts.push("### What to do next");
  parts.push("- Fix the blocking issues in the PR.");
  parts.push("- Move the ticket back to **Ready** to resume Night Shift.");

  return prependNightShiftCallout(parts.join("\n"), {
    label: "Night Shift Escalation",
    title: "Automated review paused this ticket",
    tone: "CAUTION",
    details: [
      `Pull request: #${pr.number}`,
      `Final review attempt: ${attempt}`,
    ],
  });
}

export function renderLineCommentBody(finding: Finding): string {
  const parts: string[] = [finding.message];
  if (finding.specRef) {
    parts.push("");
    parts.push(`_Ref: ${finding.specRef}_`);
  }
  return prependNightShiftBadge(parts.join("\n"), "Night Shift review finding");
}
