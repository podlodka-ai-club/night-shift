## Why

Night Shift's baseline workflow is three phases — Specify, Implement, Review — that must run **independently**, not as tightly coupled steps. This only works if the data passing between them is a well-defined contract rather than ad-hoc shared state. Without contracts, each phase leaks assumptions about the others, phases can't be swapped or re-run in isolation, experiments across profiles can't be compared fairly (M4), and the orchestrator (M2) has no stable seams to reason about.

This change establishes the foundation the other six M1 changes build on: a ticket model and explicit input/output contracts for every phase boundary.

## What Changes

- Define a canonical `Ticket` domain model representing work pulled from a GitHub Projects v2 board (id, title, description, status, labels, url, repo coordinates, project item id).
- Define the seven ticket statuses used across M1 (`Backlog`, `Refinement`, `Refined`, `Ready`, `In progress`, `In review`, `Ready to merge`) and the allowed transitions, independent of any specific ticket source.
- Define the **Specify phase contract**: input = `Ticket` in `Refinement`; output = `SpecBundle` (path to OpenSpec change folder, list of open questions, assumptions, risks, branch name).
- Define the **Implement phase contract**: input = `Ticket` in `Ready` + reference to `SpecBundle`; output = `ImplementationResult` (PR url, PR number, branch, quality-gate results, summary of subagent spec review).
- Define the **Review phase contract**: input = `PR reference` + reference to `SpecBundle`; output = `ReviewResult` (verdict: `ready-to-merge` | `needs-fix` | `escalate`, findings grouped by severity, fix-loop iteration number).
- Define the **Observability contract**: a minimum set of structured event types every phase emits (`PhaseStarted`, `PhaseCompleted`, `PhaseFailed`, `AgentInvoked`, `QualityGateEvaluated`) with common fields (ticketId, phase, profileId, cost, latency, tokens).
- Establish a rule that contracts are serializable (JSON-safe) so they survive Temporal activity boundaries and can be persisted for later comparison in M4 experiments.

## Capabilities

### New Capabilities
- `phase-contracts`: the shared domain model and I/O contracts that define how Specify, Implement, and Review communicate, plus the observability event shape every phase must emit.

### Modified Capabilities
<!-- None — this is the first change. -->

## Impact

- **Foundational:** every subsequent M1 change (`agent-adapter-api`, `github-integration`, `specify-phase`, `implement-phase`, `review-phase`, `orchestration-runtime`) imports types and respects contracts defined here.
- **Code:** introduces a `@night-shift/contracts` (or single `src/contracts/`) module; no runtime dependencies beyond TypeScript types and a small set of runtime validators (Zod).
- **APIs:** defines the public shape other packages in the repo will depend on; breaking it later = breaking every phase.
- **Dependencies:** adds `zod` for runtime validation at contract boundaries.
- **No external systems:** this change adds no Temporal workflows, no GitHub calls, no agent invocations — it is pure types + validators + invariants.
