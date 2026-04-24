## Context

Two upstream SDKs need to plug in behind a single surface: `@openai/codex-sdk` (a thin wrapper around the `codex` CLI, streaming JSONL events) and — later — Claude Agent SDK. Both model a multi-turn thread with tool use, reasoning, and usage reporting, but with very different event vocabularies. The `phase-contracts` capability already defines `AgentInvoked` (role, provider, model, cost micro-USD, tokens, latencyMs) and the generic `EventSink`; this change is the glue between providers and those contracts.

The `@openai/codex-sdk` v0.124 shape (relevant bits):
- `new Codex(options).startThread(options)` → `Thread`
- `thread.run(input, {outputSchema?, signal?})` → `{items, finalResponse, usage}` where `usage = {input_tokens, cached_input_tokens, output_tokens}` or `null`
- `thread.runStreamed(input, ...)` → `{events: AsyncGenerator<ThreadEvent>}` with events: `thread.started`, `turn.started`, `turn.completed`, `turn.failed`, `item.started|updated|completed`, `error`
- Thread items: `agent_message`, `reasoning`, `command_execution`, `file_change`, `mcp_tool_call`, `web_search`, `todo_list`, `error`
- No cost reported; we compute from `usage` + a per-model pricing table

## Goals / Non-Goals

**Goals:**
- One interface that covers current (Codex) and likely future providers (Claude Agent) without bending to either
- Deterministic testability: phase logic can be unit-tested with `InMemoryFakeAdapter` alone
- Automatic emission of `AgentInvoked` observability events — phase code never has to remember to log
- Cost in integer micro-USD per the `phase-contracts` rules; no floats, no `bigint`
- A single place to configure role→model and load it from `night-shift.config.ts`
- Minimal coupling: `src/adapters/` depends only on `src/contracts/` and provider SDKs

**Non-Goals:**
- Claude Agent adapter (interface must accommodate it, but implementation is deferred)
- Tool registration API for custom MCP tools (stubbed; no M1 phase needs it)
- Prompt templating / rendering engine (system prompts are plain text files read from disk)
- Thread resumption / persistence across process restarts (Codex supports it; we defer exposing it until the orchestrator needs it)
- Rate limiting, retry/backoff, circuit breakers (belongs in orchestration-runtime)
- Multi-modal input beyond text (no images for M1)
- Streaming output to end users (events go to `EventSink`, not a UI)

## Decisions

### D1. Session-based interface, not single-shot

```ts
interface AgentAdapter {
  readonly provider: string;       // "codex", "claude-agent", ...
  openSession(opts: OpenSessionOptions): AgentSession;
}

interface OpenSessionOptions {
  role: AgentRole;                 // "specifier" | "implementer" | "reviewer" | "subagent"
  model: string;
  systemPrompt?: string;
  workingDirectory?: string;
  runId: string;                   // for observability correlation
  ticketId: string;
  profileId: string;
  providerOptions?: unknown;       // escape hatch, typed per provider
}

interface AgentSession {
  readonly id: string | null;       // populated after first turn
  run(input: AgentInput, opts?: TurnOpts): Promise<TurnResult>;
  runStreamed(input: AgentInput, opts?: TurnOpts): AsyncIterable<AgentStreamEvent>;
  close?(): Promise<void>;
}
```

Rationale: multi-turn sessions are the minimum primitive that all phases need (implementer runs a long session, reviewer may make follow-up asks). Single-shot would force re-creating context every turn.

Alternatives considered:
- Single-shot + internal state → hides turn boundaries, makes cost attribution fuzzy.
- Generator-only (no `run`) → forces phase code to consume streams even for one-shot tasks.

### D2. Normalised streamed event shape

```ts
type AgentStreamEvent =
  | { kind: "session-started"; sessionId: string }
  | { kind: "turn-started" }
  | { kind: "text-delta"; text: string; messageId: string }
  | { kind: "message-completed"; messageId: string; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "tool-use"; toolCallId: string; tool: string; input: unknown; source: ToolSource }
  | { kind: "tool-result"; toolCallId: string; status: "completed" | "failed"; output: unknown }
  | { kind: "turn-completed"; usage: TokenUsage; cost: number /* micro-USD */ }
  | { kind: "turn-failed"; error: { message: string } }
  | { kind: "warning"; message: string };

type ToolSource =
  | { kind: "shell" }
  | { kind: "file-change" }
  | { kind: "web-search" }
  | { kind: "mcp"; server: string }
  | { kind: "todo" }
  | { kind: "other"; name: string };
```

