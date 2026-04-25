import { describe, expect, it, vi, beforeEach } from "vitest";
import { ActivityProgressReporter } from "../activity-progress.js";
import type { AgentStreamEvent } from "../../adapters/events.js";

function makeReporter(nowRef: { value: number }) {
  const calls: string[] = [];
  const signalFn = vi.fn(async (md: string) => {
    calls.push(md);
  });
  const reporter = new ActivityProgressReporter({
    signalFn,
    phaseName: "specify",
    now: () => nowRef.value,
  });
  return { reporter, signalFn, calls };
}

function toolUse(toolCallId: string, tool = "npm test"): AgentStreamEvent {
  return {
    kind: "tool-use",
    toolCallId,
    tool,
    input: {},
    source: { kind: "shell" },
  };
}

describe("ActivityProgressReporter", () => {
  let nowRef: { value: number };

  beforeEach(() => {
    nowRef = { value: 2000 };
  });

  it("formats tool-use events", async () => {
    const { reporter, calls } = makeReporter(nowRef);
    await reporter.push(toolUse("tool-1"));
    expect(calls.at(-1)).toContain("⚡ shell `npm test`");
  });

  it("appends tool-result to the matching tool-use line", async () => {
    const { reporter, calls } = makeReporter(nowRef);
    await reporter.push(toolUse("tool-1"));
    nowRef.value = 4500;
    await reporter.push({
      kind: "tool-result",
      toolCallId: "tool-1",
      status: "completed",
      output: null,
    });
    await reporter.flush();

    expect(calls.at(-1)).toContain("⚡ shell `npm test` → ✅ (2.5s)");
  });

  it("truncates message-completed text at 60 chars", async () => {
    const { reporter, calls } = makeReporter(nowRef);
    await reporter.push({
      kind: "message-completed",
      messageId: "m1",
      text: "x".repeat(80),
    });
    await reporter.flush();

    expect(calls.at(-1)).toContain(`💬 "${"x".repeat(60)}..."`);
  });

  it("formats turn-completed with comma-separated tokens and USD cost", async () => {
    const { reporter, calls } = makeReporter(nowRef);
    await reporter.push({
      kind: "turn-completed",
      usage: { input_tokens: 1204, output_tokens: 96, cached_input_tokens: 0 },
      cost: 20_000,
    });

    expect(calls.at(-1)).toContain("📊 Turn 1 — 1,300 tokens ($0.02)");
  });

  it("caps the buffer at the last 10 entries", async () => {
    const { reporter, calls } = makeReporter(nowRef);
    for (let index = 1; index <= 12; index += 1) {
      await reporter.push({
        kind: "message-completed",
        messageId: `m${index}`,
        text: `message-${index}`,
      });
    }
    await reporter.flush();

    expect(calls.at(-1)).not.toContain('💬 "message-1"');
    expect(calls.at(-1)).not.toContain('💬 "message-2"');
    expect(calls.at(-1)).toContain('💬 "message-12"');
  });

  it("does not send for non-immediate events before flush", async () => {
    const { reporter, signalFn } = makeReporter(nowRef);
    await reporter.push({
      kind: "message-completed",
      messageId: "m1",
      text: "hello",
    });
    expect(signalFn).not.toHaveBeenCalled();
  });

  it("sends immediately on tool-use once the minimum interval has elapsed", async () => {
    const { reporter, signalFn } = makeReporter(nowRef);
    await reporter.push(toolUse("tool-1"));
    expect(signalFn).toHaveBeenCalledTimes(1);

    nowRef.value = 4501;
    await reporter.push(toolUse("tool-2", "npm run typecheck"));
    expect(signalFn).toHaveBeenCalledTimes(2);
  });

  it("flush sends the remaining buffer", async () => {
    const { reporter, signalFn } = makeReporter(nowRef);
    await reporter.push({
      kind: "message-completed",
      messageId: "m1",
      text: "hello",
    });
    await reporter.flush();
    expect(signalFn).toHaveBeenCalledTimes(1);
  });

  it("prefixes payloads with the running header", async () => {
    const { reporter, calls } = makeReporter(nowRef);
    await reporter.push(toolUse("tool-1"));
    expect(calls.at(-1)?.startsWith("### 🤖 Specify — running")).toBe(true);
  });
});