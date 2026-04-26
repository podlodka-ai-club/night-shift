import path from "node:path";
import type { AgentAdapter, AgentStreamEvent, TurnResult } from "../../adapters/events.js";
import { runTurnWithProgress } from "../../adapters/run-turn.js";
import type { EventSink } from "../../contracts/events.js";
import {
  decideVerdict,
  type Finding,
  type ReviewInput,
  type ReviewResult,
  type Verdict,
} from "../../contracts/review.js";
import type { GitHubClient } from "../../github/client.js";
import { GitHubApiError } from "../../github/errors.js";
import type { ResolvedNightShiftConfig } from "../../config/schema.js";
import { ReviewerResponseJsonSchema, parseReviewerResponse, renderReviewerMessage } from "./prompt.js";
import type { SpecBundleFile, RetryContext } from "./prompt.js";
import { renderLineCommentBody, renderSummaryBody } from "./rendering.js";
import {
  ReviewAgentError,
  ReviewIoError,
  ReviewPhaseError,
  ReviewValidationError,
} from "./errors.js";

export interface ReviewFs {
  readFile(path: string): Promise<string>;
}

export interface ReviewDeps {
  github: GitHubClient;
  agent: AgentAdapter;
  fs: ReviewFs;
  clock: { now(): Date };
  logger?: EventSink;
  onAgentEvent?: (event: AgentStreamEvent) => Promise<void> | void;
  config: ResolvedNightShiftConfig;
  runId: string;
  profileId: string;
  reviewerModel: string;
  workingDirectory?: string;
}

export interface ReviewPhaseInput {
  itemId: string;
  input: ReviewInput;
}

export type ReviewPhaseStatus = "ready_to_merge" | "needs_fix" | "escalated";

export interface ReviewPhaseResult {
  status: ReviewPhaseStatus;
  result: ReviewResult;
}

const NIGHT_SHIFT_MARKER_PREFIX = "<!-- night-shift:marker=";

function isMissingFileError(err: unknown): boolean {
  return (
    (typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === "ENOENT") ||
    (err instanceof Error && /ENOENT/.test(err.message))
  );
}

function isOwnPullRequestReviewRestrictionError(err: unknown): boolean {
  return (
    err instanceof Error &&
    /(approve|request changes on) your own pull request/i.test(err.message)
  );
}

function isUnresolvableReviewCommentError(err: unknown): boolean {
  return (
    err instanceof GitHubApiError
    && err.status === 422
    && /pull_request_review_thread\.(path|line).+could not be resolved/i.test(err.message)
  );
}

function nowIso(clock: { now(): Date }): string {
  return clock.now().toISOString();
}

async function emitSafe(
  sink: EventSink | undefined,
  ev: Parameters<EventSink["emit"]>[0],
) {
  if (!sink) return;
  try {
    await sink.emit(ev);
  } catch {
    // observability sinks MUST never break the phase
  }
}

function verdictToStatus(verdict: Verdict): ReviewPhaseStatus {
  switch (verdict) {
    case "ready-to-merge":
      return "ready_to_merge";
    case "needs-fix":
      return "needs_fix";
    case "escalate":
      return "escalated";
  }
}

function getMaxDiffBytes(config: ResolvedNightShiftConfig): number {
  return config.reviewPhase?.maxDiffBytes ?? 65536;
}

function getEscalationLabel(config: ResolvedNightShiftConfig): string {
  return config.reviewPhase?.escalationLabel ?? "night-shift:escalation";
}

function normalizeFindingLocations(
  findings: Finding[],
  changedFiles: Array<{ path: string }>,
  workingDirectory: string | undefined,
): Finding[] {
  const knownPaths = new Set(changedFiles.map((file) => file.path));

  return findings.map((finding) => {
    if (!finding.location) {
      return finding;
    }

    const rawPath = finding.location.file;
    let normalizedPath = rawPath;

    if (!knownPaths.has(rawPath)) {
      const rawPosix = rawPath.split(path.sep).join("/");
      if (workingDirectory && path.isAbsolute(rawPath)) {
        const relative = path.relative(workingDirectory, rawPath).split(path.sep).join("/");
        if (!relative.startsWith("../") && relative !== ".." && knownPaths.has(relative)) {
          normalizedPath = relative;
        }
      }

      if (!knownPaths.has(normalizedPath)) {
        const suffixMatch = changedFiles.find(
          (file) => rawPosix === file.path || rawPosix.endsWith(`/${file.path}`),
        );
        if (suffixMatch) {
          normalizedPath = suffixMatch.path;
        }
      }
    }

    if (normalizedPath === rawPath) {
      return finding;
    }

    return {
      ...finding,
      location: {
        ...finding.location,
        file: normalizedPath,
      },
    };
  });
}

