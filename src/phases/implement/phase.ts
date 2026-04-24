import path from "node:path";
import type { AgentAdapter, TurnResult } from "../../adapters/events.js";
import type { EventSink } from "../../contracts/events.js";
import { branchNameFor } from "../../contracts/helpers.js";
import type {
  ImplementationResult,
  QualityGateResult as ContractQualityGateResult,
} from "../../contracts/implement.js";
import { ImplementationResultSchema } from "../../contracts/implement.js";
import type { SpecBundle } from "../../contracts/specify.js";
import type { Ticket } from "../../contracts/ticket.js";
import type { GitOps } from "../../git/index.js";
import type { GitHubClient } from "../../github/client.js";
import { GitHubPushRejectedError } from "../../github/errors.js";
import type { Comment } from "../../github/types.js";
import type {
  QualityGate,
  QualityGateRunner,
} from "../../quality-gates/index.js";
import type { WorktreeOps } from "../../worktree/index.js";
import {
  ImplementAgentError,
  ImplementGitError,
  ImplementIoError,
  ImplementPhaseError,
  ImplementValidationError,
} from "./errors.js";
import { parseImplementerResponse } from "./parse.js";
import {
  IMPLEMENTER_SYSTEM_PROMPT,
  renderImplementerMessage,
  type SpecBundleFile,
} from "./prompt.js";
import {
  ImplementerResponseJsonSchema,
  type ImplementerResponse,
} from "./response.js";

/**
 * Filesystem surface the phase needs. Kept minimal so tests can drive
 * without touching disk. The CLI wrapper provides the real impl.
 */
export interface ImplementFs {
  readSpecBundle(specPath: string): Promise<SpecBundleFile[]>;
  writeWorktreeFiles(
    worktreePath: string,
    files: Array<{ path: string; content: string }>,
  ): Promise<void>;
}

export type ImplementStatus = "pr_opened" | "needs_input";

export interface ImplementResult {
  status: ImplementStatus;
  ticketId: string;
  worktreePath?: string;
  /** Full `ImplementationResult` when `status === "pr_opened"`. */
  result?: ImplementationResult;
  /** Short summary posted as a ticket comment. */
  summary: string;
}

export interface RunImplementPhaseDeps {
  github: GitHubClient;
  git: GitOps;
  fs: ImplementFs;
  worktree: WorktreeOps;
  gateRunner: QualityGateRunner;
  agent: AgentAdapter;
  events?: EventSink;
  now?: () => Date;
  runId: string;
  profileId: string;
  /** Model id for the implementer role. */
  implementerModel: string;
  /** Ordered quality gates to run after each implementer commit. */
  qualityGates: QualityGate[];
  /** Base branch the PR targets (e.g. `main`). */
  baseBranch: string;
  /** Max implementer attempts on validation / gate failure. Default 2. */
  maxAttempts?: number;
}

export interface RunImplementPhaseInput {
  /** Project item to process. */
  itemId: string;
  /** Change folder name (slug used under `openspec/changes/<name>`). */
  changeName: string;
}

const STATUS_BLOCKING_ENTRY = new Set([
  "Backlog",
  "Refinement",
  "Refined",
  "In review",
  "Ready to merge",
  "Blocked",
]);

const NIGHT_SHIFT_MARKER_PREFIX = "<!-- night-shift:marker=";

function filterOperatorComments(comments: Comment[]): Comment[] {
  return comments.filter((c) => !c.body.startsWith(NIGHT_SHIFT_MARKER_PREFIX));
}

