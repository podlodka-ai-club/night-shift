## Why

Every M1 phase (Specify / Implement / Review, plus implement's spec-review subagent) drives an LLM through a multi-turn session with tool use. Two provider SDKs are in scope from day one — Codex and Claude Agent — and more will follow (M3 extensibility). Without a shared adapter surface:

- Each phase ends up coupled to a specific provider SDK, making model swaps expensive
- Cost, token, and latency metrics are collected inconsistently (if at all), breaking M4 experiment comparisons
- Testing phases requires hitting real LLMs; there's no deterministic substitute
- Per-role model selection ("specifier uses GPT-5.4", "reviewer could use something cheaper") has no single place to live

This change defines a session-based adapter interface, implements it for Codex, loads role→model configuration from `night-shift.config.ts`, and emits every adapter call as an `AgentInvoked` observability event defined in `phase-contracts`.

## What Changes

- Introduce an **`AgentAdapter` interface**: provider-agnostic factory that opens `AgentSession` instances.
- Introduce an **`AgentSession` interface** with two modes — blocking `run(input)` returning a completed turn, and `runStreamed(input)` yielding a **normalised** event stream (`text-delta`, `tool-use`, `tool-result`, `reasoning`, `turn-complete`, `turn-failed`). Adapters translate provider-specific events into this shape.
- Subagents are modelled as **plain new sessions**, not a first-class primitive. Any phase that needs a subagent calls `adapter.openSession({role: "subagent", ...})`.
- Introduce an **`AgentRole`** type: `"specifier" | "implementer" | "reviewer" | "subagent"` (extensible in M3).
- Introduce **`AgentRoleConfig`**: `{ provider, model, systemPromptFile?, providerOptions? }`, plus a top-level `NightShiftConfig` with a `roles` map.
- Implement a **`CodexAdapter`** wrapping `@openai/codex-sdk` (`Codex → Thread → Turn/StreamedTurn`). Defaults to `sandboxMode: "workspace-write"` and `approvalPolicy: "never"` (no tool restrictions; autonomous). Converts Codex `Usage` + a pricing table to integer micro-USD `cost`.
- Implement a **`InMemoryFakeAdapter`** for tests: scripted responses, deterministic cost/tokens, supports the same interface. Ships with the contracts package to avoid every consumer re-implementing one.
- Implement a **config loader** (`loadConfig(path?)`) that finds and imports `night-shift.config.ts`, validates against a Zod schema, and merges with built-in defaults.
- Wire every `adapter.openSession(...).run(...)` / `runStreamed(...)` call to emit an `AgentInvoked` event through the injected `EventSink` with `role`, `provider`, `model`, `cost`, `tokens`, `latencyMs`.
- Add a **pricing table** (model → cost per 1M input/output tokens) with override points for custom deployments.

## Capabilities

### New Capabilities
- `agent-adapter`: provider-agnostic session-based agent adapter interface, Codex implementation, in-memory fake for tests, role→model configuration, pricing/cost derivation, and automatic `AgentInvoked` observability emission.

### Modified Capabilities
<!-- None -->

## Impact

- **New deps:** `@openai/codex-sdk`. No Anthropic SDK yet (deferred until a Claude adapter is genuinely needed; interface is provider-agnostic so adding one later is additive).
- **New modules:** `src/adapters/` (interface, Codex impl, fake, pricing), `src/config/` (config schema + loader).
- **No runtime changes** to `src/contracts/`; this module consumes `AgentInvoked` and `EventSink` from there.
- **Dogfooding constraint:** Codex adapter assumes the `codex` CLI is installed in PATH (the Codex SDK shells out to it). Documented in README.
- **Security:** by default, sessions run with `sandboxMode: "workspace-write"` — file writes and shell within the session's cwd are permitted, network gated by `networkAccessEnabled` (default `true` for agent freedom). Documented; exposed as session option for callers who want to tighten.
- **No GitHub, Temporal, or phase logic** introduced here.
