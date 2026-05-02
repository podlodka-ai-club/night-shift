import { createConfiguredAdapter } from "../adapters/index.js";
import type { AgentSession, TurnResult } from "../adapters/events.js";
import type { TokenUsage } from "../adapters/types.js";
import type { Comment } from "../github/types.js";
import type { Ticket } from "../contracts/ticket.js";
import type { ImplementEvalFixture, ImplementTurnRunner } from "../eval/index.js";
import {
  IMPLEMENTER_SYSTEM_PROMPT,
  renderImplementerMessage,
  type SpecBundleFile,
} from "../phases/implement/prompt.js";
import type { ImplementJudge, ImplementJudgeVerdict } from "./eval-implement-judge.js";

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cached_input_tokens: a.cached_input_tokens + b.cached_input_tokens,
  };
}

export interface ImplementLiveRunnerOptions {
  provider: string;
  model: string;
  /** Override the synthetic ticket URL base; must be a valid absolute URL. */
  ticketUrlBase?: string;
}

export interface ClosableImplementTurnRunner extends ImplementTurnRunner {
  close(): Promise<void>;
}

function buildSyntheticTicket(fixture: ImplementEvalFixture, urlBase: string): Ticket {
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
 * The implementer returns its final answer as a single JSON message. Without
 * an outputSchema (xAI rejects the implementer's path-regex schema) Grok
 * tends to wrap the JSON in ```json fences. Strip them so the production
 * parser, which expects strict JSON, doesn't have to know about eval-only
 * formatting quirks.
 */
function stripJsonFences(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return trimmed;
  const fence = trimmed.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fence?.[1]) return fence[1].trim();
  return trimmed;
}

function flattenTurn(turn: TurnResult): string {
  return stripJsonFences(turn.finalText);
}

interface OpenedSession {
  session: AgentSession;
  ticket: Ticket;
  comments: Comment[];
  bundle: SpecBundleFile[];
}

function openImplementerSession(
  adapter: ReturnType<typeof createConfiguredAdapter>,
  opts: ImplementLiveRunnerOptions,
  fixture: ImplementEvalFixture,
  urlBase: string,
): OpenedSession {
  const session = adapter.openSession({
    role: "implementer",
    model: opts.model,
    systemPrompt: IMPLEMENTER_SYSTEM_PROMPT,
    runId: `eval-${fixture.id}`,
    ticketId: `eval/${fixture.id}`,
    profileId: "eval",
  });
  return {
    session,
    ticket: buildSyntheticTicket(fixture, urlBase),
    comments: buildSyntheticComments(fixture.operatorComments),
    bundle: fixture.specBundle.map((f) => ({ path: f.path, content: f.content })),
  };
}

interface RevisionContext {
  priorDraftJson: string;
  critique: string;
}

async function runImplementerTurn(
  opened: OpenedSession,
  revision?: RevisionContext,
): Promise<TurnResult> {
  const baseMessage = renderImplementerMessage(opened.ticket, opened.bundle, opened.comments);
  const userMessage = revision
    ? `${baseMessage}\n\n## Your previous response\n\`\`\`json\n${revision.priorDraftJson}\n\`\`\`\n\n## Revision feedback\n${revision.critique}\n\nFix every violation and return the full updated response.`
    : baseMessage;
  // No outputSchema/outputTools: the implementer system prompt already
  // forces "single JSON object, no prose". xAI's json_schema mode rejects
  // the implementer schema's path-regex + superRefine combo, and tool
  // dispatch would force us to flatten tool calls back into JSON. Free
  // text + parser is the cleanest path here.
  return opened.session.run(userMessage);
}

async function closeSessions(sessions: ReadonlyArray<AgentSession>): Promise<void> {
  for (const session of sessions) {
    if (session.close) {
      try {
        await session.close();
      } catch {
        // Best-effort cleanup.
      }
    }
  }
}

/**
 * Live runner for `eval:implement`. Calls the configured adapter once per
 * fixture and returns the raw turn output. Caller MUST `close()`.
 */
export function createImplementLiveRunner(
  opts: ImplementLiveRunnerOptions,
): ClosableImplementTurnRunner {
  const adapter = createConfiguredAdapter(opts.provider, {});
  const sessions: AgentSession[] = [];
  const urlBase = opts.ticketUrlBase ?? "https://example.invalid/eval";

  return {
    async run(fixture) {
      const opened = openImplementerSession(adapter, opts, fixture, urlBase);
      sessions.push(opened.session);
      const turn = await runImplementerTurn(opened);
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

export interface ImplementCritiqueReviseRunnerOptions {
  generator: ImplementLiveRunnerOptions;
  judge: ImplementJudge;
  /** 0 = no revision (judge runs but its verdict doesn't trigger a retry).
   *  1 = up to one revision turn (typical). */
  maxRevisions: number;
  onJudgeVerdict?: (
    fixtureId: string,
    verdict: ImplementJudgeVerdict,
    attempt: number,
  ) => void;
}

/**
 * Compose the live implementer with a judge so each fixture can do up to one
 * critique-revise round-trip. Mirrors `createCritiqueReviseRunner` in
 * `eval-specify-live.ts`.
 *
 * Per fixture:
 *   1. Open implementer session.
 *   2. Run turn 1 → draft_1.
 *   3. Ask the judge. If verdict=pass, return draft_1.
 *   4. If verdict=revise and revisions remain, open a fresh session and run
 *      turn 2 with the critique appended. Return draft_2.
 *
 * Cost is the sum of all implementer turns plus all judge calls. Usage is
 * implementer-only (judge usage is reported via the verdict callback).
 *
 * If a draft fails to parse as JSON, it is still passed to the judge — the
 * judge's rubric expects parseable JSON, so a parse-error draft will almost
 * certainly draw a "revise" verdict, which is the right signal.
 */
export function createImplementCritiqueReviseRunner(
  opts: ImplementCritiqueReviseRunnerOptions,
): ClosableImplementTurnRunner {
  const adapter = createConfiguredAdapter(opts.generator.provider, {});
  const sessions: AgentSession[] = [];
  const urlBase = opts.generator.ticketUrlBase ?? "https://example.invalid/eval";

  return {
    async run(fixture) {
      const initial = openImplementerSession(adapter, opts.generator, fixture, urlBase);
      sessions.push(initial.session);

      let turn = await runImplementerTurn(initial);
      let totalUsage: TokenUsage = turn.usage;
      let totalCost = turn.cost;
      let attempt = 1;
      let finalText = flattenTurn(turn);

      while (attempt <= opts.maxRevisions) {
        const verdict = await opts.judge.evaluate(fixture, finalText);
        totalCost += verdict.costMicroUsd;
        opts.onJudgeVerdict?.(fixture.id, verdict, attempt);
        if (verdict.verdict === "pass") break;
        attempt += 1;
        // Fresh session per revision: the implementer doesn't use tool calls
        // so this is mostly defensive parity with the specify runner. We pay
        // a small prompt-cache miss but the experiment stays clean.
        const revisionSession = openImplementerSession(adapter, opts.generator, fixture, urlBase);
        sessions.push(revisionSession.session);
        turn = await runImplementerTurn(revisionSession, {
          priorDraftJson: finalText,
          critique: verdict.critique,
        });
        totalUsage = addUsage(totalUsage, turn.usage);
        totalCost += turn.cost;
        finalText = flattenTurn(turn);
      }

      // Always run a final judge call after the last revision so the operator
      // can see the post-revision verdict, but only when revisions actually
      // happened (otherwise we'd double-count when maxRevisions=0).
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
