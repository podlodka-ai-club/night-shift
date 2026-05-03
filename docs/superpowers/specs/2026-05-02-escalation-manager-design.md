# Escalation Manager Design

## Goal

Minimize manual operator involvement when a ticket reaches a recoverable blocked state.

The orchestrator should route automation-recoverable failures to a new `Escalated` project status, run a higher-capability Escalation Manager agent in the same ticket workflow and worktree, and return the ticket to the appropriate phase intake status when the agent can resolve the issue. `Blocked` becomes the human-only fallback for cases where the Escalation Manager cannot safely resolve the issue.

## Current baseline

The current workflow has four relevant recovery surfaces:

- Specify can return `needs_input`, set `blockedReason = specify_needs_input`, and wait for `specifyRetry`.
- Implement can return `needs_input`, set `blockedReason = implement_needs_input`, and wait for `implementRetry` or `specifyRetry`.
- Review can return `escalated`, set `blockedReason = review_escalation`, and wait for `resume`.
- Any phase can throw an infrastructure/runtime failure and currently routes through workflow-level phase-failure handling.

Today those paths use the `Blocked` board status for operator intervention. The new feature should split this into:

- `Escalated`: automation recovery is in progress or pending.
- `Blocked`: the Escalation Manager has produced a human-readable handoff and needs a human decision.

Do not rename the existing `WorkflowBlockedReason` values in the first pass. They are already part of the Temporal query and intake signal contract. Treat them as workflow waiting reasons, not as a direct synonym for the `Blocked` board status.

## Recommended architecture

Implement Escalation Manager as an inline workflow phase owned by the existing ticket workflow, not as a separate workflow.

Reasons:

- It can reuse the same selected issue, worktree, branch, PR context, review iteration, and recent workflow details.
- It avoids cross-workflow locking around branch ownership.
- It keeps all phase retry decisions deterministic inside `automateTopReadyIssue`.
- It lets the workflow return to Specify, Implement, or Review without relying on an external pickup tick.

Suggested module boundary:

- `orchestrator/src/phases/escalation/phase.ts`
- `orchestrator/src/phases/escalation/prompt.ts`
- `orchestrator/src/phases/escalation/response.ts`
- `orchestrator/src/phases/escalation/errors.ts`

Suggested shared-contract additions:

- Add `Escalated` to `CANONICAL_PROJECT_STATUS_NAMES`.
- Keep `Blocked` in the canonical status list as the human fallback status.
- Add `DEFAULT_ESCALATED_STATUS = 'Escalated'`.
- Add `escalatedOptionId` and `escalatedStatusName` to `SelectedProjectIssue`.
- Add `escalation-response-v1` to the structured agent schema registry.
- Add an escalation agent profile to config instead of changing the default Specifier, Implementer, and Reviewer model.

## Lifecycle

### 1. A normal phase reaches a recoverable blocked condition

When Specify, Implement, or Review would currently move the item to `Blocked`, including workflow-level infrastructure/runtime phase failures, it should instead:

1. Upsert the phase summary or failure comment first.
2. Move the project item to `Escalated`.
3. Enter the Escalation Manager phase with the origin phase and reason.

This preserves the existing rule that comments should be written before a ticket is moved into a status that expects operator attention.

### 2. Escalation Manager triages and attempts repair

The Escalation Manager receives:

- origin phase: `specify`, `implement`, or `review`
- original blocked reason: `specify_needs_input`, `implement_needs_input`, or `review_escalation`
- issue title, body, labels, URL, and visible operator comments
- recent Night Shift phase summaries and workflow progress details
- change name and OpenSpec files under `openspec/changes/<changeName>`
- current worktree path, branch name, and current diff summary
- PR details, review comments, changed files, and diff when a PR exists
- quality gate or OpenSpec validation output when available
- the exact phase intake status that will be used if recovery succeeds

The agent should do root cause analysis, choose a conservative recovery strategy, and return a structured response. The workflow, not the agent, applies file writes, commits, PR updates, comments, and status transitions.

### 3. Recovery succeeds

When the agent returns `resolved` and validation passes:

- apply the returned file changes to the same worktree
- run the phase-appropriate validation
- commit and push to the same automation branch when files changed
- update the existing PR when one exists
- upsert an issue comment with marker `escalation:summary`
- move the item back to the phase intake status
- clear the escalation state and continue the normal workflow loop

Recommended target statuses:

| Origin | Recovery target status | Workflow continuation |
| --- | --- | --- |
| `specify` | `Backlog` | rerun Specify |
| `implement` | `Ready` | rerun Implement |
| `review` with code/spec/worktree changes | `Ready` | rerun Implement, then Review |
| `review` with review-only recovery | `In review` | rerun Review only |

