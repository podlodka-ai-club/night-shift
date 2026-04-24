import path from "node:path";
import type { AgentAdapter, TurnResult } from "../../adapters/events.js";
import type { EventSink } from "../../contracts/events.js";
import type { SpecBundle } from "../../contracts/specify.js";
import { validateSpecBundle } from "../../contracts/specify.js";
import { branchNameFor } from "../../contracts/helpers.js";
import type { Ticket } from "../../contracts/ticket.js";
import type { GitHubClient } from "../../github/client.js";
import type { Comment } from "../../github/types.js";
import { markerLine } from "../../github/issues.js";
import type { GitOps } from "../../git/index.js";
import {
  SpecifyAgentError,
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
  /** List files under the given relative directory (recursive). Empty when absent. */
  readPriorDraft(changeDir: string): Promise<PriorDraftFile[]>;
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
  git: GitOps;
  fs: SpecifyFs;
  agent: AgentAdapter;
  openspecCli: OpenSpecCli;
  events?: EventSink;
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

function formatSummary(response: SpecifierResponse, status: SpecifyStatus): string {
  const parts: string[] = [];
  parts.push(`Specify phase: **${status}**`);
  if (response.openQuestions.length > 0) {
    parts.push("");
    parts.push("### Open questions");
    for (const q of response.openQuestions) parts.push(`- ${q}`);
  }
  if (response.assumptions.length > 0) {
    parts.push("");
    parts.push("### Assumptions");
    for (const a of response.assumptions) parts.push(`- ${a}`);
  }
  if (response.risks.length > 0) {
    parts.push("");
    parts.push("### Risks");
    for (const r of response.risks) parts.push(`- ${r}`);
  }
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

export async function runSpecifyPhase(
  deps: RunSpecifyPhaseDeps,
  input: RunSpecifyPhaseInput,
): Promise<SpecifyResult> {
  const now = deps.now ?? (() => new Date());
  const start = Date.now();
  const maxAttempts = deps.maxAttempts ?? 2;

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

    // 3. Ensure branch exists (idempotent).
    const branch = branchNameFor(ticket);
    try {
      await deps.github.createBranch(branch);
    } catch (err) {
      // createBranch is idempotent on the fake; real impl returns a known
      // error when the ref exists — tolerate it here.
      const message = err instanceof Error ? err.message : String(err);
      if (!/already exists|reference already exists/i.test(message)) throw err;
    }
    await deps.git.checkoutBranch(branch);

    const changeDir = changeFolderPath(input.changeName);
    const priorDraft = await deps.fs.readPriorDraft(changeDir);

    // 4. Specifier call with single retry on validation failure.
    const session = deps.agent.openSession({
      role: "specifier",
      model: deps.model,
      systemPrompt: SPECIFIER_SYSTEM_PROMPT,
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
          turn = await session.run(userMessage, {
            outputSchema: SpecifierResponseJsonSchema,
          });
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
        const { sha } = await deps.git.writeTree(
          treeFiles,
          `specify(${ticket.id}): attempt ${attempt}`,
        );
        commitSha = sha;

        const validation = await deps.openspecCli.validate(input.changeName, {
          strict: true,
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

    const summary =
      status === "needs_input" && validatorFailed
        ? `${formatSummary(response, status)}\n\n### Validator errors\n\`\`\`\n${validatorError}\n\`\`\``
        : formatSummary(response, status);

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
    const message = err instanceof Error ? err.message : String(err);
    await emitSafe(deps.events, {
      kind: "PhaseFailed",
      ticketId: "id" in (err as object) ? (err as { ticketId?: string }).ticketId ?? input.itemId : input.itemId,
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