Why translate instead of passing provider events through:
- Phase code stays portable across providers (the whole point of this change)
- Keeps the test fake tractable — it emits a small fixed vocabulary
- We can still expose the raw event in a `rawProviderEvent?: unknown` field on any item for debugging; opt-in, never required

Mapping from Codex `ThreadEvent` to `AgentStreamEvent`:

| Codex event                                  | Our event                                     |
|----------------------------------------------|-----------------------------------------------|
| `thread.started`                             | `session-started` (carries `thread_id`)       |
| `turn.started`                               | `turn-started`                                |
| `turn.completed`                             | `turn-completed` (derive cost from usage)     |
| `turn.failed`                                | `turn-failed`                                 |
| `item.started` + type `agent_message`        | (buffered; first seen id emits nothing)       |
| `item.updated` + type `agent_message`        | `text-delta` (diff against previous text)     |
| `item.completed` + type `agent_message`      | `message-completed`                           |
| `item.*` + type `reasoning`                  | `reasoning` (emit once on complete)           |
| `item.*` + type `command_execution`          | `tool-use` + `tool-result` (source: shell)    |
| `item.*` + type `file_change`                | `tool-use` + `tool-result` (source: file-change) |
| `item.*` + type `mcp_tool_call`              | `tool-use` + `tool-result` (source: mcp)      |
| `item.*` + type `web_search`                 | `tool-use` + `tool-result` (source: web-search) |
| `item.*` + type `todo_list`                  | `tool-use` (source: todo; `output: items`)    |
| `item.*` + type `error`                      | `warning`                                     |
| `error`                                      | `turn-failed`                                 |

### D3. Subagents are plain sessions

