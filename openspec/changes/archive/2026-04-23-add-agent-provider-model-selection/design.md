## Context

The current orchestrator hard-codes agent routing by stage: specification and review use the Codex SDK, while implementation and bounded review-fix work use the Claude Agent SDK. Configuration mirrors that split with top-level `codex.model` and `anthropic.model` fields, and stage code calls provider-specific `runCodex` and `runClaude` helpers directly.

This makes provider and model selection inflexible in three places that matter operationally: planning cost/capability tuning, implementation behavior, and review behavior. It also leaves pricing and usage reporting tied to fixed provider assumptions even though the requested change allows any of the three logical agent roles to use either supported SDK.

## Goals / Non-Goals

**Goals:**
- Introduce explicit role-based agent selection for `planner`, `implementer`, and `reviewer`.
- Allow each role to choose either supported backend (`codex` or `anthropic`) and any model string.
- Preserve current behavior as the default when the new role config is omitted.
- Keep structured outputs, budget enforcement, and usage reporting intact regardless of provider choice.
- Preserve the current review workflow shape by continuing to use the implementer-style execution path for bounded fix passes.

**Non-Goals:**
- Adding new providers or SDK integrations beyond the existing Codex SDK and Claude Agent SDK.
- Discovering model availability dynamically from provider APIs.
- Building a full external pricing catalog for every possible model.

## Decisions

### 1. Add a role-based agent configuration layer

Add a new config section with one entry per logical role:

```json
{
  "agents": {
    "planner": { "provider": "codex", "model": "gpt-5-mini" },
    "implementer": { "provider": "anthropic", "model": "claude-sonnet-4-6" },
    "reviewer": { "provider": "codex", "model": "gpt-5-mini" }
  }
}
```

Provider validation is limited to the two currently supported backends. Model is treated as an opaque string so the orchestrator does not need to hard-code model enums. When `agents` is absent, the loader synthesizes the existing defaults from `codex.model` and `anthropic.model` so current installs keep working.

**Alternative considered:** continue adding stage-specific provider/model flags without a role abstraction.
That was rejected because it duplicates routing logic across stages and still leaves review-fix behavior ambiguous.

### 2. Route execution through provider-agnostic role resolution

Refactor `AgentRunner` to resolve a role first, then dispatch to the provider-specific SDK implementation. Stage code should describe intent (`planner`, `implementer`, `reviewer`) instead of calling provider-specific helpers directly.

The provider adapter remains responsible for:
- mapping structured output settings to the selected SDK,
- enforcing credentials for the selected provider,
- recording the actual provider and model used,
- using the role's budget stage as it does today.

**Alternative considered:** add provider branching inside each stage module.
That was rejected because it would spread provider selection, credential validation, and usage accounting across multiple files.

### 3. Keep bounded review fixes on the implementer role

The `reviewer` role is used for diff analysis and structured review findings. If review returns actionable findings, the bounded fix pass should run through the `implementer` role rather than the `reviewer` role.

This preserves today's behavior shape: review analysis is separate from code-edit execution, and the same role that performs normal implementation also performs review-driven fixes. It also avoids forcing the single `reviewer` role to satisfy both analysis and repository-editing expectations.

**Alternative considered:** make the `reviewer` role handle both review analysis and fix application.
That was rejected because it would change today's default routing and couple review-only model selection to code-edit execution.

### 4. Make pricing provider-oriented with legacy fallback

Cost estimation must no longer assume a single fixed Anthropic model. Pricing should be resolved from provider-oriented defaults, with optional model-specific overrides if present. Legacy pricing keys should continue to load so existing configuration does not break immediately.

The minimal behavior is:
- default pricing bucket for `codex` roles,
- default pricing bucket for `anthropic` roles,
- optional per-model override map when teams need more accurate estimates.

This keeps arbitrary model strings usable while acknowledging that exact estimates may require explicit pricing overrides.

**Alternative considered:** keep current pricing keys tied to `codex` and `sonnet` defaults only.
That was rejected because arbitrary model selection would make cost reporting misleading.

## Risks / Trade-offs

- [Pricing drift for arbitrary models] → Use provider defaults by default and allow explicit model overrides when precise accounting matters.
- [Provider-specific execution differences] → Keep stage prompts and structured output contracts unchanged so only routing varies.
- [Configuration ambiguity during migration] → Synthesize defaults from legacy fields and document precedence clearly.
- [Review fix semantics become unclear] → Explicitly bind review fixes to the implementer role in both code and spec text.

## Migration Plan

1. Add the new role-based config schema and keep legacy `codex.model` / `anthropic.model` as fallback defaults.
2. Refactor `AgentRunner` and stage code to resolve roles before dispatching provider-specific calls.
3. Update pricing resolution to use provider defaults with optional model overrides.
4. Update docs and sample config to show the new `agents` section and how review-fix work maps to the implementer role.
5. Remove or deprecate legacy model fields only after the new role-based config is adopted.

## Open Questions

- Whether pricing overrides should be keyed only by model name or by `provider + model` for clearer validation.