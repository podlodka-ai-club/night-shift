# Provider Configuration Live E2E Design

## Goal

Add true live e2e coverage proving that repo-local provider configuration in `.orchestrator/project.extension.ts` is loaded from the target repository, resolved per phase, and honored by runtime adapter selection.

## Context

The current provider-configuration feature is well covered by orchestrator unit/integration tests, but the live GitHub-backed `e2e/` package does not currently exercise the new project-level provider settings. The existing fake live path already seeds deterministic repository content into a real branch and verifies workflow artifacts, so it is the best place to add low-flake end-to-end coverage.

## Scope

In scope:
- one `live:fake` manual-intake scenario
- seeding `.orchestrator/project.extension.ts` into the fake live branch
- deterministic fake-agent markers that reflect the resolved provider/model actually selected for implement and review
- live artifact assertions that verify those markers
- focused unit tests and e2e docs updates

Out of scope:
- `live:fake:pickup`
- `live:real`
- new user-facing provider config outside project extension
- broad production refactors unrelated to e2e coverage

## User-facing repo contract

Per-project provider config is added by committing `.orchestrator/project.extension.ts` to the repository. The file exports `defineProjectExtension((project) => { ... })` and can register:
- `project.agentDefaults(selection)`
- `project.agent('specify' | 'implement' | 'review', selection)`

For this e2e scenario, the harness will seed a deterministic file into the temporary branch before the workflow starts.

## Seeded project extension contract

The fake live harness will write `.orchestrator/project.extension.ts` alongside the approved spec bundle and fake quality gate seed.

The seeded extension should override at least two phases with distinct values so the e2e can prove phase-scoped selection, not just a single default. Recommended values:
- implement: `provider: 'anthropic'`, `config.model: 'claude-haiku-4-5'`
- review: `provider: 'openai'`, `config.model: 'gpt-5.4'`

Using donor aliases here is desirable because the e2e should also prove alias normalization on the real runtime path.

## Runtime proof strategy

The e2e proof should come from the already-resolved runtime selection, not from re-parsing the extension file inside the fake agent.

Therefore the fake live harness will observe provider/model at the adapter boundary by extending the fake agent’s session factory hooks:
- `createCodexThread` / `resumeCodexThread`
- `createClaudeSession` / `resumeClaudeSession`

Those hooks already receive the selected model, and the chosen hook itself reveals the resolved provider. This keeps the proof aligned with the real runtime path:
1. repo-local extension file is loaded
2. per-phase selection is resolved
3. runtime chooses the provider adapter
4. fake adapter captures what was chosen

## Marker contract

The fake agent will embed deterministic markers into existing fake artifacts.

Implement markers should be present in the generated fake file text and/or implement summary/follow-ups.
Review markers should be present in the review summary and/or review findings.

Recommended marker shape:
- `Implement provider: claude`
- `Implement model: claude-haiku-4-5`
- `Review provider: codex`
- `Review model: gpt-5.4`

The exact text should remain simple, stable, and easy to assert in tests.

## Assertions

The live fake artifact verification should prove:
- the fake repository artifact contains implement provider/model markers matching the seeded project extension
- the review summary artifact contains review provider/model markers matching the seeded project extension
- the run still completes through the normal Ready → In progress → In review → Ready to merge flow

This is sufficient to prove the provider config was honored end-to-end without adding a new diagnostic-only production API surface.

## Failure handling

If the seeded extension is malformed or fails to load, the live e2e should fail the target run clearly.
If provider resolution regresses, the observed markers will drift and artifact assertions will fail.
If the fake adapter stops receiving the resolved provider/model, unit tests around the fake agent hooks should fail before live e2e runs.

## Testing expectations

Implementation should add/update:
- unit tests for seeded extension generation in the fake harness
- unit tests for fake-agent provider/model marker behavior
- artifact assertion tests for the expanded fake live snapshot
- README docs describing the new scenario

Verification should include:
- `npm --workspace e2e test`
- `npm --workspace e2e run build`
- a live manual fake run when credentials/environment are available

## Success criteria

The feature is complete when a fake live e2e run can seed repo-local provider config, complete successfully, and verify provider/model markers that reflect the resolved implement and review selections chosen by the runtime.
