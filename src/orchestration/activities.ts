import { Context } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
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

export async function specifyActivity(
  input: SpecifyActivityInput,
  runId: string,
  profileId: string,
): Promise<SpecifyResult> {
  Context.current().heartbeat();
  const reporter = createReporter("specify");
  const deps = getDepsFactory().buildSpecifyDeps(runId, profileId);
  try {
    return await runSpecifyPhase(deps, {
      itemId: input.itemId,
      changeName: input.changeName,
    });
  } catch (err) {
    await reporter?.flush();
    wrapIfNonRetryable(err);
  }
  await reporter?.flush();
}

export async function implementActivity(
  input: ImplementActivityInput,
  runId: string,
  profileId: string,
): Promise<ImplementResult> {
  Context.current().heartbeat();
  const reporter = createReporter("implement");
  const deps = getDepsFactory().buildImplementDeps(runId, profileId);
  try {
    return await runImplementPhase(deps, {
      itemId: input.itemId,
      changeName: input.changeName,
    });
  } catch (err) {
    await reporter?.flush();
    wrapIfNonRetryable(err);
  }
  await reporter?.flush();
}

export async function reviewActivity(
  input: ReviewActivityInput,
  runId: string,
  profileId: string,
): Promise<ReviewPhaseResult> {
  Context.current().heartbeat();
  const reporter = createReporter("review");
  const deps = getDepsFactory().buildReviewDeps(runId, profileId);
  try {
    return await runReviewPhase(
      { itemId: input.itemId, input: input.reviewInput },
      deps,
    );
  } catch (err) {
    await reporter?.flush();
    wrapIfNonRetryable(err);
  }
  await reporter?.flush();
}
