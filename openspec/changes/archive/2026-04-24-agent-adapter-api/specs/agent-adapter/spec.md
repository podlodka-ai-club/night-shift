## ADDED Requirements

### Requirement: AgentAdapter interface

The system SHALL define an `AgentAdapter` interface with a `provider: string` property and an `openSession(options): AgentSession` method. Adapters SHALL NOT perform I/O in their constructor; side-effects are deferred to `openSession` / `run` / `runStreamed`.

#### Scenario: Adapter exposes its provider name
- **WHEN** a concrete adapter (e.g. `CodexAdapter`) is instantiated
- **THEN** its `provider` property returns the provider identifier (e.g. `"codex"`)

#### Scenario: Adapter constructor performs no I/O
- **WHEN** an adapter is constructed in an environment with no network, no subprocess access, and no API credentials
- **THEN** the constructor returns successfully

### Requirement: OpenSessionOptions carry observability context

The system SHALL require every call to `openSession` to include `role: AgentRole`, `model: string`, `runId: string`, `ticketId: string`, `profileId: string`. Optional fields: `systemPrompt`, `workingDirectory`, `providerOptions`. These values SHALL be used when the session emits `AgentInvoked` events.

#### Scenario: Missing required observability fields rejected
- **WHEN** `openSession` is called without `ticketId`, `runId`, or `profileId`
- **THEN** the schema validator throws before any provider call is made

#### Scenario: Role is constrained
- **WHEN** `openSession` is called with `role: "unknown"`
- **THEN** validation fails (role must be `"specifier" | "implementer" | "reviewer" | "subagent"`)

### Requirement: AgentSession run and runStreamed

Every `AgentSession` SHALL expose two methods:
- `run(input, opts?): Promise<TurnResult>` — returns after the turn fully completes.
- `runStreamed(input, opts?): AsyncIterable<AgentStreamEvent>` — yields normalised events as they arrive.

`TurnResult` SHALL include `finalText: string`, `items: AgentThreadItem[]`, `usage: TokenUsage`, `cost: number` (integer micro-USD), `latencyMs: number`.

#### Scenario: run returns a completed turn
- **WHEN** `session.run("hello")` is awaited on the fake adapter scripted to reply `"hi"`
- **THEN** the resolved value has `finalText: "hi"`, non-negative `usage`, non-negative `cost`, and `latencyMs >= 0`

#### Scenario: runStreamed yields normalised events ending with turn-completed
- **WHEN** `session.runStreamed("hello")` is iterated on the fake adapter
- **THEN** the last event has `kind: "turn-completed"` and earlier events are drawn only from the documented normalised event vocabulary

### Requirement: Normalised AgentStreamEvent vocabulary

The system SHALL define `AgentStreamEvent` as a discriminated union on `kind` with at least these variants: `session-started`, `turn-started`, `text-delta`, `message-completed`, `reasoning`, `tool-use`, `tool-result`, `turn-completed`, `turn-failed`, `warning`. Each `tool-use` / `tool-result` pair SHALL share a `toolCallId`. Each `tool-use` SHALL carry a `source: ToolSource` discriminated union (`shell` | `file-change` | `web-search` | `mcp` | `todo` | `other`). Every event MAY carry an optional `rawProviderEvent?: unknown` escape hatch.

#### Scenario: All documented variants parse
- **WHEN** one example of each variant is validated by the Zod schema
- **THEN** parsing succeeds and `kind` narrows correctly

#### Scenario: Unknown kind is rejected
- **WHEN** an event with `kind: "mystery"` is parsed
- **THEN** parsing fails

#### Scenario: tool-use and tool-result can be correlated
- **WHEN** a `tool-use` event with `toolCallId: "c1"` is followed by a `tool-result` with `toolCallId: "c1"`
- **THEN** both parse and share the same id

### Requirement: Codex adapter maps events per table

`CodexAdapter` SHALL implement `AgentAdapter` by wrapping `@openai/codex-sdk`. It SHALL translate Codex `ThreadEvent`s into `AgentStreamEvent`s per the mapping documented in the design, preserving token usage and `thread_id`. It SHALL default `sandboxMode` to `"workspace-write"` and `approvalPolicy` to `"never"` unless overridden via `providerOptions`.

