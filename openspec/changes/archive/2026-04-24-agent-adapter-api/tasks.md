## 1. Setup

- [x] 1.1 Add `@openai/codex-sdk` to dependencies; update `package-lock.json`
- [x] 1.2 Extend `scripts/check-contracts-imports.mjs` (or add a new guardrail script) to enforce module boundaries for `src/adapters/**` and `src/config/**` per spec
- [x] 1.3 Add npm scripts: `lint:boundaries` runs both contract + adapter/config guardrails

## 2. Core types and schemas

- [x] 2.1 Create `src/adapters/types.ts`: define `AgentRoleSchema` / `AgentRole`, `TokenUsageSchema`, `ModelPricingSchema`, `OpenSessionOptionsSchema`
- [x] 2.2 Define `ToolSourceSchema` discriminated union (`shell` | `file-change` | `web-search` | `mcp` | `todo` | `other`)
- [x] 2.3 Define `AgentStreamEventSchema` discriminated union (all 10 variants) with optional `rawProviderEvent`
- [x] 2.4 Define `TurnResultSchema` (`finalText`, `items`, `usage`, `cost`, `latencyMs`)
- [x] 2.5 Define `AgentAdapter` and `AgentSession` interfaces (TS types only; runtime parsing happens at schema boundaries)
- [x] 2.6 Tests: every schema variant parses; unknown kinds rejected; tool-use/tool-result share `toolCallId`

## 3. Pricing and cost

- [x] 3.1 Create `src/adapters/pricing.ts`: `PRICING: Record<string, ModelPricing>` constant with a `gpt-5.4` placeholder entry and a `// TODO verify upstream` note
- [x] 3.2 Implement pure `computeCost(model, usage, overrides?): number` returning integer micro-USD
- [x] 3.3 Support `cachedInputPer1M` when present; fall back to `inputPer1M` for the cached portion when not
- [x] 3.4 Unknown model → return `0` (no throw)
- [x] 3.5 Tests: known model computes correctly; unknown returns 0; cached pricing honoured; integer result; negative usage rejected

## 4. Codex adapter

- [x] 4.1 Create `src/adapters/codex.ts` exporting `CodexAdapter implements AgentAdapter`
- [x] 4.2 Constructor accepts `{codexOptions?, pricingOverrides?}` but does no I/O
- [x] 4.3 `openSession` validates `OpenSessionOptions` with Zod; throws on non-absolute `workingDirectory`
- [x] 4.4 Apply defaults: `sandboxMode: "workspace-write"`, `approvalPolicy: "never"` (overridable via `providerOptions`)
- [x] 4.5 Session's `run` delegates to `Thread.run`; translates `Turn` into `TurnResult` with cost derived from `usage`
- [x] 4.6 Session's `runStreamed` delegates to `Thread.runStreamed`; translates each `ThreadEvent` per the mapping table in design.md
- [x] 4.7 Buffer `agent_message` text; emit `text-delta` on updates and `message-completed` on completion
- [x] 4.8 Map `command_execution`, `file_change`, `mcp_tool_call`, `web_search`, `todo_list` to `tool-use` + `tool-result` with correct `source`
- [x] 4.9 Map `reasoning` item-completed to a single `reasoning` event
- [x] 4.10 Map `item` of type `error` to a `warning`; map top-level `error` event to `turn-failed`
- [x] 4.11 On `turn.completed`, compute `cost` from `usage` and yield `turn-completed`
- [x] 4.12 Unit tests using a hand-crafted mock of `Codex.startThread`/`Thread.runStreamed` to assert event translation for each mapping row

## 5. InMemoryFakeAdapter

- [x] 5.1 Create `src/adapters/fake.ts` exporting `InMemoryFakeAdapter implements AgentAdapter`
- [x] 5.2 Accepts `{script: ScriptedTurn[]}`; `ScriptedTurn = {events, finalText, usage, cost?}`
- [x] 5.3 Sessions consume the shared script in order; exhausted script → throw with role context
- [x] 5.4 `runStreamed` yields scripted events and terminates
- [x] 5.5 `run` derives `TurnResult` from the scripted turn (uses scripted `cost` if present, else `computeCost(model, usage)`)
- [x] 5.6 Tests: scripted turns returned in order; exhausted throws; runStreamed and run produce consistent results

