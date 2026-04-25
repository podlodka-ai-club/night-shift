import { Context } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
import type { AgentStreamEvent } from "../adapters/events.js";
import type { SpecifyResult } from "../phases/specify/phase.js";
import type { ImplementResult } from "../phases/implement/phase.js";
import type { ReviewPhaseResult } from "../phases/review/phase.js";
import type { ReviewInput } from "../contracts/review.js";
import { runSpecifyPhase } from "../phases/specify/phase.js";
import { runImplementPhase } from "../phases/implement/phase.js";
import { runReviewPhase } from "../phases/review/phase.js";
import { SpecifyPhaseError } from "../phases/specify/errors.js";
import { ImplementPhaseError } from "../phases/implement/errors.js";
import { ReviewPhaseError } from "../phases/review/errors.js";
import { ActivityProgressReporter } from "./activity-progress.js";

// ── Activity input types (JSON-serializable) ──────────────────────────

export interface SpecifyActivityInput {
  itemId: string;
  changeName: string;
}

export interface ImplementActivityInput {
  itemId: string;
  changeName: string;
}

export interface ReviewActivityInput {
  itemId: string;
  reviewInput: ReviewInput;
}

export interface MarkPhaseFailureActivityInput {
  itemId: string;
  changeName: string;
  phase: "specify" | "implement" | "review";
  rootCause: string;
  nextStepStatus: "Backlog" | "Ready";
}

// ── Deps factory (set once by the worker on startup) ──────────────────

export interface ActivityDepsFactory {
  buildSpecifyDeps(
    runId: string,
    profileId: string,
  ): Parameters<typeof runSpecifyPhase>[0];
  buildImplementDeps(
    runId: string,
    profileId: string,
  ): Parameters<typeof runImplementPhase>[0];
  buildReviewDeps(
    runId: string,
    profileId: string,
  ): Parameters<typeof runReviewPhase>[1];
  /** Signal the parent workflow with activity progress Markdown. Optional for backward compat. */
  signalProgress?: (workflowId: string, md: string) => Promise<void>;
}

interface ProgressAwareDeps {
  onAgentEvent?: (event: AgentStreamEvent) => Promise<void> | void;
}

let _depsFactory: ActivityDepsFactory | undefined;

export function setActivityDepsFactory(factory: ActivityDepsFactory): void {
  _depsFactory = factory;
}

function getDepsFactory(): ActivityDepsFactory {
  if (!_depsFactory) {
    throw new Error("Activity deps factory not initialized. Call setActivityDepsFactory first.");
  }
  return _depsFactory;
}

// ── Error classification ──────────────────────────────────────────────

function isNonRetryable(err: unknown): boolean {
  if (err instanceof SpecifyPhaseError) return true;
  if (err instanceof ImplementPhaseError) {
    return err.code === "validation" || err.code === "parse" || err.code === "schema";
  }
  if (err instanceof ReviewPhaseError) {
    return err.code === "validation" || err.code === "parse" || err.code === "schema";
  }
  return false;
}

function wrapIfNonRetryable(err: unknown): never {
  if (isNonRetryable(err)) {
    const e = err as Error;
    throw ApplicationFailure.create({
      message: e.message,
      type: e.constructor.name,
      nonRetryable: true,
      cause: e,
    });
  }
  throw err;
}

// ── Activity implementations ──────────────────────────────────────────

function createReporter(phaseName: string): ActivityProgressReporter | null {
  const factory = getDepsFactory();
  if (!factory.signalProgress) return null;
  const workflowId = Context.current().info.workflowExecution.workflowId;
  const signalFn = (md: string) => factory.signalProgress!(workflowId, md);
  return new ActivityProgressReporter({ signalFn, phaseName });
}

