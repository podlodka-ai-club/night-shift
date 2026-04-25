import type { AgentStreamEvent } from "../adapters/events.js";

const MAX_BUFFER = 10;
const DEFAULT_MIN_INTERVAL_MS = 2000;
const MAX_TEXT_LEN = 60;

const IMMEDIATE_KINDS = new Set(["tool-use", "turn-completed", "turn-failed"]);

interface BufferEntry {
  text: string;
  toolCallId?: string;
}

export class ActivityProgressReporter {
  private readonly signalFn: (md: string) => Promise<void>;
  private readonly phaseName: string;
  private readonly minIntervalMs: number;
  private buffer: BufferEntry[] = [];
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
    const now = this._now();
    switch (event.kind) {
      case "tool-use": {
        this.toolTimestamps.set(event.toolCallId, now);
        this.appendEntry(`⚡ ${event.source.kind} \`${event.tool}\``, event.toolCallId);
        break;
      }
      case "tool-result": {
        const startTs = this.toolTimestamps.get(event.toolCallId);
        this.toolTimestamps.delete(event.toolCallId);
        const icon = event.status === "completed" ? "✅" : "❌";
        const suffix = startTs != null
          ? ` → ${icon} (${((now - startTs) / 1000).toFixed(1)}s)`
          : `→ ${icon}`;
        const lineIndex = this.findToolLineIndex(event.toolCallId);
        if (lineIndex >= 0) {
          this.buffer[lineIndex]!.text += suffix;
        } else {
          this.appendEntry(suffix.trimStart());
        }
        break;
      }
      case "message-completed": {
        const text = event.text.length > MAX_TEXT_LEN
          ? `${event.text.slice(0, MAX_TEXT_LEN)}...`
          : event.text;
        this.appendEntry(`💬 "${text}"`);
        break;
      }
      case "turn-completed": {
        this.turnCount += 1;
        const totalTokens = event.usage.input_tokens + event.usage.output_tokens;
        const formattedTokens = totalTokens.toLocaleString("en-US");
        const usd = (event.cost / 1_000_000).toFixed(2);
        this.appendEntry(`📊 Turn ${this.turnCount} — ${formattedTokens} tokens ($${usd})`);
        break;
      }
      case "turn-failed":
        this.appendEntry(`❌ Turn failed: ${event.error.message}`);
        break;
      default:
        return;
    }

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
    const payload = `${header}\n\n${this.buffer.map((entry) => entry.text).join("\n")}`;
    await this.signalFn(payload);
  }

  private appendEntry(text: string, toolCallId?: string): void {
    this.buffer.push({ text, ...(toolCallId ? { toolCallId } : {}) });
    while (this.buffer.length > MAX_BUFFER) {
      const removed = this.buffer.shift();
      if (removed?.toolCallId) {
        this.toolTimestamps.delete(removed.toolCallId);
      }
    }
  }

  private findToolLineIndex(toolCallId: string): number {
    for (let i = this.buffer.length - 1; i >= 0; i--) {
      if (this.buffer[i]!.toolCallId === toolCallId) {
        return i;
      }
    }
    return -1;
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
