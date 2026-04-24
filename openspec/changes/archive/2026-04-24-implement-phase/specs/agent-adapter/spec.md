## MODIFIED Requirements

### Requirement: AgentRole is closed and extensible via schema

The system SHALL define `AgentRole = "specifier" | "implementer" | "spec-reviewer" | "reviewer" | "subagent"` as a Zod enum and export it. New roles require a code change (not config change). The `spec-reviewer` role is used by the implement phase's structured diff-vs-spec subagent pass; it is a distinct role from the general-purpose `reviewer` (which owns the PR review phase).

#### Scenario: Listed roles accepted
- **WHEN** each of the 5 roles is parsed
- **THEN** parsing succeeds

#### Scenario: spec-reviewer is accepted
- **WHEN** `"spec-reviewer"` is parsed
- **THEN** parsing succeeds

#### Scenario: Unknown role rejected
- **WHEN** `"critic"` is parsed
- **THEN** parsing fails
