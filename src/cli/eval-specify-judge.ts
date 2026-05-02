import { computeCost } from "../adapters/index.js";
import type { TokenUsage } from "../adapters/types.js";
import type { SpecifyEvalFixture } from "../eval/index.js";

/**
 * Cross-family LLM judge for the specify-phase eval harness.
 *
 * The judge is a minimal Anthropic Messages API caller — no SDK — so we can
 * keep the dependency surface tight and the cost path obvious. The judge
 * model is intentionally a different family from the generator (xAI Grok) to
 * dampen self-preference bias when we use the verdict to drive a
 * critique-revise loop.
 *
 * The judge does NOT make a final correctness call. It checks the
 * engineering-hygiene rules baked into the specifier's system prompt:
 *
 *   - faithfulness: does the proposal address the ticket?
 *   - hygiene:     are load-bearing claims marked as evidence vs assumption?
 *   - questions:   are openQuestions real blockers, not noise?
 *   - scope:       does the spec stay within the ticket's scope?
 *   - dod:         is there a checkable acceptance criterion?
 *
 * If any of these are violated, the verdict is "revise" with an actionable
 * critique. Otherwise, "pass".
 */

export interface SpecJudgeVerdict {
  verdict: "pass" | "revise";
  /** Operator-readable critique. Empty when verdict is "pass". */
  critique: string;
  costMicroUsd: number;
  usage: TokenUsage;
  /** Judge model id, for telemetry. */
  model: string;
}

export interface SpecJudge {
  evaluate(fixture: SpecifyEvalFixture, draftJson: string): Promise<SpecJudgeVerdict>;
}

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
const DEFAULT_JUDGE_MODEL = "claude-haiku-4-5";

export type JudgeProvider = "anthropic" | "openai";

/**
 * Retry POSTs against judge APIs on transient network errors and 5xx
 * responses. Long reasoning calls (gpt-5-mini, sonnet revisions) sometimes
 * see "fetch failed" socket resets; retrying once or twice is cheaper and
 * cleaner than aborting an entire eval run.
 */
async function fetchJudgeWithRetry(
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit,
  attempts = 3,
): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetchFn(url, init);
      if (res.ok || res.status < 500) return res;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    // Backoff 1s, 3s, ... before next attempt.
    if (i < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000 * (1 + 2 * i)));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

const JUDGE_SYSTEM_PROMPT = `You are a strict but fair reviewer of OpenSpec change proposals.

Given a ticket and a candidate spec (proposal.md, tasks.md, optional design.md
and specs/<capability>/spec.md, plus surfaced openQuestions / assumptions /
risks), decide whether the spec is ready to hand off to an implementer or
whether the specifier should revise it.

Rubric (a single failing item is enough to require revision):

  R1. FAITHFULNESS — proposal.md actually addresses the ticket as written
      (no scope drift, no swapping the problem for a different one).
  R2. EVIDENCE     — claims about how the system currently behaves cite a
      file/symbol or are explicitly marked as assumptions. No bare
      "the code does X" without evidence.
  R3. ASSUMPTIONS  — load-bearing assumptions are listed in the assumptions
      array, not buried in prose.
  R4. QUESTIONS    — every entry in openQuestions is a real blocker for
      implementation. Vague curiosity ("could we also...") doesn't count.
  R5. SCOPE        — tasks.md does not pull in unrelated work or feature
      creep beyond the ticket.
  R6. DOD          — proposal.md has a checkable acceptance criterion (or
      definition of done) such that a reviewer could decide pass/fail.

Return strict JSON, no prose:

{
  "verdict": "pass" | "revise",
  "violations": [{"rule": "R2", "detail": "<one sentence, specific>"}],
  "critique": "<paragraph the specifier reads on revision; empty when pass>"
}

Rules:
- "pass" requires zero violations.
- "revise" requires at least one violation and a non-empty critique.
- The critique must be ACTIONABLE: name the file/section and what to change.
- Do not invent facts about the codebase. If the spec lacks evidence and
  has not flagged the gap as an assumption, that itself is an R2 violation.`;

function renderJudgeUserMessage(fixture: SpecifyEvalFixture, draftJson: string): string {
  const labels = fixture.ticket.labels.length > 0
    ? `Labels: ${fixture.ticket.labels.join(", ")}\n`
    : "";
  const comments = fixture.operatorComments.length > 0
    ? `## Operator comments\n${fixture.operatorComments.map((c) => `- ${c}`).join("\n")}\n\n`
    : "";
  const priorDraft = fixture.priorDraft.length > 0
    ? `## Prior draft (the specifier was asked to revise this)\n${fixture.priorDraft
        .map((f) => `### ${f.path}\n\`\`\`markdown\n${f.content}\n\`\`\``)
        .join("\n\n")}\n\n`
    : "";

  return [
    `# Ticket: ${fixture.ticket.title}`,
    labels,
    "## Description",
    fixture.ticket.description.trim() || "_(no description)_",
    "",
    comments + priorDraft + "## Candidate spec (JSON)",
    "```json",
    draftJson,
    "```",
    "",
    "Apply the rubric and return the JSON verdict.",
  ].join("\n");
}

interface AnthropicResponse {
  content: Array<{ type: string; text?: string }>;
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number };
}

interface JudgePayload {
  verdict: "pass" | "revise";
  violations: Array<{ rule: string; detail: string }>;
  critique: string;
}

function extractJsonBlock(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return trimmed;
  // Tolerate ```json ... ``` wrappers if Claude decides to use them.
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fenceMatch?.[1]) return fenceMatch[1].trim();
  return trimmed;
}

