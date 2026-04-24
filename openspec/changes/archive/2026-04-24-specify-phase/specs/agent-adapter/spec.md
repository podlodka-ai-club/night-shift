## MODIFIED Requirements

### Requirement: AgentSession run and runStreamed

Every `AgentSession` SHALL expose two methods:
- `run(input, opts?): Promise<TurnResult>` — returns after the turn fully completes.
- `runStreamed(input, opts?): AsyncIterable<AgentStreamEvent>` — yields normalised events as they arrive.

`TurnResult` SHALL include `finalText: string`, `items: AgentThreadItem[]`, `usage: TokenUsage`, `cost: number` (integer micro-USD), `latencyMs: number`.

`TurnOpts` SHALL accept an optional `outputSchema: unknown` field carrying a JSON Schema that the provider MUST honor as a structured-response constraint when supported. Adapters SHALL forward `outputSchema` verbatim to the underlying provider. When a provider does not support structured output, the adapter SHALL pass the request through unchanged (letting the caller post-validate `finalText`). `TurnOpts` SHALL also accept an optional `signal: AbortSignal` for cancellation.

#### Scenario: run returns a completed turn
- **WHEN** `session.run("hello")` is awaited on the fake adapter scripted to reply `"hi"`
- **THEN** the resolved value has `finalText: "hi"`, non-negative `usage`, non-negative `cost`, and `latencyMs >= 0`

#### Scenario: runStreamed yields normalised events ending with turn-completed
- **WHEN** `session.runStreamed("hello")` is iterated on the fake adapter
- **THEN** the last event has `kind: "turn-completed"` and earlier events are drawn only from the documented normalised event vocabulary

#### Scenario: outputSchema is forwarded to a supporting provider
- **GIVEN** a session opened on the Codex adapter
- **WHEN** `session.run(input, { outputSchema: schema })` is called
- **THEN** the underlying provider turn receives the same `outputSchema` value
