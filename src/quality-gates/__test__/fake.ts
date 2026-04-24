import type { QualityGate, QualityGateResult, QualityGateRunner } from "../index.js";

export interface FakeQualityGateRunner extends QualityGateRunner {
  /** Scripted response for a given gate name (one-shot per name). */
  script(
    name: string,
    result: Omit<QualityGateResult, "name" | "durationMs"> & { durationMs?: number },
  ): void;
  readonly events: ReadonlyArray<{ gate: QualityGate; cwd: string }>;
}

export function createInMemoryFakeQualityGateRunner(): FakeQualityGateRunner {
  const scripted = new Map<
    string,
    Omit<QualityGateResult, "name" | "durationMs"> & { durationMs?: number }
  >();
  const events: Array<{ gate: QualityGate; cwd: string }> = [];
  return {
    get events() {
      return events;
    },
    script(name, result) {
      scripted.set(name, result);
    },
    async run(gate, opts) {
      events.push({ gate, cwd: opts.cwd });
      const r = scripted.get(gate.name);
      if (!r) {
        return {
          name: gate.name,
          status: "passed",
          exitCode: 0,
          durationMs: 0,
          logsTail: "",
        };
      }
      return {
        name: gate.name,
        status: r.status,
        exitCode: r.exitCode,
        durationMs: r.durationMs ?? 0,
        logsTail: r.logsTail,
      };
    },
  };
}