#### Scenario: Codex thread.started becomes session-started
- **WHEN** the Codex stream emits `{type: "thread.started", thread_id: "t1"}`
- **THEN** the adapter yields `{kind: "session-started", sessionId: "t1"}`

#### Scenario: Codex command_execution becomes tool-use + tool-result
- **WHEN** the Codex stream emits `item.started` then `item.completed` for a `command_execution` with exit_code 0
- **THEN** the adapter yields one `tool-use` with `source.kind === "shell"` and one `tool-result` with `status: "completed"`, matching `toolCallId`

#### Scenario: Codex turn.completed yields cost derived from usage
- **WHEN** the Codex stream emits `turn.completed` with `usage: {input_tokens: 1000, output_tokens: 500, cached_input_tokens: 0}` and the model pricing table has values for the session's model
- **THEN** the adapter yields `turn-completed` with `usage` forwarded and `cost` equal to `computeCost(model, usage)` in integer micro-USD

#### Scenario: Codex turn.failed yields turn-failed
- **WHEN** the Codex stream emits `{type: "turn.failed", error: {message: "boom"}}`
- **THEN** the adapter yields `{kind: "turn-failed", error: {message: "boom"}}`

### Requirement: Cost computation in micro-USD

The system SHALL provide a pure `computeCost(model, usage): number` helper returning a non-negative integer micro-USD value. If the model is not in the pricing table, `computeCost` SHALL return `0` and the adapter SHALL emit a `warning` event; it SHALL NOT throw. Pricing SHALL be expressible as `{inputPer1M, outputPer1M, cachedInputPer1M?}` USD values and SHALL support override by the caller.

#### Scenario: Known model returns integer micro-USD
- **WHEN** `computeCost("test-model", {input_tokens: 1_000_000, output_tokens: 0, cached_input_tokens: 0})` is called and pricing for `test-model` is `{inputPer1M: 1.50, outputPer1M: 0}`
- **THEN** the result is `1_500_000` (integer)

#### Scenario: Unknown model returns 0
- **WHEN** `computeCost("not-in-table", anyUsage)` is called
- **THEN** the result is `0`

#### Scenario: Cached input tokens priced separately when configured
- **WHEN** pricing has `cachedInputPer1M`, and usage has `cached_input_tokens > 0`
- **THEN** cached tokens use the cached price; uncached tokens use `inputPer1M`

### Requirement: Automatic AgentInvoked emission

The system SHALL provide a factory `createAgent({role, eventSink, config, adapter?, pricingOverrides?})` returning an instrumented session. Every completed call to `run` or `runStreamed` SHALL emit exactly one `AgentInvoked` event to the provided `EventSink` with `role`, `provider`, `model`, `cost`, `tokens`, `latencyMs`, and the context fields (`ticketId`, `runId`, `profileId`, `phase`, `ts`). Failed turns SHALL also emit `AgentInvoked` (best-effort tokens, cost possibly zero).

#### Scenario: Successful run emits one AgentInvoked
- **WHEN** a phase uses `createAgent(...)` and calls `session.run("x")` successfully
- **THEN** the sink received exactly one `AgentInvoked` event matching the run

#### Scenario: runStreamed consumed fully emits exactly one AgentInvoked
- **WHEN** `runStreamed` is iterated to completion
- **THEN** exactly one `AgentInvoked` event is emitted when the generator ends

#### Scenario: runStreamed abandoned mid-stream still emits AgentInvoked
- **WHEN** the consumer breaks out of the for-await loop before turn-completed
- **THEN** exactly one `AgentInvoked` is emitted with the partial usage observed so far

#### Scenario: Failed run emits AgentInvoked
- **WHEN** `session.run(...)` rejects
- **THEN** exactly one `AgentInvoked` event is emitted and the rejection is re-thrown

### Requirement: AgentRole is closed and extensible via schema

The system SHALL define `AgentRole = "specifier" | "implementer" | "reviewer" | "subagent"` as a Zod enum and export it. New roles require a code change (not config change).

#### Scenario: Listed roles accepted
- **WHEN** each of the 4 roles is parsed
- **THEN** parsing succeeds

#### Scenario: Unknown role rejected
- **WHEN** `"critic"` is parsed
- **THEN** parsing fails

### Requirement: NightShiftConfig schema and loader

