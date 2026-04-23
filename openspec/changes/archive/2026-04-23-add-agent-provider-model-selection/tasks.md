## 1. Configuration and schema

- [x] 1.1 Add a role-based agent configuration shape for `planner`, `implementer`, and `reviewer`, including provider validation and model strings.
- [x] 1.2 Preserve backward compatibility by deriving role defaults from the existing `codex` and `anthropic` settings when explicit role config is absent.
- [x] 1.3 Update config tests and sample configuration/documentation to describe the new role-based settings and role-to-stage mapping.

## 2. Agent runner routing

- [x] 2.1 Refactor `AgentRunner` to resolve a logical role before dispatching to the Codex SDK or Claude Agent SDK.
- [x] 2.2 Update usage and budget recording to capture the resolved role, provider, and model for each invocation.
- [x] 2.3 Update pricing resolution so provider defaults and any configured overrides work for arbitrary model strings.

## 3. Stage integration

- [x] 3.1 Update the specify stage to use the configured `planner` role for proposal, design, spec, and task generation while preserving structured output behavior.
- [x] 3.2 Update the implement stage to use the configured `implementer` role for repository changes and structured implementation summaries.
- [x] 3.3 Update the review stage to use the configured `reviewer` role for diff analysis and the configured `implementer` role for any bounded fix pass.

## 4. Validation and regression coverage

- [x] 4.1 Add tests covering valid and invalid role configuration, including missing credentials for the selected provider.
- [x] 4.2 Add tests covering role-based provider/model routing for planner, implementer, reviewer, and review-fix behavior.
- [x] 4.3 Run typecheck and relevant unit/integration suites to verify the refactor preserves existing defaults and structured-output guarantees.