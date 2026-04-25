import path from "node:path";
import type { AgentAdapter, AgentStreamEvent, TurnResult } from "../../adapters/events.js";
import { runTurnWithProgress } from "../../adapters/run-turn.js";
import type { EventSink } from "../../contracts/events.js";
import type { SpecBundle } from "../../contracts/specify.js";
import { validateSpecBundle } from "../../contracts/specify.js";
import { branchNameFor } from "../../contracts/helpers.js";
import type { Ticket } from "../../contracts/ticket.js";
import type { GitHubClient } from "../../github/client.js";
import type { Comment } from "../../github/types.js";
import { markerLine } from "../../github/issues.js";
import type { GitOps } from "../../git/index.js";
import type { WorktreeOps } from "../../worktree/index.js";
import {
  SpecifyAgentError,
  SpecifyGitError,
  SpecifyItemMissingError,
  SpecifyPhaseError,
  SpecifyValidationError,
} from "./errors.js";
import type { OpenSpecCli } from "./openspec-cli.js";
import { parseResponse } from "./parse.js";
import {
  renderUserMessage,
  SPECIFIER_SYSTEM_PROMPT,
  type PriorDraftFile,
} from "./prompt.js";
import {
  SpecifierResponseJsonSchema,
  type SpecifierResponse,
} from "./response.js";

/**
 * Filesystem surface the phase needs. We take it as a dependency so tests
 * can drive the phase without touching disk. The real impl is provided by
 * the CLI wrapper.
 */
export interface SpecifyFs {
  /** List files under the given relative directory in `repoRoot` (recursive). Empty when absent. */
  readPriorDraft(repoRoot: string, changeDir: string): Promise<PriorDraftFile[]>;
}

export type SpecifyStatus = "refined" | "needs_input";

export interface SpecifyResult {
  status: SpecifyStatus;
  bundle?: SpecBundle;
  /** Open questions surfaced to the operator (non-empty ⇒ needs_input). */
  openQuestions: string[];
  assumptions: string[];
  risks: string[];
  /** Summary text posted as a ticket comment. */
  summary: string;
}

export interface RunSpecifyPhaseDeps {
  github: GitHubClient;
  worktree: WorktreeOps;
  gitForRepo: (repoRoot: string) => GitOps;
  fs: SpecifyFs;
  agent: AgentAdapter;
  openspecCli: OpenSpecCli;
  /** Base branch the spec review PR targets. Defaults to `main`. */
  baseBranch?: string;
  events?: EventSink;
  onAgentEvent?: (event: AgentStreamEvent) => Promise<void> | void;
  now?: () => Date;
  runId: string;
  profileId: string;
  /** Model id for the specifier role. */
  model: string;
  /** Max specifier attempts on validation failure. Default 2 (initial + 1 retry). */
  maxAttempts?: number;
}

export interface RunSpecifyPhaseInput {
  /** Project item to process. */
  itemId: string;
  /** Change folder name (slug used under `openspec/changes/<name>`). */
  changeName: string;
}

const STATUSES_BLOCKING_ENTRY = new Set([
  "Blocked",
  "Refined",
  "Ready",
  "In progress",
  "In review",
  "Ready to merge",
]);

const NIGHT_SHIFT_MARKER_PREFIX = "<!-- night-shift:marker=";

function filterOperatorComments(comments: Comment[]): Comment[] {
  return comments.filter((c) => !c.body.startsWith(NIGHT_SHIFT_MARKER_PREFIX));
}

function nowIso(now: () => Date): string {
  return now().toISOString();
}

async function emitSafe(sink: EventSink | undefined, ev: Parameters<EventSink["emit"]>[0]) {
  if (!sink) return;
  try {
    await sink.emit(ev);
  } catch {
    // observability sinks must never break the phase
  }
}