async function upsertFindingComments(
  github: GitHubClient,
  prNumber: number,
  findings: Finding[],
): Promise<void> {
  for (const finding of findings) {
    if (!finding.location?.line) {
      continue;
    }

    try {
      await github.upsertReviewComment(prNumber, "review:finding", {
        path: finding.location.file,
        line: finding.location.line,
        body: renderLineCommentBody(finding),
      });
    } catch (err) {
      if (isUnresolvableReviewCommentError(err)) {
        continue;
      }
      throw err;
    }
  }
}

export async function runReviewPhase(
  phaseInput: ReviewPhaseInput,
  deps: ReviewDeps,
): Promise<ReviewPhaseResult> {
  const { itemId, input } = phaseInput;
  const { ticket, specBundle, pr, iteration } = input;
  const startTime = deps.clock.now();

  // 6.2 Entry check
  const item = await deps.github.getItem(itemId);
  if (item.status !== "In review") {
    throw new ReviewValidationError(
      `cannot enter Review phase: item ${itemId} is in ${item.status ?? "unknown"}`,
      { ticketId: ticket.id, prNumber: pr.number, iteration },
    );
  }

  // 6.3 Read spec-bundle files
  const bundleFiles: SpecBundleFile[] = [];
  const specPath = specBundle.specPath;
  for (const relPath of ["proposal.md", "design.md", "tasks.md"]) {
    const fullPath = `${specPath}/${relPath}`;
    try {
      const content = await deps.github.getFileContent(fullPath, pr.headSha);
      bundleFiles.push({ path: relPath, content });
    } catch (err) {
      if (relPath === "design.md" && isMissingFileError(err)) {
        continue;
      }
      throw new ReviewIoError(
        `failed to read spec-bundle file: ${fullPath}`,
        { ticketId: ticket.id, prNumber: pr.number, iteration, cause: err },
      );
    }
  }

  // 6.4 Fetch PR context
  const [diff, changedFiles, rawReviewComments] = await Promise.all([
    deps.github.getPullRequestDiff(pr.number),
    deps.github.listChangedFiles(pr.number),
    deps.github.listReviewComments(pr.number),
  ]);

  // Filter out Night-Shift marker comments
  const reviewComments = rawReviewComments.filter(
    (c) => !c.body.startsWith(NIGHT_SHIFT_MARKER_PREFIX),
  );

  // 6.5 Emit phase.started
  await emitSafe(deps.logger, {
    kind: "PhaseStarted",
    ticketId: ticket.id,
    phase: "review",
    profileId: deps.profileId,
    ts: nowIso(deps.clock),
    runId: deps.runId,
    inputSummary: `review PR #${pr.number} iteration ${iteration}`,
  });

  let result: ReviewResult;
  let turnResult: TurnResult | undefined;
  let verdict: Verdict;

  try {
    // 6.6 Reviewer call
    const session = deps.agent.openSession({
      role: "reviewer",
      model: deps.reviewerModel,
      ...(deps.workingDirectory !== undefined
        ? { workingDirectory: deps.workingDirectory }
        : {}),
      runId: deps.runId,
      ticketId: ticket.id,
      profileId: deps.profileId,
    });

    const maxDiffBytes = getMaxDiffBytes(deps.config);
    const message = renderReviewerMessage(
      ticket,
      bundleFiles,
      diff,
      changedFiles,
      reviewComments,
      maxDiffBytes,
    );

    let findings: Finding[];
    let summary: string;

    try {
      turnResult = await runTurnWithProgress(session, message, {
        outputSchema: ReviewerResponseJsonSchema,
      }, deps.onAgentEvent);
      const parsed = parseReviewerResponse(turnResult.finalText, {
        ticketId: ticket.id,
        prNumber: pr.number,
        iteration,
      });
      findings = normalizeFindingLocations(
        parsed.findings,
        changedFiles,
        deps.workingDirectory,
      );
      summary = parsed.summary;
    } catch (err) {
      if (
        err instanceof ReviewAgentError &&
        err.code === "schema" &&
        turnResult
      ) {
        // Retry once with Zod errors
        const retryMessage = renderReviewerMessage(
          ticket,
          bundleFiles,
          diff,
          changedFiles,
          reviewComments,
          maxDiffBytes,
          {
            previousError: (err as Error).message,
            attempt: 1,
          },
        );
        turnResult = await runTurnWithProgress(session, retryMessage, {
          outputSchema: ReviewerResponseJsonSchema,
        }, deps.onAgentEvent);
        const retryParsed = parseReviewerResponse(turnResult.finalText, {
          ticketId: ticket.id,
          prNumber: pr.number,
          iteration,
        });
        findings = normalizeFindingLocations(
          retryParsed.findings,
          changedFiles,
          deps.workingDirectory,
        );
        summary = retryParsed.summary;
      } else {
        throw err;
      }
    } finally {
      await session.close?.();
    }

    // 6.7 Decide verdict
    verdict = decideVerdict(findings, iteration, input.maxIterations);

    result = {
      verdict,
      findings,
      iteration,
      summary,
    };

    // 6.8 Branch on verdict
    const issueNumber = item.issueNumber!;

    if (verdict === "ready-to-merge") {
      await deps.github.setPullRequestReady(pr.number, true);

      // Check for existing Night-Shift review to update
      const existingReviews = await deps.github.listReviews(pr.number);
      const existingReview = existingReviews.find(
        (r) => r.body.includes(NIGHT_SHIFT_MARKER_PREFIX + "review:summary"),
      );
      const summaryBody = `${NIGHT_SHIFT_MARKER_PREFIX}review:summary -->\n${renderSummaryBody(verdict, result, pr)}`;

      if (existingReview) {
        await deps.github.updateReview(pr.number, existingReview.id, {
          body: summaryBody,
        });
      } else {
        try {
          await deps.github.createReview(pr.number, {
            event: "APPROVE",
            body: summaryBody,
          });
        } catch (err) {
          if (!isOwnPullRequestReviewRestrictionError(err)) {
            throw err;
          }
          await deps.github.createReview(pr.number, {
            event: "COMMENT",
            body: summaryBody,
          });
        }
      }

      await upsertFindingComments(deps.github, pr.number, findings);

      // Upsert PR-level summary comment
      await deps.github.upsertComment(
        issueNumber,
        "review:summary",
        renderSummaryBody(verdict, result, pr),
      );

      await deps.github.setStatus(itemId, "Ready to merge");
    } else if (verdict === "needs-fix") {
      // Check for existing Night-Shift review to update
      const existingReviews = await deps.github.listReviews(pr.number);
      const existingReview = existingReviews.find(
        (r) => r.body.includes(NIGHT_SHIFT_MARKER_PREFIX + "review:summary"),
      );
      const summaryBody = `${NIGHT_SHIFT_MARKER_PREFIX}review:summary -->\n${renderSummaryBody(verdict, result, pr)}`;

      if (existingReview) {
        await deps.github.updateReview(pr.number, existingReview.id, {
          body: summaryBody,
        });
      } else {
        try {
          await deps.github.createReview(pr.number, {
            event: "REQUEST_CHANGES",
            body: summaryBody,
          });
        } catch (err) {
          if (!isOwnPullRequestReviewRestrictionError(err)) {
            throw err;
          }
          await deps.github.createReview(pr.number, {
            event: "COMMENT",
            body: summaryBody,
          });
        }
      }

      await upsertFindingComments(deps.github, pr.number, findings);

      // Upsert PR-level summary
      await deps.github.upsertComment(
        issueNumber,
        "review:summary",
        renderSummaryBody(verdict, result, pr),
      );

      await deps.github.setStatus(itemId, "Ready");
    } else {
      // escalate
      const escalationLabel = getEscalationLabel(deps.config);
      await deps.github.addLabels(issueNumber, [escalationLabel]);

      const existingReviews = await deps.github.listReviews(pr.number);
      const existingReview = existingReviews.find(
        (r) => r.body.includes(NIGHT_SHIFT_MARKER_PREFIX + "review:escalation"),
      );
      const escalationBody = `${NIGHT_SHIFT_MARKER_PREFIX}review:escalation -->\n${renderSummaryBody(verdict, result, pr)}`;

      if (existingReview) {
        await deps.github.updateReview(pr.number, existingReview.id, {
          body: escalationBody,
        });
      } else {
        await deps.github.createReview(pr.number, {
          event: "COMMENT",
          body: escalationBody,
        });
      }

      await upsertFindingComments(deps.github, pr.number, findings);

      // Upsert escalation marker comment
      await deps.github.upsertComment(
        issueNumber,
        "review:escalation",
        renderSummaryBody(verdict, result, pr),
      );

      await deps.github.setStatus(itemId, "Blocked");
    }
  } catch (err) {
    // 6.9 Emit phase.finished on error
    const durationMs = deps.clock.now().getTime() - startTime.getTime();
    await emitSafe(deps.logger, {
      kind: "PhaseFailed",
      ticketId: ticket.id,
      phase: "review",
      profileId: deps.profileId,
      ts: nowIso(deps.clock),
      runId: deps.runId,
      error: {
        name: (err as Error).name ?? "Error",
        message: (err as Error).message ?? String(err),
      },
      durationMs,
    });
    throw err;
  }

  // 6.9 Emit phase.finished on success
  const durationMs = deps.clock.now().getTime() - startTime.getTime();
  await emitSafe(deps.logger, {
    kind: "PhaseCompleted",
    ticketId: ticket.id,
    phase: "review",
    profileId: deps.profileId,
    ts: nowIso(deps.clock),
    runId: deps.runId,
    outputSummary: `verdict: ${verdict}, iteration: ${iteration}`,
    durationMs,
    cost: turnResult?.cost ?? 0,
    tokens: {
      input: turnResult?.usage.input_tokens ?? 0,
      output: turnResult?.usage.output_tokens ?? 0,
    },
  });

  // 6.10 Return result
  return {
    status: verdictToStatus(verdict),
    result,
  };
}
