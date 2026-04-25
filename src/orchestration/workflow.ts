import {
  proxyActivities,
  defineSignal,
  defineQuery,
  setHandler,
  condition,
  workflowInfo,
  setCurrentDetails,
} from "@temporalio/workflow";
import type {
  specifyActivity,
  implementActivity,
  reviewActivity,
} from "./activities.js";

// ── Types ─────────────────────────────────────────────────────────────

export interface TicketWorkflowInput {
  itemId: string;
  ticketId: string;
  changeName: string;
  profileId?: string;
  maxReviewIterations?: number;
  startPhase?: "specify" | "implement";
}

export type BlockedReason =
  | "specify_needs_input"
  | "awaiting_spec_review"
  | "implement_needs_input"
  | "review_escalation"
  | null;

export interface PhaseEntry {
  name: "specify" | "implement" | "review";
  startedAt: number;
  finishedAt?: number;
  result?: string;
  iteration?: number;
}

// ── Dashboard helpers ─────────────────────────────────────────────────

export function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return sec > 0 ? `${min}m ${sec}s` : `${min}m`;
}

const PHASE_NAMES = ["Specify", "Implement", "Review"] as const;
const PHASE_EMOJI: Record<string, string> = { specify: "⏳", implement: "⏳", review: "⏳" };

export interface DashboardState {
  ticketId: string;
  changeName: string;
  currentPhase: "specify" | "implement" | "review" | "done";
  blockedReason: BlockedReason;
  reviewIteration: number;
  maxIterations: number;
  costRollup: { totalMicroUsd: number; totalTokens: number };
  phases: PhaseEntry[];
  activityDetail?: string;
  skippedPhases?: Set<string>;
}

export function renderDashboard(s: DashboardState): string {
  const lines: string[] = [];

  // Header
  lines.push(`## 🎫 ${s.ticketId} — ${s.changeName}`);
  lines.push("");

  // Phase pipeline
  const pipeline = PHASE_NAMES.map((p) => {
    const key = p.toLowerCase() as "specify" | "implement" | "review";
    if (s.skippedPhases?.has(key)) return `⏭ ${p}`;
    const done = s.phases.some((e) => e.name === key && e.finishedAt != null);
    if (key === s.currentPhase && !done) return `**⏳ ${p}**`;
    if (done) return `✅ ${p}`;
    return p;
  }).join(" → ");
  lines.push(`**Phase:** ${pipeline}`);

  // Status
  if (s.currentPhase === "done") {
    lines.push("**Status:** ✅ Completed");
  } else if (s.blockedReason) {
    lines.push(`**Status:** 🔴 Blocked — ${s.blockedReason}`);
  } else {
    lines.push("**Status:** 🟢 Running");
  }

  // Review iteration (only show during review)
  if (s.currentPhase === "review") {
    lines.push(`**Review:** iteration ${s.reviewIteration}/${s.maxIterations}`);
  }

  // Cost
  const usd = (s.costRollup.totalMicroUsd / 1_000_000).toFixed(2);
  lines.push(`**Cost:** $${usd} (${s.costRollup.totalTokens} tokens)`);

  // Activity detail (live agent events)
  if (s.activityDetail) {
    lines.push("");
    lines.push(s.activityDetail);
  }

  // Timeline
  const completed = s.phases.filter((p) => p.finishedAt != null);
  if (completed.length > 0) {
    lines.push("");
    lines.push("### Timeline");
    lines.push("| Phase | Duration | Result |");
    lines.push("|-------|----------|--------|");
    for (const p of completed) {
      const dur = p.finishedAt != null ? formatDuration(p.finishedAt - p.startedAt) : "—";
      const name = p.name.charAt(0).toUpperCase() + p.name.slice(1);
      const result = p.result ?? "—";
      const iter = p.iteration != null ? ` (iter ${p.iteration})` : "";
      lines.push(`| ${name} | ${dur} | ${result}${iter} |`);
    }
  }

  return lines.join("\n");
}

// ── Signals & Queries ─────────────────────────────────────────────────

