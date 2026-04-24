## Context

Night Shift's M1 baseline flow is a chain of three phases that must be independent: Specify → Implement → Review. "Independent" means each phase has a single explicit input and a single explicit output, no shared mutable state, no implicit coupling through database rows or filesystems, and no knowledge of which phase runs before or after. Temporal executes these phases as activities/workflows; its activity boundary is JSON serialization, so every contract must survive JSON round-trip.

This change is **types + validators only**. No Temporal workflows, no GitHub calls, no agent invocations. The output is a module the other six M1 changes can import.

## Goals / Non-Goals

**Goals:**
- One canonical `Ticket` shape used everywhere a work item is referenced
- One explicit input and one explicit output contract per phase
- A single observability event shape all phases emit, with enough fields to support M4 experiments without schema change
- Runtime validation at every contract boundary (catch drift before it propagates)
- JSON-serializable contracts (Temporal safety)
- Zero runtime behavior beyond parsing and validation

**Non-Goals:**
- Temporal workflow or activity definitions (orchestration-runtime)
- GitHub API calls, Projects v2 status writes (github-integration)
- Agent adapter interfaces or model selection (agent-adapter-api)
- Any phase business logic
- Persistence: contracts are in-memory + JSON; no database schema
- Versioning scheme for contracts (defer until second breaking change lands)
- i18n / localization of event messages

## Decisions

### D1. Contracts live in `src/contracts/` in the main workspace (single package)

Rationale: M1 is one repo, one TypeScript project. A dedicated npm workspace package adds build/release overhead we don't need. Later (M3, extensibility API) we can extract to `@night-shift/contracts` if third parties need to import.

Alternatives considered:
- Separate `@night-shift/contracts` package from day one → premature, no external consumer yet.
- Inline types in each feature module → creates the drift problem this change exists to prevent.

### D2. Zod as the single source of truth; TypeScript types derived via `z.infer`

Rationale: We need runtime validation at Temporal activity boundaries and at external-input points (webhooks, agent outputs). Having Zod schemas as the source keeps types and validators aligned by construction.

Alternatives considered:
- TypeScript types + hand-written validators → drift risk.
- `io-ts` / `typebox` → Zod is the most common in the TS/Node agent tooling space and integrates cleanly with Temporal's `PayloadConverter` if we add one later.

### D3. `Ticket` is source-agnostic

`Ticket` does not encode "this is a GitHub issue". It carries the minimum fields any source can supply: `id`, `title`, `description`, `status`, `labels`, `url`, plus an opaque `source` discriminator and a `sourceRef` blob. The GitHub-specific fields (project node id, item id, repo owner/name) live on `GitHubSourceRef`. This keeps the `github-integration` change free to evolve without rippling into other phases.

```
Ticket
├── id:          string           (stable, source-agnostic)
├── title:       string
├── description: string
├── status:      TicketStatus     (enum below)
├── labels:      string[]
├── url:         string
├── source:      "github"         (discriminator, extensible)
└── sourceRef:   GitHubSourceRef  (discriminated union by source)
```

### D4. `TicketStatus` is a closed enum with explicit transition table

```
Backlog ──▶ Refinement ──▶ Refined ──▶ Ready ──▶ In progress ──▶ In review ──▶ Ready to merge
                                                                                   │
                                    (human moves Refined → Ready) ◀──────────── (escalate returns In review → Refinement or → Ready)
```

Allowed transitions are exported as a `readonly` table. A helper `canTransition(from, to)` is provided. Enforcing transitions at the orchestration layer (not here) — this module only declares them.

Branch naming is **part of the contract**: `night-shift/<ticket-id>-<slug>` where `slug` is the lowercased title truncated to 50 chars, non-`[a-z0-9]` replaced with `-`, collapsed. A `branchNameFor(ticket)` helper is exported.

### D5. One contract shape per phase boundary

| Phase     | Input                                                          | Output                    |
|-----------|----------------------------------------------------------------|---------------------------|
| Specify   | `SpecifyInput`  = `{ ticket }`                                 | `SpecBundle`              |
| Implement | `ImplementInput` = `{ ticket, specBundle }`                    | `ImplementationResult`    |
| Review    | `ReviewInput`  = `{ ticket, specBundle, pr, iteration }`       | `ReviewResult`            |

Each phase consumes the full ticket so no fan-in from multiple places is required.

