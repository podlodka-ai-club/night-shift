// Smoke test: drive both adapters with a prompt that REQUIRES tool use.
// Confirms tool-use / tool-result events fire on real provider streams,
// not just on hand-crafted SDK messages in unit tests.
//
// Run with:
//   node --import tsx scripts/smoke-tools.ts
// or:
//   node --env-file-if-exists=.env --import tsx scripts/smoke-tools.ts

import { ClaudeAgentAdapter } from "../src/adapters/claude-agent.js";
import { CodexAdapter } from "../src/adapters/codex.js";
import type { AgentAdapter, AgentStreamEvent } from "../src/adapters/index.js";

const PROMPT =
  "Use a shell or read tool to count exactly how many .ts files exist in the scripts/ directory of the current working directory. Then respond with that number, nothing else.";

async function runOne(
  label: string,
  adapter: AgentAdapter,
  model: string,
): Promise<void> {
  console.log(`\n===== ${label} (${model}) =====`);
  const session = adapter.openSession({
    role: "specifier",
    model,
    runId: "smoke-tools-1",
    ticketId: `T-tools-${label.toLowerCase()}`,
    profileId: "smoke",
    workingDirectory: process.cwd(),
  });

  const events: AgentStreamEvent[] = [];
  let finalText = "";
  const t0 = Date.now();

  for await (const ev of session.runStreamed(PROMPT)) {
    events.push(ev);
    if (ev.kind === "tool-use") {
      const inputPreview = JSON.stringify(ev.input).slice(0, 120);
      console.log(`  [tool-use] ${ev.tool} (${ev.source.kind}) ${inputPreview}`);
    } else if (ev.kind === "tool-result") {
      console.log(`  [tool-result] ${ev.toolCallId} status=${ev.status}`);
    } else if (ev.kind === "message-completed") {
      finalText = ev.text;
    } else if (ev.kind === "turn-failed") {
      console.log(`  [turn-failed] ${ev.error.message}`);
    } else if (ev.kind === "warning") {
      console.log(`  [warning] ${ev.message}`);
    }
  }

  const wallMs = Date.now() - t0;
  const counts = {
    toolUse: events.filter((e) => e.kind === "tool-use").length,
    toolResult: events.filter((e) => e.kind === "tool-result").length,
    textDelta: events.filter((e) => e.kind === "text-delta").length,
    messageCompleted: events.filter((e) => e.kind === "message-completed").length,
  };
  const turnCompleted = events.find((e) => e.kind === "turn-completed");
  const usage = turnCompleted?.kind === "turn-completed" ? turnCompleted.usage : undefined;
  const cost = turnCompleted?.kind === "turn-completed" ? turnCompleted.cost : undefined;

  console.log(`\n  finalText: ${JSON.stringify(finalText)}`);
  console.log(`  event counts:`, counts);
  console.log(`  usage:`, usage);
  console.log(`  cost (micro-USD): ${cost}`);
  console.log(`  wallMs: ${wallMs}`);

  const verdict =
    counts.toolUse > 0 && counts.toolResult > 0
      ? "ok (tool path exercised)"
      : counts.toolUse > 0
        ? "partial (tool-use without tool-result)"
        : "no tools used (model answered from prompt alone)";
  console.log(`  VERDICT: ${verdict}`);
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
  );

  await runOne(
    "Codex",
    new CodexAdapter(),
    process.env.SMOKE_CODEX_MODEL ?? "gpt-5.4-mini",
  );
}

main().catch((err) => {
  console.error("smoke failed:", err);
  process.exit(1);
});
