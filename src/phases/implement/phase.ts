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
  ticket?: Ticket;
  specBundle?: SpecBundle;
  worktreePath?: string;
  /** Full `ImplementationResult` when `status === "pr_opened"`. */
  result?: ImplementationResult;
  /** Short summary posted as a ticket comment. */
  summary: string;
}

export interface RunImplementPhaseDeps {
  github: GitHubClient;
  git: GitOps;
  gitForRepo?: (repoRoot: string) => GitOps;
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

type ImplementIssue = Awaited<ReturnType<GitHubClient["getIssue"]>>;
type ImplementPullRequest = Awaited<
  ReturnType<GitHubClient["upsertPullRequest"]>
>;

interface LoadedImplementContext {
  itemStatus: string | undefined;
  issue: ImplementIssue;
  operatorComments: Comment[];
  ticket: Ticket;
  specPath: string;
  bundleFiles: SpecBundleFile[];
}

interface PreparedImplementContext extends LoadedImplementContext {
  branch: string;
  git: GitOps;
  worktreePath: string;
}

interface ImplementAttemptResult {
  response: ImplementerResponse;
  turn: TurnResult;
  gateResults: ContractQualityGateResult[];
  lastError: string | undefined;
  commitSha: string;
}

function requireLinkedIssue(itemId: string, issueNumber: number | undefined): number {
  if (issueNumber === undefined) {
    throw new ImplementValidationError(
      `project item ${itemId} has no linked issue`,
    );
  }
  return issueNumber;
}

function assertImplementEntryStatus(
  itemId: string,
  itemStatus: string | undefined,
): string | undefined {
  if (itemStatus && STATUS_BLOCKING_ENTRY.has(itemStatus)) {
    throw new ImplementValidationError(
      `cannot enter Implement phase: item ${itemId} is in ${itemStatus}`,
    );
  }
  return itemStatus;
}

async function readRequiredSpecBundle(
  fs: ImplementFs,
  changeName: string,
  ticketId: string,
): Promise<SpecBundleFile[]> {
  const specPath = path.posix.join("openspec", "changes", changeName);

  let bundleFiles: SpecBundleFile[];
  try {
    bundleFiles = await fs.readSpecBundle(specPath);
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

  return bundleFiles;
}

async function loadImplementContext(
  deps: RunImplementPhaseDeps,
  input: RunImplementPhaseInput,
): Promise<LoadedImplementContext> {
  const item = await deps.github.getItem(input.itemId);
  const issueNumber = requireLinkedIssue(input.itemId, item.issueNumber);
  const itemStatus = assertImplementEntryStatus(input.itemId, item.status);

  const [issue, allComments] = await Promise.all([
    deps.github.getIssue(issueNumber),
    deps.github.listComments(issueNumber),
  ]);

  const ticket = buildTicket(
    input.itemId,
    deps.github.projectNodeId,
    deps.github.owner,
    deps.github.repo,
    issue,
  );

  const specPath = path.posix.join("openspec", "changes", input.changeName);

  const bundleFiles = await readRequiredSpecBundle(
    deps.fs,
    input.changeName,
    ticket.id,
  );

  return {
    itemStatus,
    issue,
    operatorComments: filterOperatorComments(allComments),
    ticket,
    specPath,
    bundleFiles,
  };
}

async function prepareImplementContext(
  deps: RunImplementPhaseDeps,
  input: RunImplementPhaseInput,
  context: LoadedImplementContext,
): Promise<PreparedImplementContext> {
  if (context.itemStatus !== "In progress") {
    await deps.github.setStatus(input.itemId, "In progress");
  }

  const branch = branchNameFor(context.ticket);
  const worktree = await deps.worktree.create({
    ticketId: context.ticket.id,
    branch,
  });

  const git = deps.gitForRepo?.(worktree.path) ?? deps.git;

  return {
    ...context,
    branch,
    git,
    worktreePath: worktree.path,
  };
}

async function runImplementerTurn(
  session: ReturnType<AgentAdapter["openSession"]>,
  deps: RunImplementPhaseDeps,
  context: PreparedImplementContext,
  attempt: number,
  lastError: string | undefined,
): Promise<{ response: ImplementerResponse; turn: TurnResult }> {
  const retryCtx =
    attempt === 1 || lastError === undefined
      ? undefined
      : { previousError: lastError, attempt };
  const message = renderImplementerMessage(
    context.ticket,
    context.bundleFiles,
    context.operatorComments,
    retryCtx,
  );

  let turn: TurnResult;
  try {
    turn = await session.run(message, {
      outputSchema: ImplementerResponseJsonSchema,
    });
  } catch (err) {
    throw new ImplementAgentError(
      "agent",
      `implementer agent failed: ${(err as Error).message}`,
      { ticketId: context.ticket.id, worktreePath: context.worktreePath, cause: err },
    );
  }

  return {
    turn,
    response: parseImplementerResponse(turn.finalText, {
      ticketId: context.ticket.id,
      worktreePath: context.worktreePath,
      latencyMs: turn.latencyMs,
    }),
  };
}

async function writeImplementerCommit(
  deps: RunImplementPhaseDeps,
  context: PreparedImplementContext,
  response: ImplementerResponse,
): Promise<string> {
  if (response.filesWritten.length > 0) {
    try {
      await deps.fs.writeWorktreeFiles(
        context.worktreePath,
        response.filesWritten,
      );
    } catch (err) {
      throw new ImplementIoError(
        `failed to write implementer files: ${(err as Error).message}`,
        { ticketId: context.ticket.id, worktreePath: context.worktreePath, cause: err },
      );
    }
  }

  try {
    await context.git.checkoutBranch(context.branch);
    if (response.filesWritten.length === 0) {
      return await context.git.currentHeadSha();
    }
    const { sha } = await context.git.writeTree(
      response.filesWritten,
      response.commitMessage,
    );
    return sha;
  } catch (err) {
    throw new ImplementGitError(
      `commit failed: ${(err as Error).message}`,
      { ticketId: context.ticket.id, worktreePath: context.worktreePath, cause: err },
    );
  }
}

async function runQualityGates(
  deps: RunImplementPhaseDeps,
  ticketId: string,
  worktreePath: string,
  now: () => Date,
): Promise<ContractQualityGateResult[]> {
  const gateResults: ContractQualityGateResult[] = [];

  for (const gate of deps.qualityGates) {
    const result = await deps.gateRunner.run(gate, { cwd: worktreePath });
    gateResults.push({
      name: result.name,
      status: result.status,
      durationMs: result.durationMs,
      logsTail:
        result.logsTail.length > 4096
          ? result.logsTail.slice(-4096)
          : result.logsTail,
    });

    await emitSafe(deps.events, {
      kind: "QualityGateEvaluated",
      ticketId,
      phase: "implement",
      profileId: deps.profileId,
      ts: nowIso(now),
      runId: deps.runId,
      gate: gate.name,
      status: result.status,
      durationMs: result.durationMs,
    });
  }

  return gateResults;
}

function describeGateFailure(
  gateResults: ContractQualityGateResult[],
): string | undefined {
  const failedGateNames = gateResults
    .filter((gate) => gate.status === "failed")
    .map((gate) => gate.name);

  return failedGateNames.length === 0
    ? undefined
    : `quality gates failed: ${failedGateNames.join(", ")}`;
}

async function runImplementAttempts(
  deps: RunImplementPhaseDeps,
  context: PreparedImplementContext,
  now: () => Date,
  maxAttempts: number,
): Promise<ImplementAttemptResult> {
  const session = deps.agent.openSession({
    role: "implementer",
    model: deps.implementerModel,
    systemPrompt: IMPLEMENTER_SYSTEM_PROMPT,
    workingDirectory: context.worktreePath,
    runId: deps.runId,
    ticketId: context.ticket.id,
    profileId: deps.profileId,
  });

  let response: ImplementerResponse | undefined;
  let turn: TurnResult | undefined;
  let gateResults: ContractQualityGateResult[] = [];
  let lastError: string | undefined;
  let commitSha: string | undefined;

  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const turnResult = await runImplementerTurn(
        session,
        deps,
        context,
        attempt,
        lastError,
      );
      response = turnResult.response;
      turn = turnResult.turn;
      commitSha = await writeImplementerCommit(deps, context, response);
      gateResults = await runQualityGates(
        deps,
        context.ticket.id,
        context.worktreePath,
        now,
      );
      lastError = describeGateFailure(gateResults);

      if (lastError === undefined) {
        break;
      }
    }
  } finally {
    if (session.close) await session.close();
  }