Any phase needing a subagent calls `adapter.openSession({role: "subagent", ...})`. No first-class `spawnSubagent` method. Rationale: portability (Claude supports first-class subagents; Codex does not — we'd end up with the lowest common denominator anyway), simplicity, and the `AgentInvoked` event with `role: "subagent"` already distinguishes them in observability. Cost of the subagent naturally appears as a separate event.

### D4. Cost derivation via pricing table

Codex SDK does not report cost. We derive it:

```ts
interface ModelPricing {
  inputPer1M:  number;   // USD
  output1M:    number;   // USD
  cachedInputPer1M?: number; // USD (if provider reports cached input tokens)
}
const PRICING: Record<string, ModelPricing>;
function computeCost(model: string, usage: TokenUsage): number /* integer micro-USD */;
```

- If the model is not in the table: emit a `warning` event and record `cost: 0` (never fail a turn on unknown pricing).
- Callers can pass `pricingOverrides` to the adapter constructor to extend the table.
- `gpt-5.4` pricing will be set from the Codex pricing page at implementation time; initial placeholder values live in a constant with a `// TODO verify` comment. Tests use the fake adapter, so accuracy is not load-bearing for CI.

### D5. Config loader

`night-shift.config.ts` at repo root is a TypeScript module with a default export of type `NightShiftConfig`:

```ts
interface NightShiftConfig {
  roles: Record<AgentRole, AgentRoleConfig>;
  qualityGates?: QualityGateConfig[];   // used by implement-phase, declared for forward-compat
  adapters?: {
    codex?: { codexPathOverride?: string; baseUrl?: string; pricingOverrides?: Record<string, ModelPricing> };
  };
}

interface AgentRoleConfig {
  provider: "codex" | "claude-agent";
  model: string;
  systemPromptFile?: string;         // absolute or repo-relative path to plain-text prompt
  providerOptions?: unknown;         // provider-specific escape hatch
}
```

Loader mechanics:
- Resolve path: explicit arg > env var `NIGHT_SHIFT_CONFIG` > repo root `night-shift.config.ts`
- Import with `await import(pathToFileURL(resolved).href)` to honour ESM semantics
- Validate default export with `NightShiftConfigSchema.parse(...)` (Zod)
- Merge with `DEFAULT_CONFIG` (all roles → `{provider: "codex", model: "gpt-5.4"}`) so missing roles don't crash
- Secrets are NOT loaded here; `.env` is the secrets surface and the adapter reads `process.env` directly for `OPENAI_API_KEY` / `CODEX_*`

### D6. Automatic `AgentInvoked` emission via a wrapper

Raw `CodexAdapter` returns raw sessions. A thin `instrumentedSession(session, sink, meta)` wrapper intercepts `run`/`runStreamed` to:
1. Record `startedAt`
2. Forward the call
3. On `turn-completed`/promise-resolve: emit `AgentInvoked` with aggregated tokens, computed cost, `latencyMs = now - startedAt`
4. On `turn-failed`/promise-reject: still emit `AgentInvoked` with whatever tokens were reported (possibly zero)

Phase code uses `createAgent({role, eventSink, config, pricingOverrides?})` which returns an already-instrumented session. Rationale: phases never have a chance to forget to emit.

### D7. Fake adapter ships with the package

`InMemoryFakeAdapter` accepts a scripted list of turn results (`{events, finalResponse, usage}`) and deterministic per-model pricing. Every phase's unit tests use it. Rationale: without a fake shipped here, every downstream change would rewrite one.

### D8. Module boundary

- `src/adapters/index.ts` exports the interface, role type, `createAgent`, `computeCost`, and `InMemoryFakeAdapter`.
- `src/adapters/codex.ts` exports `CodexAdapter`. Imports `@openai/codex-sdk` and `src/contracts/*` only.
- `src/config/` exports `loadConfig`, `NightShiftConfigSchema`, `DEFAULT_CONFIG`. Imports `node:fs`, `node:path`, `node:url`, `zod`, and `src/contracts/*`.
- The contracts-import guardrail (from change 1) remains unchanged and continues to forbid `src/contracts/**` from reaching into these new modules.

## Risks / Trade-offs

- **Risk:** `gpt-5.4` pricing values drift from upstream.
  **Mitigation:** pricing lives in one constant with a comment pointing at the source; `pricingOverrides` in config lets users patch it without a release; unknown models produce a warning not a failure.

- **Risk:** Codex SDK event translation drops information phases care about (e.g., raw reasoning tokens).
  **Mitigation:** `AgentStreamEvent.rawProviderEvent?: unknown` escape hatch on every normalised event; phases can opt in for debugging.

- **Risk:** `workspace-write` sandbox + `approvalPolicy: "never"` is a footgun if the session's `workingDirectory` is wrong.
  **Mitigation:** `openSession` throws if `workingDirectory` resolves outside the configured workspace root; documented in spec. Default is the session-passed path, and `implement-phase` will pass the ticket's worktree explicitly.

- **Risk:** Config loader can't find `night-shift.config.ts` in a repo that uses `.mts` or a different location.
  **Mitigation:** try `.ts`, `.mts`, `.mjs`, `.js` in order; honour `NIGHT_SHIFT_CONFIG` env var; loader returns `DEFAULT_CONFIG` if no file found (phases still work dogfood-style).

- **Trade-off:** Introducing `InMemoryFakeAdapter` alongside the real one means two implementations to maintain. Acceptable — every downstream test depends on it and rebuilding it per package would waste more effort.

- **Trade-off:** Normalised event shape is less expressive than raw provider events. Mitigated by the escape hatch; vast majority of phase logic operates on text + tool-use.

## Migration Plan

N/A — greenfield. Tasks add new files; nothing existing needs updating.

## Open Questions

- **Claude Agent adapter timing:** postpone to a dedicated change once a phase actually needs Claude, or stub it now? **Proposed:** stub the directory (`src/adapters/claude-agent.ts`) with a `TODO: implement in future change` and a `throw new Error("not implemented")` factory, so the config schema can already reference `"claude-agent"` without crashing. Revisit in M2/M3.
- **Streaming back-pressure:** Codex SDK's `AsyncGenerator` has natural back-pressure; our adapter preserves it. But if a phase wants to fan events to multiple consumers we'd need a tee. **Proposed:** not for M1; single-consumer streams only.
- **Per-turn output schema:** Codex supports `outputSchema` to force JSON responses. Expose via `TurnOpts.outputSchema?: z.ZodType`? **Proposed:** yes, as a convenience — pass the Zod schema's `.jsonSchema()` through; resolve during implementation.
