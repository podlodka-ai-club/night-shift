# `src/adapters/`

Normalised interface over agent SDKs. Phases and other callers never talk to
a provider SDK directly — they call `createAgent(...)` and get back an
instrumented `AgentSession` that emits observability events automatically.

## Interface

```ts
interface AgentAdapter {
  provider: string;
  openSession(opts: OpenSessionOptions): AgentSession;
}

interface AgentSession {
  id: string | null;
  run(input: AgentInput, opts?: TurnOpts): Promise<TurnResult>;
  runStreamed(input: AgentInput, opts?: TurnOpts): AsyncGenerator<AgentStreamEvent>;
  close?(): Promise<void>;
}
```

`AgentStreamEvent` is a discriminated union covering the full normalised
vocabulary (`session-started`, `turn-started`, `text-delta`,
`message-completed`, `reasoning`, `tool-use`, `tool-result`,
`turn-completed`, `turn-failed`, `warning`). Every variant carries an optional
`rawProviderEvent` field so downstream code can reach for provider-specific
data when needed — but we strive never to need it.

## Provided adapters

| Adapter               | Provider        | Notes                                        |
| --------------------- | --------------- | -------------------------------------------- |
| `CodexAdapter`        | `codex`         | Shells out to the Codex CLI via the SDK      |
| `ClaudeAgentAdapter`  | `claude-agent`  | M1 stub — throws on `openSession`            |
| `InMemoryFakeAdapter` | `fake`          | Deterministic scripted sessions for tests    |

## Auto-emission contract (`instrumentSession`)

The factory wraps every session so that **exactly one** `AgentInvoked` event
is emitted per call to `run` or `runStreamed`, even when the consumer breaks
out of the stream early or the call throws. This is enforced by a
`try { ... } finally { emit(...) }` around the async generator.

## Writing a new adapter

1. Implement `AgentAdapter` and `AgentSession` in a new file under `src/adapters/`.
2. Validate `OpenSessionOptions` with `OpenSessionOptionsSchema.parse(opts)` at the top of `openSession`.
3. Translate provider events into `AgentStreamEvent` values and `AgentStreamEventSchema.parse` them before yielding to catch bugs.
4. Compute cost via `computeCost(model, usage, pricingOverrides)`.
5. Register the new provider in the `buildAdapter` switch in `index.ts`.
6. Add unit tests using a handcrafted mock of the SDK (see `codex.test.ts`).

## Module boundary

`src/adapters/**` may import from `src/contracts/**`, `@openai/codex-sdk`,
`zod`, `node:fs/promises`, `node:path`, and its own siblings. It MUST NOT
import from `src/config/**` at runtime (type-only imports are allowed). The
`npm run lint:boundaries` script enforces this.
