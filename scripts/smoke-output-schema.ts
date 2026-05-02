// Smoke test: drive both ClaudeAgentAdapter and CodexAdapter through the
// same TurnOpts.outputSchema and confirm both return JSON that parses,
// validates against the schema, and contains the expected payload.
//
// Run with:
//   node --import tsx scripts/smoke-output-schema.ts
// or:
//   node --env-file-if-exists=.env --import tsx scripts/smoke-output-schema.ts

import { ClaudeAgentAdapter } from "../src/adapters/claude-agent.js";
import { CodexAdapter } from "../src/adapters/codex.js";
import type { AgentAdapter, TurnResult } from "../src/adapters/index.js";

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["answer", "letters", "count"],
  properties: {
    answer: { type: "string" },
    letters: {
      type: "array",
      items: { type: "string" },
    },
    count: { type: "integer" },
  },
} as const;

const PROMPT =
  "Return JSON with answer='pong', letters as the array ['p','o','n','g'], and count=4.";

interface ParsedPayload {
  answer: string;
  letters: string[];
  count: number;
}

function validate(raw: string): { ok: true; payload: ParsedPayload } | { ok: false; reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, reason: `not valid JSON: ${(err as Error).message}` };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, reason: `top-level is not an object` };
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.answer !== "string") return { ok: false, reason: "missing/invalid answer" };
  if (!Array.isArray(obj.letters)) return { ok: false, reason: "missing/invalid letters" };
  if (!obj.letters.every((l) => typeof l === "string")) {
    return { ok: false, reason: "letters not all strings" };
  }
  if (!Number.isInteger(obj.count)) return { ok: false, reason: "missing/invalid count" };
  return {
    ok: true,
    payload: {
      answer: obj.answer,
      letters: obj.letters as string[],
      count: obj.count as number,
    },
  };
}

async function runOne(
  label: string,
  adapter: AgentAdapter,
  model: string,
  ticketId: string,
): Promise<void> {
  console.log(`\n===== ${label} (${model}) =====`);
  const session = adapter.openSession({
    role: "specifier",
    model,
    runId: "smoke-schema-1",
    ticketId,
    profileId: "smoke",
  });

  const t0 = Date.now();
  let result: TurnResult;
  try {
    result = await session.run(PROMPT, { outputSchema: SCHEMA });
  } catch (err) {
    console.log("ERROR:", (err as Error).message);
    return;
  }
  const wallMs = Date.now() - t0;

  console.log("finalText:", result.finalText);
  console.log("usage:", result.usage);
  console.log("cost (micro-USD):", result.cost);
  console.log("latencyMs:", result.latencyMs, "wallMs:", wallMs);

  const verdict = validate(result.finalText);
  if (!verdict.ok) {
    console.log("VALIDATION FAILED:", verdict.reason);
    return;
  }
  const { payload } = verdict;
  console.log("parsed:", payload);

  const expectedLetters = ["p", "o", "n", "g"];
  const lettersMatch =
    payload.letters.length === expectedLetters.length &&
    payload.letters.every((l, i) => l.toLowerCase() === expectedLetters[i]);
  const ok =
    payload.answer.toLowerCase() === "pong" && lettersMatch && payload.count === 4;
  console.log(ok ? "VERDICT: ok" : "VERDICT: mismatch (schema valid, payload wrong)");
}

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is not set");
    process.exit(1);
  }

  await runOne(
    "Claude",
    new ClaudeAgentAdapter(),
    process.env.SMOKE_CLAUDE_MODEL ?? "claude-haiku-4-5",
    "T-smoke-claude",
  );

  await runOne(
    "Codex",
    new CodexAdapter(),
    process.env.SMOKE_CODEX_MODEL ?? "gpt-5.4-mini",
    "T-smoke-codex",
  );
}

main().catch((err) => {
  console.error("smoke failed:", err);
  process.exit(1);
});
