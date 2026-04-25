import type { AgentStreamEvent } from "../adapters/events.js";

const MAX_BUFFER = 10;
const DEFAULT_MIN_INTERVAL_MS = 2000;
const MAX_TEXT_LEN = 60;

const IMMEDIATE_KINDS = new Set(["tool-use", "turn-completed", "turn-failed"]);

export class ActivityProgressReporter {
  private readonly signalFn: (md: string) => Promise<void>;
  private readonly phaseName: string;
  private readonly minIntervalMs: number;
  private buffer: string[] = [];
  private turnCount = 0;
  private lastSignalAt = 0;
  private toolTimestamps = new Map<string, number>();

  constructor(opts: {
    signalFn: (md: string) => Promise<void>;
    phaseName: string;
    minIntervalMs?: number;
    now?: () => number;
  }) {
    this.signalFn = opts.signalFn;
    this.phaseName = opts.phaseName;
    this.minIntervalMs = opts.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    this._now = opts.now ?? Date.now;
  }

  private _now: () => number;

  async push(event: AgentStreamEvent): Promise<void> {
    const line = this.format(event);
    if (line == null) return;

    this.buffer.push(line);
    if (this.buffer.length > MAX_BUFFER) {
      this.buffer = this.buffer.slice(-MAX_BUFFER);
    }

    const now = this._now();
    const elapsed = now - this.lastSignalAt;
    if (elapsed >= this.minIntervalMs && IMMEDIATE_KINDS.has(event.kind)) {
      await this.send(now);
    }
  }

  async flush(): Promise<void> {
    if (this.buffer.length > 0) {
      await this.send(this._now());
    }
  }

  private async send(now: number): Promise<void> {
    this.lastSignalAt = now;
    const header = `### 🤖 ${capitalize(this.phaseName)} — running`;
    const payload = `${header}\n\n${this.buffer.join("\n")}`;
    await this.signalFn(payload);
  }

  private format(event: AgentStreamEvent): string | null {
    switch (event.kind) {
      case "tool-use": {
        this.toolTimestamps.set(event.toolCallId, this._now());
        return `⚡ ${event.source.kind} \`${event.tool}\``;
      }
      case "tool-result": {
        const startTs = this.toolTimestamps.get(event.toolCallId);
        this.toolTimestamps.delete(event.toolCallId);
        const icon = event.status === "completed" ? "✅" : "❌";
        if (startTs != null) {
          const dur = ((this._now() - startTs) / 1000).toFixed(1);
          // Append to the last tool-use line if it matches
          const lastIdx = this.findLastToolUseLine(event.toolCallId);
          if (lastIdx >= 0) {
            this.buffer[lastIdx] += ` → ${icon} (${dur}s)`;
            return null; // Already appended
          }
          return `→ ${icon} (${dur}s)`;
        }
        return `→ ${icon}`;
      }
      case "message-completed": {
        const text = event.text.length > MAX_TEXT_LEN
          ? `${event.text.slice(0, MAX_TEXT_LEN)}...`
          : event.text;
        return `💬 "${text}"`;
      }
      case "turn-completed": {
        this.turnCount++;
        const totalTokens = event.usage.input_tokens + event.usage.output_tokens;
        const formattedTokens = totalTokens.toLocaleString("en-US");
        const usd = (event.cost / 1_000_000).toFixed(2);
        return `📊 Turn ${this.turnCount} — ${formattedTokens} tokens ($${usd})`;
      }
      case "turn-failed":
        return `❌ Turn failed: ${event.error.message}`;
      default:
        return null;
    }
  }

  private findLastToolUseLine(_toolCallId: string): number {
    // Find the last line that starts with ⚡ and doesn't have a result appended yet
    for (let i = this.buffer.length - 1; i >= 0; i--) {
      if (this.buffer[i]!.startsWith("⚡") && !this.buffer[i]!.includes("→")) {
        return i;
      }
    }
    return -1;
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