export interface CreateAnthropicJudgeOptions {
  /** Defaults to ANTHROPIC_API_KEY. */
  apiKey?: string;
  /** Defaults to claude-haiku-4-5. */
  model?: string;
  /** Test injection. */
  fetchFn?: typeof fetch;
}

export function createAnthropicJudge(opts: CreateAnthropicJudgeOptions = {}): SpecJudge {
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
  const model = opts.model ?? DEFAULT_JUDGE_MODEL;
  const fetchFn = opts.fetchFn ?? fetch;
  if (!apiKey) {
    throw new Error(
      "createAnthropicJudge: no API key (set ANTHROPIC_API_KEY or pass options.apiKey)",
    );
  }

  return {
    async evaluate(fixture, draftJson): Promise<SpecJudgeVerdict> {
      const userMessage = renderJudgeUserMessage(fixture, draftJson);
      const res = await fetchJudgeWithRetry(fetchFn, ANTHROPIC_API_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: 4096,
          system: JUDGE_SYSTEM_PROMPT,
          messages: [{ role: "user", content: userMessage }],
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`judge API error ${res.status}: ${body.slice(0, 400)}`);
      }
      const json = (await res.json()) as AnthropicResponse;
      const textPart = json.content.find((c) => c.type === "text" && typeof c.text === "string");
      const text = textPart?.text ?? "";

      let payload: JudgePayload;
      try {
        payload = JSON.parse(extractJsonBlock(text)) as JudgePayload;
      } catch (err) {
        throw new Error(
          `judge returned non-JSON output: ${(err as Error).message}\n--- raw ---\n${text.slice(0, 800)}`,
        );
      }

      const usage: TokenUsage = {
        input_tokens: json.usage.input_tokens,
        output_tokens: json.usage.output_tokens,
        cached_input_tokens: json.usage.cache_read_input_tokens ?? 0,
      };
      const costMicroUsd = computeCost(model, usage);

      const verdict: "pass" | "revise" =
        payload.verdict === "pass" ? "pass" : "revise";
      const critique = verdict === "revise"
        ? renderCritique(payload)
        : "";

      return { verdict, critique, costMicroUsd, usage, model };
    },
  };
}

interface OpenAIResponse {
  choices: Array<{ message?: { content?: string } }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

export interface CreateOpenAIJudgeOptions {
  /** Defaults to OPENAI_API_KEY. */
  apiKey?: string;
  /** Defaults to gpt-5-mini. */
  model?: string;
  /** Test injection. */
  fetchFn?: typeof fetch;
}

export function createOpenAIJudge(opts: CreateOpenAIJudgeOptions = {}): SpecJudge {
  const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY;
  const model = opts.model ?? "gpt-5-mini";
  const fetchFn = opts.fetchFn ?? fetch;
  if (!apiKey) {
    throw new Error(
      "createOpenAIJudge: no API key (set OPENAI_API_KEY or pass options.apiKey)",
    );
  }

  return {
    async evaluate(fixture, draftJson): Promise<SpecJudgeVerdict> {
      const userMessage = renderJudgeUserMessage(fixture, draftJson);
      const res = await fetchJudgeWithRetry(fetchFn, OPENAI_API_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: JUDGE_SYSTEM_PROMPT },
            { role: "user", content: userMessage },
          ],
          response_format: { type: "json_object" },
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`judge API error ${res.status}: ${body.slice(0, 400)}`);
      }
      const json = (await res.json()) as OpenAIResponse;
      const text = json.choices[0]?.message?.content ?? "";

      let payload: JudgePayload;
      try {
        payload = JSON.parse(extractJsonBlock(text)) as JudgePayload;
      } catch (err) {
        throw new Error(
          `judge returned non-JSON output: ${(err as Error).message}\n--- raw ---\n${text.slice(0, 800)}`,
        );
      }

      const usage: TokenUsage = {
        input_tokens: json.usage.prompt_tokens,
        output_tokens: json.usage.completion_tokens,
        cached_input_tokens: json.usage.prompt_tokens_details?.cached_tokens ?? 0,
      };
      const costMicroUsd = computeCost(model, usage);

      const verdict: "pass" | "revise" =
        payload.verdict === "pass" ? "pass" : "revise";
      const critique = verdict === "revise"
        ? renderCritique(payload)
        : "";

      return { verdict, critique, costMicroUsd, usage, model };
    },
  };
}

export interface CreateSpecJudgeOptions {
  provider: JudgeProvider;
  model?: string;
  apiKey?: string;
  fetchFn?: typeof fetch;
}

export function createSpecJudge(opts: CreateSpecJudgeOptions): SpecJudge {
  const inner: CreateAnthropicJudgeOptions & CreateOpenAIJudgeOptions = {};
  if (opts.apiKey !== undefined) inner.apiKey = opts.apiKey;
  if (opts.model !== undefined) inner.model = opts.model;
  if (opts.fetchFn !== undefined) inner.fetchFn = opts.fetchFn;
  if (opts.provider === "anthropic") return createAnthropicJudge(inner);
  if (opts.provider === "openai") return createOpenAIJudge(inner);
  throw new Error(`unknown judge provider: ${String(opts.provider)}`);
}

function renderCritique(payload: JudgePayload): string {
  const lines: string[] = [];
  if (payload.critique?.trim()) {
    lines.push(payload.critique.trim());
  }
  if (payload.violations.length > 0) {
    lines.push("");
    lines.push("Violations:");
    for (const v of payload.violations) {
      lines.push(`- [${v.rule}] ${v.detail}`);
    }
  }
  return lines.join("\n").trim();
}