## 6. Instrumented session (auto observability)

- [x] 6.1 Create `src/adapters/instrumented.ts`: `instrumentedSession(session, meta, sink)` returns a proxy session
- [x] 6.2 Wrap `run`: record `t0`, await, emit `AgentInvoked` with cost/tokens/latencyMs, re-throw on error after emitting
- [x] 6.3 Wrap `runStreamed`: tee events to caller; track latest `usage`/`cost`; on generator end (complete OR early-return via for-await break) emit `AgentInvoked` once
- [x] 6.4 Use `try/finally` inside an async-generator wrapper to guarantee the emit even on consumer break
- [x] 6.5 Tests using `InMemoryFakeAdapter` + a fake `EventSink`:
  - [x] 6.5.1 successful `run` emits exactly one `AgentInvoked`
  - [x] 6.5.2 fully-consumed `runStreamed` emits exactly one `AgentInvoked`
  - [x] 6.5.3 abandoned `runStreamed` (break after 2 events) emits exactly one `AgentInvoked`
  - [x] 6.5.4 rejected `run` emits one `AgentInvoked` and re-throws

## 7. Public factory

- [x] 7.1 Create `src/adapters/index.ts` with `createAgent({role, eventSink, config, adapter?, pricingOverrides?}): AgentSession`
- [x] 7.2 Resolve provider from `config.roles[role].provider`; instantiate adapter lazily (default map: `"codex"` → `CodexAdapter`, `"claude-agent"` → stub throwing `not implemented`)
- [x] 7.3 Read system prompt from `config.roles[role].systemPromptFile` (if set) and pass to `openSession.systemPrompt`
- [x] 7.4 Return `instrumentedSession(...)` with provider/model/role metadata baked in
- [x] 7.5 Tests: factory constructs a session; integrates with fake adapter via `adapter` override; end-to-end emits `AgentInvoked` through a test sink

## 8. Config loader

- [x] 8.1 Create `src/config/schema.ts`: `NightShiftConfigSchema`, `AgentRoleConfigSchema`, `DEFAULT_CONFIG`
- [x] 8.2 Create `src/config/loader.ts`: `loadConfig(explicitPath?)`
  - [x] 8.2.1 Path resolution: explicit > env `NIGHT_SHIFT_CONFIG` > repo-root `night-shift.config.{ts,mts,mjs,js}`
  - [x] 8.2.2 Import via `await import(pathToFileURL(resolved).href)`; read `default` export
  - [x] 8.2.3 Deep-merge with `DEFAULT_CONFIG` so partial user configs work
  - [x] 8.2.4 Parse merged object with `NightShiftConfigSchema`
  - [x] 8.2.5 When no file exists anywhere, return `DEFAULT_CONFIG` unchanged
- [x] 8.3 Tests:
  - [x] 8.3.1 no file → defaults
  - [x] 8.3.2 explicit path honoured (use a tmp file)
  - [x] 8.3.3 partial config merges
  - [x] 8.3.4 invalid `provider` value rejected
  - [x] 8.3.5 env var honoured when explicit path not provided

## 9. Claude Agent stub

- [x] 9.1 Create `src/adapters/claude-agent.ts` exporting `ClaudeAgentAdapter` that throws `new Error("ClaudeAgentAdapter is not implemented in M1")` from `openSession`
- [x] 9.2 Comment pointing to the future change that will implement it
- [x] 9.3 Test: throws on `openSession`

## 10. Example config & docs

- [x] 10.1 Add `night-shift.config.example.ts` at repo root with a populated example (all roles → codex + gpt-5.4, a reviewer pointing at a cheaper placeholder model, a `systemPromptFile` example)
- [x] 10.2 Add `src/adapters/README.md` describing the interface, how to write a new adapter, and the auto-emit contract
- [x] 10.3 Add `src/config/README.md` describing discovery order and precedence
- [x] 10.4 Update root `README.md` Modules section to list `src/adapters/` and `src/config/`

## 11. Validation

- [x] 11.1 `npm run typecheck` passes
- [x] 11.2 `npm test` passes (new suites + all prior)
- [x] 11.3 `npm run lint:boundaries` passes (contracts + adapter + config boundaries)
- [x] 11.4 `openspec validate agent-adapter-api --strict` passes