function buildTicket(
  itemId: string,
  projectNodeId: string,
  repoOwner: string,
  repoName: string,
  issue: { number: number; title: string; body: string | null; labels: string[]; htmlUrl: string },
  itemStatus: string | undefined,
): Ticket {
  return {
    id: `${repoOwner}/${repoName}#${issue.number}`,
    title: issue.title,
    description: issue.body ?? "",
    // We normalise into the ticket schema's canonical enum; when no status we
    // default to Backlog — the pre-transition step still reads the raw item
    // status below for transition decisions.
    status: "Backlog",
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
  // itemStatus intentionally unused here — it informs the caller's pre-transition.
}

function repoUrlFromIssueUrl(issueUrl: string): string {
  const url = new URL(issueUrl);
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length >= 2) {
    url.pathname = `/${segments[0]}/${segments[1]}`;
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  }
  return issueUrl;
}

function encodeRepoPath(pathValue: string): string {
  return pathValue
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function renderList(items: string[]): string[] {
  return items.length > 0 ? items.map((item) => `- ${item}`) : ["- _None._"];
}

function formatUsageSummary(usage: TurnResult["usage"]): string {
  return [
    `${usage.input_tokens.toLocaleString("en-US")} input`,
    `${usage.output_tokens.toLocaleString("en-US")} output`,
    `${usage.cached_input_tokens.toLocaleString("en-US")} cached`,
  ].join(", ");
}

function formatSummary(opts: {
  response: SpecifierResponse;
  status: SpecifyStatus;
  issueUrl: string;
  changeDir: string;
  branch: string;
  commitSha: string;
  latencyMs: number;
  usage: TurnResult["usage"];
  specPrUrl?: string;
}): string {
  const repoUrl = repoUrlFromIssueUrl(opts.issueUrl);
  const changeFolderUrl = `${repoUrl}/tree/${opts.commitSha}/${encodeRepoPath(opts.changeDir)}`;
  const parts: string[] = [];
  parts.push(`Specify phase: **${opts.status}**`);
  parts.push("");
  parts.push("### Links");
  parts.push(`- [Change folder](${changeFolderUrl})`);
  parts.push(`- Branch: \`${opts.branch}\``);
  if (opts.specPrUrl) {
    parts.push(`- [Spec review PR](${opts.specPrUrl})`);
  }

  parts.push("");
  parts.push("### Open questions");
  parts.push(...renderList(opts.response.openQuestions));

  parts.push("");
  parts.push("### Assumptions");
  parts.push(...renderList(opts.response.assumptions));

  parts.push("");
  parts.push("### Risks");
  parts.push(...renderList(opts.response.risks));

  parts.push("");
  parts.push(`_Latency: ${opts.latencyMs}ms · Usage: ${formatUsageSummary(opts.usage)}_`);
  return parts.join("\n");
}

function changeFolderPath(changeName: string): string {
  return path.posix.join("openspec", "changes", changeName);
}

function filesToTree(
  response: SpecifierResponse,
  changeDir: string,
): Array<{ path: string; content: string }> {
  return response.files.map((f) => ({
    path: path.posix.join(changeDir, f.path),
    content: f.content,
  }));
}

async function publishSpecReviewPullRequest(
  deps: Pick<RunSpecifyPhaseDeps, "github" | "baseBranch">,
  git: GitOps,
  ticket: Ticket,
  branch: string,
  commitSha: string,
  issueUrl: string,
  changeDir: string,
): Promise<Awaited<ReturnType<GitHubClient["upsertPullRequest"]>>> {
  try {
    await git.pushBranch(branch);
    return await deps.github.upsertPullRequest({
      head: branch,
      base: deps.baseBranch ?? "main",
      title: `Spec: ${ticket.id}: ${ticket.title}`,
      body: [
        `Spec review for ${issueUrl}`,
        "",
        `OpenSpec change folder: ${changeDir}`,
      ].join("\n"),
      draft: true,
    });
  } catch (err) {
    throw new SpecifyGitError(
      `failed to publish spec review PR for ${branch}: ${(err as Error).message}`,
      { ticketId: ticket.id, cause: err },
    );
  }
}

async function cleanupSpecifierWorktree(
  deps: Pick<RunSpecifyPhaseDeps, "worktree">,
  worktreePath: string,
  ticketId: string,
  opts: { swallowErrors?: boolean } = {},
): Promise<void> {
  try {
    await deps.worktree.remove(worktreePath);
  } catch (err) {
    if (opts.swallowErrors) {
      return;
    }
    throw new SpecifyGitError(
      `failed to remove specify worktree ${worktreePath}: ${(err as Error).message}`,
      { ticketId, cause: err },
    );
  }
}

export async function runSpecifyPhase(
  deps: RunSpecifyPhaseDeps,
  input: RunSpecifyPhaseInput,
): Promise<SpecifyResult> {
  const now = deps.now ?? (() => new Date());
  const start = Date.now();
  const maxAttempts = deps.maxAttempts ?? 2;
  let worktreePath: string | undefined;

  // Emit PhaseStarted up front so failure paths (including item-missing)
  // still produce a terminal event pair.
  await emitSafe(deps.events, {
    kind: "PhaseStarted",
    ticketId: input.itemId,
    phase: "specify",
    profileId: deps.profileId,
    ts: nowIso(now),
    runId: deps.runId,
    inputSummary: `item=${input.itemId}`,
  });

  try {
    // 1. Resolve the project item + issue.
    const item = await deps.github.getItem(input.itemId);
    if (item.issueNumber === undefined) {
      throw new SpecifyItemMissingError(input.itemId);
    }
    const itemStatus = item.status;
    if (itemStatus && STATUSES_BLOCKING_ENTRY.has(itemStatus)) {
      throw new SpecifyValidationError(
        `cannot enter Specify phase: item ${input.itemId} is in ${itemStatus}`,
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
      itemStatus,
    );

    // 2. Pre-transition Backlog → Refinement (skip when already in Refinement).
    if (itemStatus !== "Refinement") {
      await deps.github.setStatus(input.itemId, "Refinement");
    }

    // 3. Ensure the ticket branch exists off the configured base branch.
    const baseBranch = deps.baseBranch ?? "main";
    const worktreeStartPoint = `origin/${baseBranch}`;

    const branch = branchNameFor(ticket);
    try {
      await deps.github.createBranch(branch, `heads/${baseBranch}`);
    } catch (err) {
      // createBranch is idempotent on the fake; real impl returns a known
      // error when the ref exists — tolerate it here.
      const message = err instanceof Error ? err.message : String(err);
      if (!/already exists|reference already exists|branch .* exists at /i.test(message)) {
        throw err;
      }
    }
    const worktree = await deps.worktree.create({
      ticketId: ticket.id,
      branch,
      fromRef: worktreeStartPoint,
    });
    worktreePath = worktree.path;

    const git = deps.gitForRepo(worktreePath);
    await git.checkoutBranch(branch, {
      startPoint: worktreeStartPoint,
      preferRemote: true,
    });

    const changeDir = changeFolderPath(input.changeName);
    const priorDraft = await deps.fs.readPriorDraft(worktreePath, changeDir);

    // 4. Specifier call with single retry on validation failure.
    const session = deps.agent.openSession({
      role: "specifier",
      model: deps.model,
      systemPrompt: SPECIFIER_SYSTEM_PROMPT,
      workingDirectory: worktreePath,
      runId: deps.runId,
      ticketId: ticket.id,
      profileId: deps.profileId,
    });

    let response: SpecifierResponse | undefined;
    let turn: TurnResult | undefined;
    let commitSha: string | undefined;
    let validatorError: string | undefined;

    try {
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const userMessage =
          attempt === 1
            ? renderUserMessage(ticket, operatorComments, priorDraft)
            : renderUserMessage(ticket, operatorComments, priorDraft) +
              `\n\n## Previous validation errors\n${validatorError}\nFix these and return the full updated response.`;

        try {
          turn = await runTurnWithProgress(session, userMessage, {
            outputSchema: SpecifierResponseJsonSchema,
          }, deps.onAgentEvent);
        } catch (err) {
          throw new SpecifyAgentError(
            "agent",
            `specifier agent failed: ${(err as Error).message}`,
            { ticketId: ticket.id, cause: err },
          );
        }

        response = parseResponse(turn.finalText, {
          ticketId: ticket.id,
          latencyMs: turn.latencyMs,
        });

        // Persist files + commit.
        const treeFiles = filesToTree(response, changeDir);
        const { sha } = await git.writeTree(
          treeFiles,
          `specify(${ticket.id}): attempt ${attempt}`,
        );
        commitSha = sha;

        const validation = await deps.openspecCli.validate(input.changeName, {
          strict: true,
          cwd: worktreePath,
        });
        if (validation.ok) {
          validatorError = undefined;
          break;
        }
        validatorError = validation.error;
        if (attempt === maxAttempts) break;
      }
    } finally {
      if (session.close) await session.close();
    }

    if (!response || !turn || !commitSha) {
      // Unreachable — the loop always assigns on success or sets validatorError on failure.
      throw new SpecifyPhaseError("validation", "specify phase produced no response");
    }

    // 5. Decide terminal status.
    const openQuestionsNonEmpty = response.openQuestions.length > 0;
    const validatorFailed = validatorError !== undefined;
    const status: SpecifyStatus =
      validatorFailed || openQuestionsNonEmpty ? "needs_input" : "refined";

    const specPr =
      status === "refined"
        ? await publishSpecReviewPullRequest(
            deps,
            git,
            ticket,
            branch,
            commitSha,
            issue.htmlUrl,
            changeDir,
          )
        : undefined;

    await cleanupSpecifierWorktree(deps, worktreePath, ticket.id);
    worktreePath = undefined;

    const summaryBase = formatSummary({
      response,
      status,
      issueUrl: issue.htmlUrl,
      changeDir,
      branch,
      commitSha,
      latencyMs: turn.latencyMs,
      usage: turn.usage,
      ...(specPr ? { specPrUrl: specPr.url } : {}),
    });

    const summary =
      status === "needs_input" && validatorFailed
        ? `${summaryBase}\n\n### Validator errors\n\`\`\`\n${validatorError}\n\`\`\``
        : summaryBase;

    await deps.github.upsertComment(issue.number, "specify:summary", summary);

    await deps.github.setStatus(
      input.itemId,
      status === "refined" ? "Refined" : "Blocked",
    );

    const bundle: SpecBundle = {
      specPath: changeDir,
      branch,
      openQuestions: response.openQuestions,
      assumptions: response.assumptions,
      risks: response.risks,
      commitSha,
    };
    if (status === "refined") {
      const check = validateSpecBundle(ticket, bundle);
      if (!check.ok) {
        throw new SpecifyValidationError(check.error, { ticketId: ticket.id });
      }
    }

    await emitSafe(deps.events, {
      kind: "PhaseCompleted",
      ticketId: ticket.id,
      phase: "specify",
      profileId: deps.profileId,
      ts: nowIso(now),
      runId: deps.runId,
      outputSummary: status,
      durationMs: Date.now() - start,
      cost: 0,
      tokens: { input: turn.usage.input_tokens, output: turn.usage.output_tokens },
    });

    const result: SpecifyResult = {
      status,
      openQuestions: response.openQuestions,
      assumptions: response.assumptions,
      risks: response.risks,
      summary,
    };
    if (status === "refined") result.bundle = bundle;
    return result;
  } catch (err) {
    const ticketId = "ticketId" in (err as object)
      ? (err as { ticketId?: string }).ticketId ?? input.itemId
      : input.itemId;
    if (typeof worktreePath === "string") {
      await cleanupSpecifierWorktree(deps, worktreePath, ticketId, { swallowErrors: true });
    }
    const message = err instanceof Error ? err.message : String(err);
    await emitSafe(deps.events, {
      kind: "PhaseFailed",
      ticketId,
      phase: "specify",
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
    throw err;
  }
}