`SpecBundle`:
```
{
  specPath:      string      // absolute path inside the repo, e.g. openspec/changes/<ticket-id>/
  branch:        string      // night-shift/<ticket-id>-<slug>
  openQuestions: string[]    // surfaced to human in ticket description
  assumptions:   string[]
  risks:         string[]
  commitSha:     string      // of the specs commit pushed
}
```

`ImplementationResult`:
```
{
  pr:            { number, url, branch, baseBranch, headSha }
  qualityGates:  QualityGateResult[]    // name, status: passed|failed|skipped, durationMs, logs?
  specReview:    { subagentSummary: string, blockingIssues: string[] }  // from per-spec subagent
  summary:       string
}
```

`ReviewResult`:
```
{
  verdict:   "ready-to-merge" | "needs-fix" | "escalate"
  findings:  Finding[]       // { severity: "error" | "warning", message, location?, specRef? }
  iteration: number          // 0-based; reviewer is called at most twice (iterations 0, 1)
  summary:   string
}
```

Only `severity === "error"` findings cause `verdict: "needs-fix"` when `iteration < 2`. Warnings are always posted as PR comments; they never block. If `iteration === 2` and errors remain → `verdict: "escalate"`. These rules are documented in specs; this change only provides the shape + a `decideVerdict(findings, iteration)` pure helper.

### D6. Observability event shape

Single discriminated union `PhaseEvent`:
```
common fields: { ticketId, phase, profileId, ts, runId }
variants:
  PhaseStarted        { kind, input }                  // input summary, not full payload
  PhaseCompleted      { kind, output, durationMs, cost, tokens }
  PhaseFailed         { kind, error: { name, message, stack? }, durationMs }
  AgentInvoked        { kind, role, provider, model, cost, tokens, latencyMs }
  QualityGateEvaluated{ kind, gate, status, durationMs }
```

- `profileId` is included from day one (M4 experiments will populate it; M1 sets it to `"default"`).
- `runId` ties all events for one pass through the flow together (generated once at ticket pickup).
- `cost` is in micro-USD (integer) to avoid float accumulation issues; helpers to/from decimal USD are exported.
- Events are emitted through an injectable `EventSink` interface in this module (simple `emit(event)` method). Concrete sinks (stdout, Temporal, file) live in `orchestration-runtime`.

### D7. Strict parsing at every boundary, loose emit everywhere else

External inputs (webhook payloads, agent tool outputs) are `.parse()`ed (throws on bad shape). Internal emitters use plain TS types + the schema only for documentation, skipping re-validation on hot paths. Rationale: Zod parse cost is non-trivial; validating once at the edge is enough.

### D8. No contract version field yet

We are pre-1.0. When we break a contract we rename the field/module and migrate; there is no external consumer that pins to a version. Revisit at M3 when extensibility API becomes public.

## Risks / Trade-offs

- **Risk:** Zod schemas diverge from hand-written docs / downstream consumers' expectations.
  **Mitigation:** All downstream code `import type { Ticket } from "./contracts"`; no re-declarations. Lint rule can be added later.

- **Risk:** Over-specifying early (e.g., including M4 fields now) bloats the contract.
  **Mitigation:** Scoped exactly one forward-looking field (`profileId`) with explicit justification. Everything else tracks current M1 needs only.

- **Risk:** Temporal default JSON payload converter chokes on unknown types (Date, BigInt).
  **Mitigation:** All timestamp fields use ISO-8601 strings; all monetary fields are integer micro-USD; no `Date`, no `bigint` in contracts.

- **Trade-off:** Zod adds ~50KB runtime. Acceptable for a Node server; revisit only if we target edge/browser runtimes (we don't).

- **Trade-off:** `Ticket.sourceRef` is a discriminated union, so adding a new source (GitLab, Linear) is a non-breaking additive change — but consumers that exhaustively `switch` will need updating. Acceptable: intentional extensibility seam.

## Migration Plan

N/A — this is the first change in a greenfield codebase. Bootstrap only.

## Open Questions

- Should `ImplementationResult.qualityGates` include raw stdout/stderr logs or only a truncated tail? **Proposed:** truncated tail (last 4KB) per gate, full logs written to a file referenced by path. Resolve during implementation of `implement-phase`.
- Do we need a `correlationId` separate from `runId` for when the orchestrator (M2) retries a phase? **Proposed:** defer to M2; `runId` is sufficient for M1.
