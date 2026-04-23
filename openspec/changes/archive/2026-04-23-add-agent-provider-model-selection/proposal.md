## Why

The orchestrator currently hard-codes provider and model choices for specification, implementation, and review work. That makes it impossible to tune cost, latency, or model capability per stage without changing code, even though the system already supports both the Codex SDK and the Claude Agent SDK.

## What Changes

- Add configuration for planner, implementer, and reviewer agent roles so each role can declare its provider and model independently.
- Support selecting either the existing Codex SDK or the existing Claude Agent SDK for any of the three roles.
- Update agent execution, pricing, and usage reporting so recorded provider/model metadata reflects the configured role selection instead of hard-coded defaults.
- Preserve the current providers as the only supported backends for now; this change does not add new SDK integrations.

## Capabilities

### New Capabilities
- None.

### Modified Capabilities
- `openspec-derived-task-execution`: specification and implementation requirements will change from fixed provider/model assignments to configurable per-role selection.
- `review-and-pr-reporting`: review and fix-pass requirements will change from fixed provider/model assignments to configurable per-role selection while preserving structured outputs and bounded review behavior.

## Impact

- Affected code: configuration loading, agent execution orchestration, pricing lookup, and any stage code that assumes fixed providers or models.
- Affected APIs: checked-in config shape and environment variable mapping for agent role selection.
- Affected systems: Codex SDK and Claude Agent SDK invocation paths, budget/usage accounting, and review reporting.