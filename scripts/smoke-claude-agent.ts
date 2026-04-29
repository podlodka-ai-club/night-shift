// Smoke test: open a real ClaudeAgentAdapter session, run a tiny prompt,
// print finalText, usage, and cost. Requires ANTHROPIC_API_KEY in env.
//
// Run with:
//   node --import tsx scripts/smoke-claude-agent.ts
// or:
//   node --env-file-if-exists=.env --import tsx scripts/smoke-claude-agent.ts

import { ClaudeAgentAdapter } from "../src/adapters/claude-agent.js";

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is not set");
    process.exit(1);
  }

  const adapter = new ClaudeAgentAdapter();
  const session = adapter.openSession({
    role: "specifier",
    model: process.env.SMOKE_MODEL ?? "claude-haiku-4-5",
    runId: "smoke-1",
    ticketId: "T-smoke",
    profileId: "smoke",
    systemPrompt:
      "You are a terse smoke-test assistant. Answer in 5 words or fewer.",
  });

  console.log(">>> run() one-shot");
  const t0 = Date.now();
  const result = await session.run("Reply with exactly: pong");
  const wallMs = Date.now() - t0;
  console.log("finalText:", JSON.stringify(result.finalText));
  console.log("usage:", result.usage);
  console.log("cost (micro-USD):", result.cost);
  console.log("latencyMs:", result.latencyMs, "wallMs:", wallMs);
  console.log("session.id:", session.id);

  console.log("\n>>> runStreamed() resume");
  for await (const ev of session.runStreamed("Now reply with exactly: ack")) {
    if (ev.kind === "text-delta") {
      process.stdout.write(`[delta] ${ev.text}\n`);
    } else if (ev.kind === "message-completed") {
      console.log(`[done] ${JSON.stringify(ev.text)}`);
    } else if (ev.kind === "tool-use") {
      console.log(
        `[tool-use] ${ev.tool} (${ev.source.kind})`,
      );
    } else if (ev.kind === "tool-result") {
      console.log(`[tool-result] ${ev.toolCallId} status=${ev.status}`);
    } else if (ev.kind === "turn-completed") {
      console.log("[turn-completed] cost:", ev.cost, "usage:", ev.usage);
    } else if (ev.kind === "turn-failed") {
      console.log("[turn-failed]", ev.error.message);
    } else {
      console.log(`[${ev.kind}]`);
    }
  }
  console.log("session.id (after resume):", session.id);
}

main().catch((err) => {
  console.error("smoke failed:", err);
  process.exit(1);
});