function attachProgressObserver<T extends object>(
  deps: T,
  reporter: ActivityProgressReporter | null,
): T & ProgressAwareDeps {
  if (!reporter) {
    return deps as T & ProgressAwareDeps;
  }

  return Object.assign(deps, {
    onAgentEvent: async (event: AgentStreamEvent) => {
      try {
        await reporter.push(event);
      } catch {
        // progress signalling must not break the underlying phase
      }
    },
  });
}

function getGitHubClientForPhase(
  phase: MarkPhaseFailureActivityInput["phase"],
  runId: string,
  profileId: string,
) {
  const factory = getDepsFactory();
  switch (phase) {
    case "specify":
      return factory.buildSpecifyDeps(runId, profileId).github;
    case "implement":
      return factory.buildImplementDeps(runId, profileId).github;
    case "review":
      return factory.buildReviewDeps(runId, profileId).github;
  }
}

function capitalizePhase(phase: MarkPhaseFailureActivityInput["phase"]): string {
  return phase.charAt(0).toUpperCase() + phase.slice(1);
}

function formatPhaseFailureComment(input: MarkPhaseFailureActivityInput): string {
  return [
    `## ${capitalizePhase(input.phase)} attempt blocked`,
    "",
    `This workflow attempt stopped during the **${capitalizePhase(input.phase)}** phase.`,
    "",
    "### Root cause",
    "```text",
    input.rootCause,
    "```",
    "",
    "### Suggested next step",
    `Fix the underlying issue, then move the ticket to **${input.nextStepStatus}** to start a fresh attempt.`,
    "",
    `Change: ${input.changeName}`,
  ].join("\n");
}

export async function markPhaseFailureActivity(
  input: MarkPhaseFailureActivityInput,
  runId: string,
  profileId: string,
): Promise<void> {
  const github = getGitHubClientForPhase(input.phase, runId, profileId);
  const item = await github.getItem(input.itemId);

  await github.setStatus(input.itemId, "Blocked");

  if (item.issueNumber === undefined) {
    return;
  }

  await github.upsertComment(
    item.issueNumber,
    "workflow:phase-failure",
    formatPhaseFailureComment(input),
  );
}

export async function specifyActivity(
  input: SpecifyActivityInput,
  runId: string,
  profileId: string,
): Promise<SpecifyResult> {
  Context.current().heartbeat();
  const reporter = createReporter("specify");
  const deps = attachProgressObserver(
    getDepsFactory().buildSpecifyDeps(runId, profileId),
    reporter,
  );
  let result!: SpecifyResult;
  try {
    result = await runSpecifyPhase(deps, {
      itemId: input.itemId,
      changeName: input.changeName,
    });
  } catch (err) {
    wrapIfNonRetryable(err);
  } finally {
    await reporter?.flush();
  }
  return result;
}

export async function implementActivity(
  input: ImplementActivityInput,
  runId: string,
  profileId: string,
): Promise<ImplementResult> {
  Context.current().heartbeat();
  const reporter = createReporter("implement");
  const deps = attachProgressObserver(
    getDepsFactory().buildImplementDeps(runId, profileId),
    reporter,
  );
  let result!: ImplementResult;
  try {
    result = await runImplementPhase(deps, {
      itemId: input.itemId,
      changeName: input.changeName,
    });
  } catch (err) {
    wrapIfNonRetryable(err);
  } finally {
    await reporter?.flush();
  }
  return result;
}

export async function reviewActivity(
  input: ReviewActivityInput,
  runId: string,
  profileId: string,
): Promise<ReviewPhaseResult> {
  Context.current().heartbeat();
  const reporter = createReporter("review");
  const deps = attachProgressObserver(
    getDepsFactory().buildReviewDeps(runId, profileId),
    reporter,
  );
  let result!: ReviewPhaseResult;
  try {
    result = await runReviewPhase(
      { itemId: input.itemId, input: input.reviewInput },
      deps,
    );
  } catch (err) {
    wrapIfNonRetryable(err);
  } finally {
    await reporter?.flush();
  }
  return result;
}
