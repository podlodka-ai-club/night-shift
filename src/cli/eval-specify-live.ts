import { createConfiguredAdapter } from "../adapters/index.js";
import type { AgentSession, TurnResult } from "../adapters/events.js";
import type { TokenUsage } from "../adapters/types.js";
import type { Comment } from "../github/types.js";
import type { Ticket } from "../contracts/ticket.js";
import type { SpecifyEvalFixture, SpecifyTurnRunner } from "../eval/index.js";
import {
  renderUserMessage,
  SPECIFIER_SYSTEM_PROMPT,
} from "../phases/specify/prompt.js";
import { SpecifierResponseJsonSchema } from "../phases/specify/response.js";
import {
  SPECIFIER_TOOLS,
  SpecifierToolMappingError,
  specifierResponseFromToolCalls,
} from "../phases/specify/tools.js";
import type { SpecJudge, SpecJudgeVerdict } from "./eval-specify-judge.js";

export interface LiveRunnerOptions {
  provider: string;
  model: string;
  /**
   * Optional override for the synthetic ticket URL. The URL must be a valid
   * absolute URL because `Ticket` is validated against `z.string().url()`.
   */
  ticketUrlBase?: string;
}

export interface ClosableSpecifyTurnRunner extends SpecifyTurnRunner {
  close(): Promise<void>;
}

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cached_input_tokens: a.cached_input_tokens + b.cached_input_tokens,
  };
}

/**
 * Build a ticket from the fixture so the live specifier sees the same prompt
 * shape it would in production. The synthetic fields (status, source, url)
 * never reach the model — they exist only so `Ticket` validates.
 */
function buildSyntheticTicket(fixture: SpecifyEvalFixture, urlBase: string): Ticket {
  return {
    id: `eval/${fixture.id}`,
    title: fixture.ticket.title,
    description: fixture.ticket.description,
    status: "Backlog",
    labels: fixture.ticket.labels,
    url: `${urlBase}/${encodeURIComponent(fixture.id)}`,
    source: "github",
    sourceRef: {
      kind: "github",
      projectNodeId: "eval-project",
      projectItemId: "eval-item",
      repoOwner: "eval",
      repoName: "fixture",
      issueNumber: 1,
    },
  };
}

function buildSyntheticComments(bodies: ReadonlyArray<string>): Comment[] {
  return bodies.map((body, idx) => ({
    id: idx + 1,
    body,
    authorLogin: "operator",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  }));
}

/**
 * Convert a single specifier turn into the JSON shape the eval pipeline
 * expects. xAI grok-4.x dispatches via tool calls; we reassemble those into
 * the specifier's canonical response JSON. Tool-mapping failures are
 * encoded into the JSON in a way that still parses (so they surface as
 * schema_error rather than parse_error), preserving fidelity for replay.
 */
function flattenTurn(turn: TurnResult): string {
  if (turn.toolCalls.length === 0) return turn.finalText;
  try {
    return JSON.stringify(specifierResponseFromToolCalls(turn.toolCalls));
  } catch (err) {
    // Surface tool-mapping or schema failures as JSON that downstream parses
    // cleanly but fails SpecifierResponseSchema, so the result classifies as
    // schema_error rather than aborting the eval suite.
    const message = err instanceof SpecifierToolMappingError
      ? err.message
      : err instanceof Error
        ? err.message
        : String(err);
    return JSON.stringify({
      __toolMappingError: message,
      files: [],
      openQuestions: [],
      assumptions: [],
      risks: [],
    });
  }
}

interface OpenedSession {
  session: AgentSession;
  ticket: Ticket;
  comments: Comment[];
}

function openSpecifierSession(
  adapter: ReturnType<typeof createConfiguredAdapter>,
  opts: LiveRunnerOptions,
  fixture: SpecifyEvalFixture,
  urlBase: string,
): OpenedSession {
  const session = adapter.openSession({
    role: "specifier",
    model: opts.model,
    systemPrompt: SPECIFIER_SYSTEM_PROMPT,
    runId: `eval-${fixture.id}`,
    ticketId: `eval/${fixture.id}`,
    profileId: "eval",
  });
  return {
    session,
    ticket: buildSyntheticTicket(fixture, urlBase),
    comments: buildSyntheticComments(fixture.operatorComments),
  };
}

interface RevisionContext {
  priorDraftJson: string;
  critique: string;
}

async function runSpecifierTurn(
  opened: OpenedSession,
  fixture: SpecifyEvalFixture,
  revision?: RevisionContext,
): Promise<TurnResult> {
  const baseMessage = renderUserMessage(opened.ticket, opened.comments, fixture.priorDraft);
  const userMessage = revision
    ? `${baseMessage}\n\n## Your previous response\n\`\`\`json\n${revision.priorDraftJson}\n\`\`\`\n\n## Revision feedback\n${revision.critique}\n\nFix every violation and return the full updated response.`
    : baseMessage;
  return opened.session.run(userMessage, {
    outputSchema: SpecifierResponseJsonSchema,
    outputTools: SPECIFIER_TOOLS,
  });
}