function nowIso(now: () => Date): string {
  return now().toISOString();
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

function buildTicket(
  itemId: string,
  projectNodeId: string,
  repoOwner: string,
  repoName: string,
  issue: {
    number: number;
    title: string;
    body: string | null;
    labels: string[];
    htmlUrl: string;
  },
): Ticket {
  return {
    id: `${repoOwner}/${repoName}#${issue.number}`,
    title: issue.title,
    description: issue.body ?? "",
    status: "Ready",
    labels: issue.labels,
    url: issue.htmlUrl,
    source: "github",
    sourceRef: {
      kind: "github",
      projectNodeId,
      projectItemId: itemId,
      repoOwner,
      repoName,
      issueNumber: issue.number,
    },
  };
}

function formatGateTable(gates: ContractQualityGateResult[]): string {
  if (gates.length === 0) return "_(no gates configured)_";
  const rows = ["| Gate | Status | Duration |", "| --- | --- | --- |"];
  for (const g of gates) {
    rows.push(`| ${g.name} | ${g.status} | ${g.durationMs}ms |`);
  }
  return rows.join("\n");
}

function formatSummary(
  status: ImplementStatus,
  gates: ContractQualityGateResult[],
  pr: { number: number; url: string } | undefined,
  impl: ImplementerResponse | undefined,
): string {
  const parts: string[] = [];
  parts.push(`Implement phase: **${status}**`);
  if (pr) {
    parts.push("");
    parts.push(`PR: [#${pr.number}](${pr.url})`);
  }
  parts.push("");
  parts.push("### Quality gates");
  parts.push(formatGateTable(gates));
  if (impl?.followUps && impl.followUps.length > 0) {
    parts.push("");
    parts.push("### Follow-ups");
    for (const f of impl.followUps) parts.push(`- ${f}`);
  }
  return parts.join("\n");
}

export async function runImplementPhase(
  deps: RunImplementPhaseDeps,
  input: RunImplementPhaseInput,
): Promise<ImplementResult> {
  const now = deps.now ?? (() => new Date());
  const start = Date.now();
  const maxAttempts = deps.maxAttempts ?? 2;

  await emitSafe(deps.events, {
    kind: "PhaseStarted",
    ticketId: input.itemId,
    phase: "implement",
    profileId: deps.profileId,
    ts: nowIso(now),
    runId: deps.runId,
    inputSummary: `item=${input.itemId} change=${input.changeName}`,
  });

  let worktreePath: string | undefined;
  let ticketId = input.itemId;

  try {
    const item = await deps.github.getItem(input.itemId);
    if (item.issueNumber === undefined) {
      throw new ImplementValidationError(
        `project item ${input.itemId} has no linked issue`,
      );
    }
    const itemStatus = item.status;
    if (itemStatus && STATUS_BLOCKING_ENTRY.has(itemStatus)) {
      throw new ImplementValidationError(
        `cannot enter Implement phase: item ${input.itemId} is in ${itemStatus}`,
      );
    }

    const issue = await deps.github.getIssue(item.issueNumber);
    const allComments = await deps.github.listComments(item.issueNumber);
    const operatorComments = filterOperatorComments(allComments);
    const ticket = buildTicket(
      input.itemId,
      deps.github.projectNodeId,
      deps.github.owner,
      deps.github.repo,
      issue,
    );
    ticketId = ticket.id;

    // Read the spec bundle up front so a missing file fails before any
    // transitions or worktree work.
    const specPath = path.posix.join("openspec", "changes", input.changeName);
    let bundleFiles: SpecBundleFile[];
    try {
      bundleFiles = await deps.fs.readSpecBundle(specPath);
    } catch (err) {
      throw new ImplementIoError(
        `failed to read spec bundle at ${specPath}: ${(err as Error).message}`,
        { ticketId, cause: err },
      );
    }
    if (bundleFiles.length === 0) {
      throw new ImplementIoError(
        `spec bundle at ${specPath} is empty`,
        { ticketId },
      );
    }

    // Pre-transition: Ready → In progress (skip when already there).
    if (itemStatus !== "In progress") {
      await deps.github.setStatus(input.itemId, "In progress");
    }

    const branch = branchNameFor(ticket);
    const wt = await deps.worktree.create({ ticketId: ticket.id, branch });
    worktreePath = wt.path;

    const bundle: SpecBundle = {
      specPath,
      branch,
      openQuestions: [],
      assumptions: [],
      risks: [],
      commitSha: "0".repeat(40),
    };
    void bundle; // downstream consumers may project from this shape

    const implSession = deps.agent.openSession({
      role: "implementer",
      model: deps.implementerModel,
      systemPrompt: IMPLEMENTER_SYSTEM_PROMPT,
      runId: deps.runId,
      ticketId: ticket.id,
      profileId: deps.profileId,
    });

    let implResponse: ImplementerResponse | undefined;
    let implTurn: TurnResult | undefined;
    let gateResults: ContractQualityGateResult[] = [];
    let lastError: string | undefined;
    let commitSha: string | undefined;

    try {
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const retryCtx =
          attempt === 1 || lastError === undefined
            ? undefined
            : { previousError: lastError, attempt };
        const msg = renderImplementerMessage(
          ticket,
          bundleFiles,
          operatorComments,
          retryCtx,
        );
        let turn: TurnResult;
        try {
          turn = await implSession.run(msg, {
            outputSchema: ImplementerResponseJsonSchema,
          });
        } catch (err) {
          throw new ImplementAgentError(
            "agent",
            `implementer agent failed: ${(err as Error).message}`,
            { ticketId: ticket.id, worktreePath, cause: err },
          );
        }
        implTurn = turn;
        implResponse = parseImplementerResponse(turn.finalText, {
          ticketId: ticket.id,
          worktreePath,
          latencyMs: turn.latencyMs,
        });

        // Write files into the worktree + commit on the ticket branch.
        try {
          await deps.fs.writeWorktreeFiles(wt.path, implResponse.filesWritten);
        } catch (err) {
          throw new ImplementIoError(
            `failed to write implementer files: ${(err as Error).message}`,
            { ticketId: ticket.id, worktreePath, cause: err },
          );
        }
        try {
          await deps.git.checkoutBranch(branch);
          const { sha } = await deps.git.writeTree(
            implResponse.filesWritten,
            implResponse.commitMessage,
          );
          commitSha = sha;
        } catch (err) {
          throw new ImplementGitError(
            `commit failed: ${(err as Error).message}`,
            { ticketId: ticket.id, worktreePath, cause: err },
          );
        }

        // Quality gates.
        gateResults = [];
        let anyFailed = false;
        for (const gate of deps.qualityGates) {
          const r = await deps.gateRunner.run(gate, { cwd: wt.path });
          gateResults.push({
            name: r.name,
            status: r.status,
            durationMs: r.durationMs,
            logsTail: r.logsTail.length > 4096 ? r.logsTail.slice(-4096) : r.logsTail,
          });
          await emitSafe(deps.events, {
            kind: "QualityGateEvaluated",
            ticketId: ticket.id,
            phase: "implement",
            profileId: deps.profileId,
            ts: nowIso(now),
            runId: deps.runId,
            gate: gate.name,
            status: r.status,
            durationMs: r.durationMs,
          });
          if (r.status === "failed") anyFailed = true;
        }
        if (!anyFailed) {
          lastError = undefined;
          break;
        }
        lastError = `quality gates failed: ${gateResults
          .filter((g) => g.status === "failed")
          .map((g) => g.name)
          .join(", ")}`;
        if (attempt >= maxAttempts) break;
      }
    } finally {
      if (implSession.close) await implSession.close();
    }

    if (!implResponse || !implTurn || !commitSha) {
      throw new ImplementPhaseError("validation", "implement phase produced no response");
    }

    const needsInput = lastError !== undefined;

    let pr:
      | { number: number; url: string; branch: string; baseBranch: string; headSha: string }
      | undefined;

    if (!needsInput) {
      try {
        await deps.github.pushBranch(branch, commitSha);
        pr = await deps.github.upsertPullRequest({
          head: branch,
          base: deps.baseBranch,
          title: `${ticket.id}: ${ticket.title}`,
          body: `Closes ${ticket.url}\n\n${implResponse.summary}`,
        });
      } catch (err) {
        if (err instanceof GitHubPushRejectedError) {
          throw new ImplementGitError(
            `push rejected for ${branch}`,
            {
              ticketId: ticket.id,
              worktreePath,
              code: "push_rejected",
              cause: err,
            },
          );
        }
        throw err;
      }
    }

    const status: ImplementStatus = needsInput ? "needs_input" : "pr_opened";
    const summary = formatSummary(
      status,
      gateResults,
      pr ? { number: pr.number, url: pr.url } : undefined,
      implResponse,
    );

    await deps.github.upsertComment(issue.number, "implement:summary", summary);

    await deps.github.setStatus(
      input.itemId,
      status === "pr_opened" ? "In review" : "Blocked",
    );

    const baseResult: ImplementResult = {
      status,
      ticketId: ticket.id,
      ...(worktreePath !== undefined ? { worktreePath } : {}),
      summary,
    };

    if (status === "pr_opened" && pr) {
      const result: ImplementationResult = ImplementationResultSchema.parse({
        pr: {
          number: pr.number,
          url: pr.url,
          branch: pr.branch,
          baseBranch: pr.baseBranch,
          headSha: pr.headSha,
        },
        qualityGates: gateResults,
        summary,
      });
      baseResult.result = result;
    }

    // Success: clean up the worktree. On failure we leave it for triage.
    await deps.worktree.remove(wt.path);
    worktreePath = undefined;

    await emitSafe(deps.events, {
      kind: "PhaseCompleted",
      ticketId: ticket.id,
      phase: "implement",
      profileId: deps.profileId,
      ts: nowIso(now),
      runId: deps.runId,
      outputSummary: status,
      durationMs: Date.now() - start,
      cost: 0,
      tokens: {
        input: implTurn.usage.input_tokens,
        output: implTurn.usage.output_tokens,
      },
    });

    return baseResult;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await emitSafe(deps.events, {
      kind: "PhaseFailed",
      ticketId,
      phase: "implement",
      profileId: deps.profileId,
      ts: nowIso(now),
      runId: deps.runId,
      error: {
        name: err instanceof Error ? err.name : "Error",
        message,
        ...(err instanceof Error && err.stack ? { stack: err.stack } : {}),
      },
      durationMs: Date.now() - start,
    });
    if (err instanceof ImplementPhaseError) {
      if (worktreePath !== undefined && err.worktreePath === undefined) {
        // Attach the worktree path for post-mortem by throwing a fresh
        // error of the same code. Keeps the chain intact via `cause`.
        throw new ImplementPhaseError(err.code, err.message, {
          ticketId: err.ticketId ?? ticketId,
          worktreePath,
          ...(err.latencyMs !== undefined ? { latencyMs: err.latencyMs } : {}),
          cause: err,
        });
      }
    }
    throw err;
  }
}
