import type { AgentAdapter, AgentSession } from "./events.js";

/**
 * Placeholder for the Claude Agent SDK adapter. The interface matches
 * `CodexAdapter` so M2 can wire this up once the upstream SDK
 * (@anthropic-ai/claude-agent-sdk) stabilises. Until then, instantiating or
 * opening a session MUST fail loudly so misconfigured profiles don't
 * silently fall back to a stub.
 */
export class ClaudeAgentAdapter implements AgentAdapter {
  readonly provider = "claude-agent";

  openSession(_opts: unknown): AgentSession {
    throw new Error(
      "ClaudeAgentAdapter is not implemented in M1. Configure a different provider (e.g. 'codex') or wait for M2.",
    );
  }
}
