import { describe, expect, it } from "vitest";
import type { EventSink, PhaseEvent } from "../../contracts/events.js";
import type { NightShiftConfig } from "../../config/schema.js";
import { createAgent } from "../index.js";
import { InMemoryFakeAdapter } from "./fake.js";

const config: NightShiftConfig = {
  roles: {
    specifier: { provider: "codex", model: "gpt-5.4" },
    implementer: { provider: "codex", model: "gpt-5.4" },
    reviewer: { provider: "codex", model: "gpt-5.4" },
    subagent: { provider: "codex", model: "gpt-5.4" },
  },
};

describe("createAgent", () => {
  it("integrates with fake adapter and emits AgentInvoked", async () => {
    const events: PhaseEvent[] = [];
    const sink: EventSink = {
      emit(e) {
        events.push(e);
      },
    };
    const adapter = new InMemoryFakeAdapter({
      script: [
        {
          finalText: "done",
          usage: { input_tokens: 10, output_tokens: 5, cached_input_tokens: 0 },
          cost: 100,
          events: [
            { kind: "turn-started" },
            {
              kind: "turn-completed",
              usage: { input_tokens: 10, output_tokens: 5, cached_input_tokens: 0 },
              cost: 100,
            },
          ],
        },
      ],
    });
    const session = await createAgent({
      role: "implementer",
      phase: "implement",
      runId: "r",
      ticketId: "T-1",
      profileId: "p",
      eventSink: sink,
      config,
      adapter,
    });
    await session.run("go");
    expect(events).toHaveLength(1);
    if (events[0]?.kind === "AgentInvoked") {
      expect(events[0].role).toBe("implementer");
      expect(events[0].phase).toBe("implement");
      expect(events[0].cost).toBe(100);
    }
  });
});