The long-term contract should support review-only recovery from `In review`. A staged implementation may initially route all Review recoveries through `Ready` while adding the explicit review-only signal path later, but the design target is to avoid rerunning Implement when the Escalation Manager only resolves stale review context, invalid review findings, or review metadata.

### 4. Recovery needs a human

When the agent returns `needs_human`, is low confidence, proposes unsafe changes, produces invalid structured output, or fails validation after a bounded repair attempt:

- upsert an issue comment with marker `escalation:human-needed`
- include root cause, attempted resolution, exact unresolved decision, and recommended board move
- include the existing PR link when one exists, but do not paste full file contents into the issue comment
- move the item to `Blocked`
- preserve the original workflow blocked reason so existing human board moves can still signal the workflow
- keep the worktree for debugging and later resume

## Escalation Manager guidance

The Escalation Manager should receive a stronger system prompt than the normal phase agents. Recommended guidance:

```text
You are the Escalation Manager for the Night Shift orchestrator.

Your job is to recover tickets that automation could not complete without immediately requiring a human. You operate in the same worktree and branch as the ticket workflow.

First triage the failure. Identify the root cause, evidence, and affected phase. Prefer small, targeted repairs that restore the normal workflow. If a safe repair is available, produce the exact file changes and validation plan needed to proceed. If a product decision, missing credential, ambiguous requirement, external outage, or unsafe broad rewrite is required, stop and ask for human help.

You must not bypass the normal phase workflow. Do not approve specs, mark PRs ready to merge, merge PRs, close issues, change board statuses, create independent branches, or hide unresolved risk. The workflow will apply your changes, run validation, post comments, and move the ticket.

Return only structured output matching the provided schema.
```

Detailed behavioral rules:

- Prefer fixing the root cause over papering over a failed assertion or validation message.
- Keep changes scoped to the current ticket branch and worktree.
- Preserve OpenSpec as the source of truth. If implementation and spec disagree, either align them or ask for human clarification.
- Do not treat failing review findings as optional unless the review result is demonstrably stale or invalid.
- Do not invent missing product requirements. Ask for human input when the ticket/spec does not decide behavior.
- Do not add broad refactors unless they are the smallest safe path to unblock the ticket.
- Do not make security-sensitive or credential-related changes automatically.
- Explain every action in the issue comment in operator-facing language.

## Structured response contract

Recommended shape:

```ts
type EscalationResponse = {
  outcome: 'resolved' | 'needs_human';
  originPhase: 'specify' | 'implement' | 'review';
  confidence: 'high' | 'medium' | 'low';
  rootCause: {
    category:
      | 'missing_spec_context'
      | 'spec_validation_failure'
      | 'agent_contract_failure'
      | 'quality_gate_failure'
      | 'review_findings'
      | 'infrastructure_failure'
      | 'ambiguous_requirement'
      | 'external_dependency'
      | 'unknown';
    summary: string;
    evidence: string[];
  };
  resolution: {
    summary: string;
    files: Array<{ path: string; content: string }>;
    commitMessage?: string;
    validationPlan: string[];
    resumeStatus: 'Backlog' | 'Ready';
  };
  humanRequest?: {
    question: string;
    recommendedStatusAfterAnswer: 'Backlog' | 'Ready' | 'In review';
  };
  issueComment: string;
};
```

Contract rules:

- `outcome = resolved` requires `confidence` to be `high` or `medium`.
- `outcome = resolved` requires either file changes or a clear explanation of why no file changes were needed.
- `outcome = needs_human` requires `humanRequest`.
- `resumeStatus` must be derived from `originPhase`, not chosen freely by the model.
- `files.path` must be relative, normalized, unique, and inside the repository worktree.
- The schema should reject `.git`, dependency cache, credential, and absolute paths.
- The schema should enforce bounded string sizes so issue comments and Temporal history remain manageable.

## Programmatic enforcement

### Status and signal enforcement

- Add `Escalated` as a canonical project status and ensure it exists during board normalization.
- Move phase `needs_input` and review escalation paths to `Escalated`, not `Blocked`.
- Reserve `Blocked` for Escalation Manager human handoff only.
- Do not let the agent choose arbitrary board transitions.
- Continue using existing phase retry signals after recovery:
  - Specify recovery maps to `specifyRetry` semantics.
  - Implement recovery maps to `implementRetry` semantics.
  - Review recovery maps to `resume` semantics, with the current Implement plus Review rerun behavior.

### Attempt limits