export const specifyRetrySignal = defineSignal("specifyRetry");
export const specReviewedSignal = defineSignal("specReviewed");
export const implementRetrySignal = defineSignal("implementRetry");
export const resumeSignal = defineSignal("resume");
export const activityProgressSignal = defineSignal<[string]>("activityProgress");

export const getBlockedReasonQuery = defineQuery<BlockedReason>("getBlockedReason");

// ── Activity stubs ────────────────────────────────────────────────────

const { specifyActivity: specify, implementActivity: implement, reviewActivity: review } =
  proxyActivities<{
    specifyActivity: typeof specifyActivity;
    implementActivity: typeof implementActivity;
    reviewActivity: typeof reviewActivity;
  }>({
    startToCloseTimeout: "15 minutes",
    heartbeatTimeout: "1 minute",
    retry: {
      initialInterval: "1s",
      backoffCoefficient: 2,
      maximumInterval: "30s",
      maximumAttempts: 5,
    },
  });

// ── Workflow ───────────────────────────────────────────────────────────

export async function ticketWorkflow(input: TicketWorkflowInput): Promise<void> {
  const runId = workflowInfo().workflowId;
  const profileId = input.profileId ?? "default";
  const maxIterations = input.maxReviewIterations ?? 2;

  // State
  let blockedReason: BlockedReason = null;
  let costRollup = { totalMicroUsd: 0, totalTokens: 0 };
  let currentPhase: DashboardState["currentPhase"] = input.startPhase === "implement" ? "implement" : "specify";
  let reviewIteration = 0;
  const phases: PhaseEntry[] = [];
  let activityDetail = "";
  const skippedPhases = new Set<string>();

  if (input.startPhase === "implement") {
    skippedPhases.add("specify");
  }

  function updateDashboard() {
    setCurrentDetails(renderDashboard({
      ticketId: input.ticketId,
      changeName: input.changeName,
      currentPhase,
      blockedReason,
      reviewIteration,
      maxIterations,
      costRollup,
      phases,
      activityDetail,
      skippedPhases,
    }));
  }

  // Signal flags (consumed-flag pattern to prevent buffered-signal leakage)
  let specifyRetryRequested = false;
  let specReviewedRequested = false;
  let implementRetryRequested = false;
  let resumeRequested = false;

  // Register signal handlers
  setHandler(specifyRetrySignal, () => {
    specifyRetryRequested = true;
  });
  setHandler(specReviewedSignal, () => {
    specReviewedRequested = true;
  });
  setHandler(implementRetrySignal, () => {
    implementRetryRequested = true;
  });
  setHandler(resumeSignal, () => {
    resumeRequested = true;
  });
  setHandler(activityProgressSignal, (md: string) => {
    activityDetail = md;
    updateDashboard();
  });

  // Register query handler
  setHandler(getBlockedReasonQuery, () => blockedReason);

  // Initial dashboard
  updateDashboard();

  // ── Specify phase ─────────────────────────────────────────────────

  if (input.startPhase !== "implement") {
    let specifyDone = false;
    while (!specifyDone) {
      const specStart = Date.now();
      const specResult = await specify(
        { itemId: input.itemId, changeName: input.changeName },
        runId,
        profileId,
      );
      activityDetail = "";
      phases.push({ name: "specify", startedAt: specStart, finishedAt: Date.now(), result: specResult.status });
      updateDashboard();

      if (specResult.status === "refined") {
        // Wait for human to review the spec
        blockedReason = "awaiting_spec_review";
        specReviewedRequested = false;
        specifyRetryRequested = false;
        updateDashboard();

        await condition(
          () => specReviewedRequested || specifyRetryRequested,
        );

        if (specReviewedRequested) {
          specReviewedRequested = false;
          blockedReason = null;
          specifyDone = true;
          updateDashboard();
        } else {
          // Operator requested changes (specifyRetry from Refined)
          specifyRetryRequested = false;
          blockedReason = null;
          updateDashboard();
          // Loop continues → re-run specify
        }
      } else {
        // needs_input
        blockedReason = "specify_needs_input";
        specifyRetryRequested = false;
        updateDashboard();

        await condition(() => specifyRetryRequested);
        specifyRetryRequested = false;
        blockedReason = null;
        updateDashboard();
        // Loop continues → re-run specify
      }
    }
  }

  // ── Implement phase ───────────────────────────────────────────────

  currentPhase = "implement";
  updateDashboard();

  let implementDone = false;
  while (!implementDone) {
    const implStart = Date.now();
    const implResult = await implement(
      { itemId: input.itemId, changeName: input.changeName },
      runId,
      profileId,
    );
    activityDetail = "";
    phases.push({ name: "implement", startedAt: implStart, finishedAt: Date.now(), result: implResult.status });
    updateDashboard();

    if (implResult.status === "pr_opened") {
      implementDone = true;
    } else {
      // needs_input
      blockedReason = "implement_needs_input";
      implementRetryRequested = false;
      updateDashboard();

      await condition(() => implementRetryRequested);
      implementRetryRequested = false;
      blockedReason = null;
      updateDashboard();
      // Loop continues → re-run implement
    }
  }

  // ── Review loop ───────────────────────────────────────────────────

  currentPhase = "review";
  updateDashboard();

  let reviewDone = false;
  while (!reviewDone) {
    let escalated = false;

    for (let iteration = 0; iteration < maxIterations; iteration++) {
      reviewIteration = iteration;
      updateDashboard();

      if (iteration > 0) {
        // Re-run implement before re-reviewing (needs_fix path)
        const fixStart = Date.now();
        await implement(
          { itemId: input.itemId, changeName: input.changeName },
          runId,
          profileId,
        );
        activityDetail = "";
        phases.push({ name: "implement", startedAt: fixStart, finishedAt: Date.now(), result: "fix", iteration });
        updateDashboard();
      }

      const revStart = Date.now();
      const reviewResult = await review(
        {
          itemId: input.itemId,
          reviewInput: {
            ticket: { id: input.ticketId, title: "", description: "", status: "In review" as any, labels: [], url: "", source: "github" as const, sourceRef: { kind: "github" as const, projectNodeId: "", projectItemId: input.itemId, repoOwner: "", repoName: "", issueNumber: 0 } },
            specBundle: { specPath: "", branch: "", openQuestions: [], assumptions: [], risks: [], commitSha: "0000000" },
            pr: { number: 0, url: "", branch: "", baseBranch: "main", headSha: "0000000" },
            iteration,
          },
        },
        runId,
        profileId,
      );

      if (reviewResult.status === "ready_to_merge") {
        activityDetail = "";
        phases.push({ name: "review", startedAt: revStart, finishedAt: Date.now(), result: "ready_to_merge", iteration });
        reviewDone = true;
        currentPhase = "done";
        updateDashboard();
        break;
      }

      if (reviewResult.status === "escalated") {
        activityDetail = "";
        phases.push({ name: "review", startedAt: revStart, finishedAt: Date.now(), result: "escalated", iteration });
        blockedReason = "review_escalation";
        resumeRequested = false;
        updateDashboard();

        await condition(() => resumeRequested);
        resumeRequested = false;
        blockedReason = null;
        escalated = true;
        updateDashboard();
        break; // Break inner loop, outer while restarts from iteration 0
      }

      // needs_fix: continue loop (next iteration will re-run implement)
      activityDetail = "";
      phases.push({ name: "review", startedAt: revStart, finishedAt: Date.now(), result: "needs_fix", iteration });
      updateDashboard();
    }

    // If we finished all iterations without ready_to_merge or escalation → max iterations exhausted
    if (!reviewDone && !escalated) {
      blockedReason = "review_escalation";
      resumeRequested = false;
      updateDashboard();

      await condition(() => resumeRequested);
      resumeRequested = false;
      blockedReason = null;
      updateDashboard();
      // Outer loop restarts review from iteration 0
    }
  }
}
