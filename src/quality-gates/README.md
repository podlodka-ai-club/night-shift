# Quality-gates module

Runs a single quality gate (typecheck, lint, tests, etc.) in a given
working directory and reports a structured result.

## `QualityGateRunner`

```ts
interface QualityGateRunner {
  run(gate: QualityGate, opts: { cwd: string }): Promise<QualityGateResult>;
}
```

Gates are declared as `{ name, command: [...argv], cwd?, timeoutMs?, optional? }`.

## Policy

- **Timeout**: per-gate `timeoutMs` overrides the runner default (10 minutes).
  On timeout the child is `SIGKILL`-ed and the result is `failed`.
- **Log truncation**: `logsTail` is at most 4 KiB (the trailing bytes of
  combined stdout+stderr). The contract schema enforces the same cap on
  consumers.
- **Optional gates**: when `optional: true`, a non-zero exit maps to
  `skipped` instead of `failed`.

## Implementations

- `createNodeQualityGateRunner({ defaultTimeoutMs? })` — spawns a real
  process via `node:child_process.spawn`.
- `createInMemoryFakeQualityGateRunner()` — scripted per-gate results;
  records every invocation on `events`.
