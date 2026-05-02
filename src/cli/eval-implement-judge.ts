import { computeCost } from "../adapters/index.js";
import type { TokenUsage } from "../adapters/types.js";
import type { ImplementEvalFixture } from "../eval/index.js";

/**
 * Cross-family LLM judge for the implement-phase eval harness.
 *
 * Mirrors `eval-specify-judge.ts`: minimal direct fetch to OpenAI / Anthropic
 * (no SDK), retry-on-network-error, JSON-only verdicts. The rubric is
 * implement-specific — the goal is to catch implementer drift from the spec
 * bundle (scope creep, missing acceptance criteria, evidence holes), not to
 * grade code quality at the line level.
 */

export interface ImplementJudgeVerdict {
  verdict: "pass" | "revise";
  /** Operator-readable critique. Empty when verdict is "pass". */
  critique: string;
  costMicroUsd: number;
  usage: TokenUsage;
  model: string;
}

export interface ImplementJudge {
  evaluate(fixture: ImplementEvalFixture, draftJson: string): Promise<ImplementJudgeVerdict>;
}

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";

export type ImplementJudgeProvider = "anthropic" | "openai";

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
    if (i < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000 * (1 + 2 * i)));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

const JUDGE_SYSTEM_PROMPT = `You are a strict but fair reviewer of implementer outputs in a spec-driven code-generation system.

You receive: a ticket, the approved spec bundle (proposal.md, tasks.md, optional design.md), optional operator comments, and the implementer's candidate response (a JSON object with filesWritten, commitMessage, summary, followUps).

Decide whether the response is ready for code review or whether the implementer should revise it.

Rubric (a single failing item is enough to require revision):

  R1. FAITHFULNESS    — filesWritten addresses the tasks listed in tasks.md
      and the proposal in proposal.md. No swapping the problem for a
      different one.
  R2. DOD MAPPING     — every acceptance criterion in proposal.md is
      addressed by a concrete change OR explicitly called out in
      summary/followUps as deferred. The summary should make this mapping
      visible (file/section/test name).
  R3. SCOPE           — filesWritten does not pull in unrelated work.
      Tasks marked "maybe" in tasks.md should be deferred to followUps,
      not silently shipped.
  R4. EVIDENCE        — summary's claims about behavior cite a concrete
      artifact (file:line, test name, command output) or are explicitly
      labeled as assumptions. No bare "this works".
  R5. ASSUMPTIONS     — load-bearing assumptions about call sites,
      contracts, or invariants are surfaced in summary or followUps
      (not buried in code comments).
  R6. SELF-ATTACK     — edge cases (empty input, error paths, boundary
      values, regressions in related code) are addressed in code or
      called out in followUps. A blank "no edge cases considered" is a
      violation.

Return strict JSON, no prose:

{
  "verdict": "pass" | "revise",
  "violations": [{"rule": "R2", "detail": "<one sentence, specific>"}],
  "critique": "<paragraph the implementer reads on revision; empty when pass>"
}

Rules:
- "pass" requires zero violations.
- "revise" requires at least one violation and a non-empty critique.
- The critique must be ACTIONABLE: name the file/section/AC and what to change.
- The fixture is shape-only: the implementer writes files but does NOT run
  them in a real worktree. Do not require execution evidence (test runs,
  CI output) — code-level evidence (file:line, test names) is sufficient.
- Do not invent facts about a real codebase. The bundle and ticket are the
  ground truth.`;

function renderJudgeUserMessage(fixture: ImplementEvalFixture, draftJson: string): string {
  const labels = fixture.ticket.labels.length > 0
    ? `Labels: ${fixture.ticket.labels.join(", ")}\n`
    : "";
  const comments = fixture.operatorComments.length > 0
    ? `## Operator comments\n${fixture.operatorComments.map((c) => `- ${c}`).join("\n")}\n\n`
    : "";
  const bundle = fixture.specBundle
    .map((f) => `### ${f.path}\n\`\`\`markdown\n${f.content}\n\`\`\``)
    .join("\n\n");

  return [
    `# Ticket: ${fixture.ticket.title}`,
    labels,
    "## Description",
    fixture.ticket.description.trim() || "_(no description)_",
    "",
    "## Spec bundle",
    bundle,
    "",
    comments + "## Candidate implementer response (JSON)",
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
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fenceMatch?.[1]) return fenceMatch[1].trim();
  return trimmed;
}

function renderCritique(payload: JudgePayload): string {
  const lines: string[] = [];
  if (payload.critique?.trim()) lines.push(payload.critique.trim());
  if (payload.violations.length > 0) {
    lines.push("");
    lines.push("Violations:");
    for (const v of payload.violations) {
      lines.push(`- [${v.rule}] ${v.detail}`);
    }
  }
  return lines.join("\n").trim();
}

export interface CreateAnthropicImplementJudgeOptions {
  apiKey?: string;
  model?: string;
  fetchFn?: typeof fetch;
}

export function createAnthropicImplementJudge(
  opts: CreateAnthropicImplementJudgeOptions = {},
): ImplementJudge {
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
  const model = opts.model ?? "claude-haiku-4-5";
  const fetchFn = opts.fetchFn ?? fetch;
  if (!apiKey) {
    throw new Error(
      "createAnthropicImplementJudge: no API key (set ANTHROPIC_API_KEY or pass options.apiKey)",
    );
  }

  return {
    async evaluate(fixture, draftJson): Promise<ImplementJudgeVerdict> {
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
      const verdict: "pass" | "revise" = payload.verdict === "pass" ? "pass" : "revise";
      const critique = verdict === "revise" ? renderCritique(payload) : "";
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

export interface CreateOpenAIImplementJudgeOptions {
  apiKey?: string;
  model?: string;
  fetchFn?: typeof fetch;
}

export function createOpenAIImplementJudge(
  opts: CreateOpenAIImplementJudgeOptions = {},
): ImplementJudge {
  const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY;
  const model = opts.model ?? "gpt-5-mini";
  const fetchFn = opts.fetchFn ?? fetch;
  if (!apiKey) {
    throw new Error(
      "createOpenAIImplementJudge: no API key (set OPENAI_API_KEY or pass options.apiKey)",
    );
  }

  return {
    async evaluate(fixture, draftJson): Promise<ImplementJudgeVerdict> {
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
      const verdict: "pass" | "revise" = payload.verdict === "pass" ? "pass" : "revise";
      const critique = verdict === "revise" ? renderCritique(payload) : "";
      return { verdict, critique, costMicroUsd, usage, model };
    },
  };
}

export interface CreateImplementJudgeOptions {
  provider: ImplementJudgeProvider;
  model?: string;
  apiKey?: string;
  fetchFn?: typeof fetch;
}

export function createImplementJudge(opts: CreateImplementJudgeOptions): ImplementJudge {
  const inner: CreateAnthropicImplementJudgeOptions & CreateOpenAIImplementJudgeOptions = {};
  if (opts.apiKey !== undefined) inner.apiKey = opts.apiKey;
  if (opts.model !== undefined) inner.model = opts.model;
  if (opts.fetchFn !== undefined) inner.fetchFn = opts.fetchFn;
  if (opts.provider === "anthropic") return createAnthropicImplementJudge(inner);
  if (opts.provider === "openai") return createOpenAIImplementJudge(inner);
  throw new Error(`unknown judge provider: ${String(opts.provider)}`);
}