/**
 * Live runner for `eval:specify`. Calls the configured adapter once per
 * fixture and returns the raw turn output.
 *
 * Caller MUST `close()` to release any underlying session resources.
 */
export function createLiveRunner(opts: LiveRunnerOptions): ClosableSpecifyTurnRunner {
  const adapter = createConfiguredAdapter(opts.provider, {});
  const sessions: AgentSession[] = [];
  const urlBase = opts.ticketUrlBase ?? "https://example.invalid/eval";

  return {
    async run(fixture) {
      const opened = openSpecifierSession(adapter, opts, fixture, urlBase);
      sessions.push(opened.session);
      const turn = await runSpecifierTurn(opened, fixture);
      return {
        finalText: flattenTurn(turn),
        usage: turn.usage,
        costMicroUsd: turn.cost,
      };
    },
    async close() {
      await closeSessions(sessions);
    },
  };
}

async function closeSessions(sessions: ReadonlyArray<AgentSession>): Promise<void> {
  for (const session of sessions) {
    if (session.close) {
      try {
        await session.close();
      } catch {
        // Best-effort: an adapter that no longer holds resources may throw.
      }
    }
  }
}

export interface CritiqueReviseRunnerOptions {
  generator: LiveRunnerOptions;
  judge: SpecJudge;
  /** 0 = no revision (judge runs but its verdict doesn't trigger a retry).
   *  1 = up to one revision turn (typical). */
  maxRevisions: number;
  /**
   * Sink for per-fixture judge telemetry: verdicts, critique length, cost.
   * Lets the CLI report how often the judge fired vs let the first attempt
   * through.
   */
  onJudgeVerdict?: (fixtureId: string, verdict: SpecJudgeVerdict, attempt: number) => void;
}

/**
 * Compose the live specifier with a judge so each fixture can do up to one
 * critique-revise round-trip.
 *
 * Per fixture:
 *   1. Open one specifier session (kept open across revisions so model state
 *      and prompt cache are shared).
 *   2. Run turn 1 → draft_1.
 *   3. Ask the judge. If verdict=pass, return draft_1.
 *   4. If verdict=revise and revisions remain, run turn 2 with the critique
 *      appended. Return draft_2.
 *
 * Cost is the sum of all specifier turns plus all judge calls. Usage is
 * specifier-only (judge usage is its own series and reported via the
 * verdict callback).
 */
export function createCritiqueReviseRunner(
  opts: CritiqueReviseRunnerOptions,
): ClosableSpecifyTurnRunner {
  const adapter = createConfiguredAdapter(opts.generator.provider, {});
  const sessions: AgentSession[] = [];
  const urlBase = opts.generator.ticketUrlBase ?? "https://example.invalid/eval";

  return {
    async run(fixture) {
      const initial = openSpecifierSession(adapter, opts.generator, fixture, urlBase);
      sessions.push(initial.session);

      let turn = await runSpecifierTurn(initial, fixture);
      let totalUsage: TokenUsage = turn.usage;
      let totalCost = turn.cost;
      let attempt = 1;

      let finalText = flattenTurn(turn);

      while (attempt <= opts.maxRevisions) {
        const verdict = await opts.judge.evaluate(fixture, finalText);
        totalCost += verdict.costMicroUsd;
        opts.onJudgeVerdict?.(fixture.id, verdict, attempt);
        if (verdict.verdict === "pass") {
          break;
        }
        // Open a fresh session per revision: the specifier returns
        // structured output via tool_calls, so reusing the same session
        // would leave dangling tool_call ids that xAI rejects on the next
        // user turn ("Each message must have at least one content
        // element"). A fresh session sidesteps this; we pay a small
        // prompt-cache miss but the experiment stays valid.
        attempt += 1;
        const revisionSession = openSpecifierSession(adapter, opts.generator, fixture, urlBase);
        sessions.push(revisionSession.session);
        turn = await runSpecifierTurn(revisionSession, fixture, {
          priorDraftJson: finalText,
          critique: verdict.critique,
        });
        totalUsage = addUsage(totalUsage, turn.usage);
        totalCost += turn.cost;
        finalText = flattenTurn(turn);
      }

      // Always run a final judge call after the last revision so the
      // operator can see the post-revision verdict, but its cost is included
      // only when revisions actually happened (otherwise we'd double-count
      // when maxRevisions=0). When maxRevisions=0 we skip the loop entirely
      // and never judge.
      if (opts.maxRevisions > 0 && attempt > 1) {
        const finalVerdict = await opts.judge.evaluate(fixture, finalText);
        totalCost += finalVerdict.costMicroUsd;
        opts.onJudgeVerdict?.(fixture.id, finalVerdict, attempt);
      }

      return {
        finalText,
        usage: totalUsage,
        costMicroUsd: totalCost,
      };
    },
    async close() {
      await closeSessions(sessions);
    },
  };
}