The system SHALL define `NightShiftConfigSchema` (Zod) with fields: `roles: Record<AgentRole, AgentRoleConfig>`, optional `qualityGates`, optional `adapters.codex` sub-config. Each `AgentRoleConfig` SHALL have `provider` (enum `"codex" | "claude-agent"`), `model: string`, optional `systemPromptFile: string`, optional `providerOptions: unknown`.

The system SHALL provide `loadConfig(explicitPath?): Promise<NightShiftConfig>` that:
1. Resolves a config file in order: `explicitPath` > `process.env.NIGHT_SHIFT_CONFIG` > repo-root `night-shift.config.ts` (fallback extensions `.mts`, `.mjs`, `.js`)
2. Imports it as an ES module and reads the default export
3. Merges with `DEFAULT_CONFIG` (all roles → `{provider: "codex", model: "gpt-5.4"}`)
4. Validates the merged result via `NightShiftConfigSchema.parse`
5. Returns `DEFAULT_CONFIG` unchanged when no file is found

#### Scenario: No config file yields defaults
- **WHEN** `loadConfig` is called in a repo with no `night-shift.config.*` and no env var
- **THEN** the returned config equals `DEFAULT_CONFIG` and every role has provider `"codex"` and model `"gpt-5.4"`

#### Scenario: Explicit path overrides discovery
- **WHEN** `loadConfig("/tmp/custom-config.ts")` is called
- **THEN** that file is imported and validated

#### Scenario: Partial file merges over defaults
- **WHEN** a config file sets only `roles.reviewer.model = "cheap-model"`
- **THEN** the returned config has `roles.reviewer = {provider: "codex", model: "cheap-model"}` and the other three roles remain on defaults

#### Scenario: Invalid config rejected
- **WHEN** a config sets `roles.specifier.provider = "bogus"`
- **THEN** `loadConfig` rejects with a Zod validation error

### Requirement: Workspace-write sandbox is the default, path is guarded

When `CodexAdapter.openSession` is called, the underlying Codex thread SHALL be configured with `sandboxMode: "workspace-write"` and `approvalPolicy: "never"` unless explicitly overridden via `providerOptions`. If `workingDirectory` is provided, it SHALL be an absolute path; the adapter SHALL throw if the path is not absolute.

#### Scenario: Defaults applied
- **WHEN** `openSession` is called without `providerOptions`
- **THEN** the Codex `startThread` call receives `sandboxMode: "workspace-write"` and `approvalPolicy: "never"`

#### Scenario: Relative workingDirectory rejected
- **WHEN** `openSession({workingDirectory: "./sub", ...})` is called
- **THEN** an error is thrown identifying the non-absolute path

### Requirement: InMemoryFakeAdapter for deterministic testing

The system SHALL ship an `InMemoryFakeAdapter` implementing `AgentAdapter`. It SHALL be constructable with a `script`: an array of scripted turns `{events: AgentStreamEvent[], finalText: string, usage: TokenUsage, cost?: number}`. Consecutive calls to `run`/`runStreamed` on any session from the adapter SHALL consume scripted turns in order. If scripted turns are exhausted, the next call SHALL throw a descriptive error.

#### Scenario: Script drives deterministic output
- **GIVEN** a fake adapter scripted with two turns
- **WHEN** a session calls `run` twice
- **THEN** the two returned `finalText` values equal the scripted ones

#### Scenario: Exhausted script throws
- **WHEN** a third call is made after a 2-turn script is exhausted
- **THEN** the call rejects with an error naming the role and role count

### Requirement: Module boundaries

`src/adapters/**` SHALL import only from `src/contracts/**`, `@openai/codex-sdk`, `zod`, `node:fs/promises`, `node:path`, and its own siblings. `src/config/**` SHALL import only from `src/contracts/**`, `src/adapters/**`, `zod`, `node:fs`, `node:path`, `node:url`, and its own siblings. Neither module SHALL import from each other in a cycle (`src/adapters/` MUST NOT import from `src/config/`).

#### Scenario: Adapter module boundary enforced
- **WHEN** the dependency graph of `src/adapters/**` is inspected
- **THEN** only the allowed imports are present

#### Scenario: Config module boundary enforced
- **WHEN** the dependency graph of `src/config/**` is inspected
- **THEN** only the allowed imports are present; no import from `src/adapters/` going back into `src/config/`