- Run at most one Escalation Manager attempt per blocked event.
- Allow one additional repair turn only when the manager produced a plausible fix but validation failed with actionable feedback.
- Track escalation attempt count in workflow state and current details.
- If the Escalation Manager itself fails unexpectedly, write a human-needed comment and move to `Blocked`.

### Worktree and branch enforcement

- Pass the current `WorktreeContext` to the Escalation Manager when available.
- If the origin phase failed before creating a worktree, create or reuse the deterministic issue worktree before escalation.
- Never create a new branch for escalation.
- Commit and push to the existing automation branch only after validation succeeds.
- Preserve the worktree when escalation falls back to `Blocked`.

### File and command enforcement

- Prefer structured file writes through existing `writeOpenSpecChangeFiles` and `writeRepositoryFiles` activities.
- Do not give the model direct authority to move statuses, comment, commit, push, merge, or close issues.
- Use controlled validation activities after applying changes:
  - Specify: `openspec validate <changeName> --strict`
  - Implement and Review: `runQualityGate`
  - Review: refresh PR details, changed files, and comments before resuming
- If diagnostic commands are added later, expose them through an allowlisted activity with timeouts, output limits, redaction, and no network by default.

### Comment enforcement

- Use marker-upserted comments, not append-only comments.
- Write `escalation:summary` before moving the item out of `Escalated` after successful recovery.
- Write `escalation:human-needed` before moving the item to `Blocked`.
- Include root cause, evidence, actions taken, validation result, next phase, and the PR link when available.
- Keep comments to an operator summary plus PR/change reference. Do not include full changed-file contents in issue comments.

### Model/profile enforcement

- Add an escalation-specific agent profile in config, for example `agentProfiles.escalation`.
- Use `gpt-5.4` with high reasoning for the Escalation Manager phase.
- Use the advanced model only for the Escalation Manager phase.
- Use a separate timeout and retry budget for escalation so it cannot affect normal phase cost controls.
- Keep the same sandbox and repository boundary as the other agents.

### Intake enforcement

- Do not start a new ticket workflow from `Escalated` when no workflow is open. `Escalated` should be owned by an existing workflow.
- Pickup/manual intake may scan `Escalated` only to recover an already-open workflow that is waiting to run or retry escalation.
- If an `Escalated` item has no open workflow, leave it alone and surface it as an operator repair case rather than starting a detached branch owner.

## Implementation slices

### Slice 1: Board and workflow shell contract

- Add `Escalated` status constants, status option resolution, selected issue fields, and tests.
- Add escalation state to `renderWorkflowCurrentDetails`.
- Change normal phase blocked paths to enter an escalation subroutine instead of waiting for humans immediately.
- Preserve existing human fallback signals after Escalation Manager gives up.

### Slice 2: Escalation phase contract

- Add prompt, response schema, parser, and contract tests.
- Add fake-agent support for `resolved` and `needs_human` escalation responses.
- Add workflow tests for Specify, Implement, Review, and thrown infrastructure phase-failure escalation routing.

### Slice 3: File application and validation

- Apply manager file changes through existing write activities.
- Run phase-appropriate validation.
- Commit, push, and update PR only after validation succeeds.
- Add retry-safe tests for post-push replay and no-diff escalation outcomes.

### Slice 4: Intake, docs, and E2E

- Add optional `Escalated` scan support only for open-workflow recovery.
- Update `orchestrator/WORKFLOW.md` with the new `Escalated` and `Blocked` meanings.
- Add live fake-agent E2E coverage for an automated escalation recovery and a human fallback.

## Acceptance criteria

1. Project normalization creates both `Escalated` and `Blocked` status options.
2. Specify, Implement, Review, and infrastructure/runtime phase-failure paths move to `Escalated` and run Escalation Manager in the same workflow when recovery is eligible.
3. Successful escalation recovery writes an issue summary, validates the worktree, uses the same branch, and returns the ticket to the correct phase intake status.
4. Failed or unsafe escalation writes a human-needed issue comment, moves to `Blocked`, preserves the worktree, and allows the existing human retry signals to resume the workflow after operator action.
5. The Escalation Manager cannot directly move board status, approve/merge PRs, create independent branches, or choose arbitrary resume statuses.
6. Attempt limits prevent escalation loops and cap advanced-model cost.

## Resolved decisions

- Thrown infrastructure/runtime phase failures should enter Escalation Manager when the workflow has enough issue/worktree context to attempt recovery.
- Review recovery should support a long-term `In review` review-only resume path.
- Escalation comments should include an operator summary plus PR link/change reference, not full changed-file contents.
- `agentProfiles.escalation` should use `gpt-5.4` with high reasoning.