  if (!response || !turn || !commitSha) {
    throw new ImplementPhaseError(
      "validation",
      "implement phase produced no response",
    );
  }

  return {
    response,
    turn,
    gateResults,
    lastError,
    commitSha,
  };
}

async function publishPullRequest(
  deps: RunImplementPhaseDeps,
  context: PreparedImplementContext,
  commitSha: string,
  summary: string,
): Promise<ImplementPullRequest> {
  try {
    await context.git.pushBranch(context.branch);
    const pr = await deps.github.upsertPullRequest({
      head: context.branch,
      base: deps.baseBranch,
      title: `${context.ticket.id}: ${context.ticket.title}`,
      body: `Closes ${context.ticket.url}\n\n${summary}`,
    });
    return {
      ...pr,
      headSha: commitSha,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (
      err instanceof GitHubPushRejectedError ||
      /force-with-lease|stale info|fetch first|non-fast-forward|lease/i.test(message)
    ) {
      throw new ImplementGitError(
        `push rejected for ${context.branch}`,
        {
          ticketId: context.ticket.id,
          worktreePath: context.worktreePath,
          code: "push_rejected",
          cause: err,
        },
      );
    }
    throw err;
  }
}

function buildImplementResult(
  status: ImplementStatus,
  ticket: Ticket,
  specBundle: SpecBundle,
  worktreePath: string | undefined,
  summary: string,
  gateResults: ContractQualityGateResult[],
  pr: ImplementPullRequest | undefined,
): ImplementResult {
  const result: ImplementResult = {
    status,
    ticketId: ticket.id,
    ticket,
    specBundle,
    ...(worktreePath !== undefined ? { worktreePath } : {}),
    summary,
  };

  if (status === "pr_opened" && pr) {
    result.result = ImplementationResultSchema.parse({
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
  }

  return result;
}

function rethrowWithWorktreePath(
  err: unknown,
  ticketId: string,
  worktreePath: string | undefined,
): never {
  if (
    err instanceof ImplementPhaseError &&
    worktreePath !== undefined &&
    err.worktreePath === undefined
  ) {
    throw new ImplementPhaseError(err.code, err.message, {
      ticketId: err.ticketId ?? ticketId,
      worktreePath,
      ...(err.latencyMs !== undefined ? { latencyMs: err.latencyMs } : {}),
      cause: err,
    });
  }

  throw err;
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
    const loaded = await loadImplementContext(deps, input);
    ticketId = loaded.ticket.id;

    const prepared = await prepareImplementContext(deps, input, loaded);
    worktreePath = prepared.worktreePath;

    const attemptResult = await runImplementAttempts(
      deps,
      prepared,
      now,
      maxAttempts,
    );
    const needsInput = attemptResult.lastError !== undefined;
    const pr = needsInput
      ? undefined
      : await publishPullRequest(
          deps,
          prepared,
          attemptResult.commitSha,
          attemptResult.response.summary,
        );

    const status: ImplementStatus = needsInput ? "needs_input" : "pr_opened";
    const summary = formatSummary(
      status,
      attemptResult.gateResults,
      pr ? { number: pr.number, url: pr.url } : undefined,
      attemptResult.response,
    );
    const specBundle: SpecBundle = {
      specPath: prepared.specPath,
      branch: prepared.branch,
      openQuestions: [],
      assumptions: [],
      risks: [],
      commitSha: attemptResult.commitSha,
    };

    await deps.github.upsertComment(
      prepared.issue.number,
      "implement:summary",
      summary,
    );

    await deps.github.setStatus(
      input.itemId,
      status === "pr_opened" ? "In review" : "Blocked",
    );

    const result = buildImplementResult(
      status,
      prepared.ticket,
      specBundle,
      worktreePath,
      summary,
      attemptResult.gateResults,
      pr,
    );

    // Success: clean up the worktree. On failure we leave it for triage.
    await deps.worktree.remove(prepared.worktreePath);
    worktreePath = undefined;

    await emitSafe(deps.events, {
      kind: "PhaseCompleted",
      ticketId: prepared.ticket.id,
      phase: "implement",
      profileId: deps.profileId,
      ts: nowIso(now),
      runId: deps.runId,
      outputSummary: status,
      durationMs: Date.now() - start,
      cost: 0,
      tokens: {
        input: attemptResult.turn.usage.input_tokens,
        output: attemptResult.turn.usage.output_tokens,
      },
    });

    return result;
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
    rethrowWithWorktreePath(err, ticketId, worktreePath);
  }
}
