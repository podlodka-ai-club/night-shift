# Project Extension Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let one orchestrator worker monitor many targets while each cloned repo can register prompt customizations and `zsh -c` quality gates through `.orchestrator/project.extension.ts`.

**Architecture:** Reshape global config around `targets[]` plus `git.branchPrefix`, add a repo-local extension loader that compiles prompt contributions and quality gates into a manifest, then thread that manifest into prompt builders and implement-phase quality-gate execution. Keep v1 registration-only: no lifecycle hooks, no long-lived extension objects.

**Tech Stack:** TypeScript, Zod, ts-node config loading, Mocha, existing worktree/activity/phase test suites.

---

### Task 1: Reshape global config, target resolution, and repo binding

**Files:**
- Modify: `orchestrator/src/config.ts`
- Modify: `orchestrator/src/entrypoint-config.ts`
- Modify: `orchestrator/src/shared.ts`
- Modify: `orchestrator/src/activity-github-project.ts`
- Modify: `orchestrator/src/client.ts`
- Modify: `orchestrator/src/worker.ts`
- Modify: `orchestrator/src/intake.ts`
- Modify: `orchestrator/src/pickup.ts`
- Modify: `orchestrator/src/pickup-activities.ts`
- Modify: `orchestrator/src/mocha/config.test.ts`
- Modify: `orchestrator/src/mocha/entrypoint-config.test.ts`
- Modify: `orchestrator/src/mocha/activity-github.test.ts`
- Modify: `orchestrator/src/mocha/intake.test.ts`
- Modify: `orchestrator/src/mocha/pickup.test.ts`
- Modify: `orchestrator/src/mocha/pickup-workflow.test.ts`
- Modify: `orchestrator/src/mocha/worker.test.ts`

- [ ] Replace the single `github` config shape with `targets[]` plus a separate global `git.branchPrefix` field, preserving current config discovery and adjacent `.env` loading behavior.
- [ ] Introduce a resolved target-selection path for worker/client entrypoints with explicit precedence: CLI/env coordinates matched back to a configured target first, a single configured target second, and a clear error when multiple targets exist without a disambiguator.
- [ ] Thread target identity plus expected repo binding through intake/pickup flows so the runtime can validate that a selected board item belongs to the configured repository before any worktree is created.
- [ ] Make the resolved workflow input carry the selected target identity and the separate branch prefix without regressing current status-name resolution.
- [ ] Update config, GitHub-activity, and entrypoint tests to cover multi-target parsing, missing-target errors, branch-prefix placement, and explicit repo-mismatch failures.
- [ ] Run: `npm --workspace orchestrator test -- src/mocha/config.test.ts src/mocha/entrypoint-config.test.ts src/mocha/activity-github.test.ts src/mocha/intake.test.ts src/mocha/pickup.test.ts src/mocha/pickup-workflow.test.ts src/mocha/worker.test.ts`

### Task 2: Add a repo-local project extension loader and manifest

**Files:**
- Create: `orchestrator/src/project-extension.ts`
- Modify: `orchestrator/src/shared.ts`
- Modify: `orchestrator/src/activity-deps.ts`
- Modify: `orchestrator/src/activities.ts`
- Modify: `orchestrator/src/workflows.ts`
- Create: `orchestrator/src/mocha/project-extension.test.ts`
- Modify: `orchestrator/src/mocha/workflow-success.test.ts`
- Modify: `orchestrator/src/mocha/workflow-failure.test.ts`

- [ ] Define explicit manifest types for prompt contributions and quality gates so phase/activity code consumes plain data rather than live extension objects.
- [ ] Implement `.orchestrator/project.extension.ts` loading from the repo worktree with one narrow API: `project.prompt(...).prepend/append` and `project.qualityGate(...)`.
- [ ] Load the extension once per target run after worktree creation, compile it into a plain manifest, and cache that manifest in workflow/runtime state so phases reuse data instead of reloading the module.
- [ ] Treat the extension as target-scoped trusted code: missing file returns an empty manifest, invalid module/registration throws a target-run error, and no process-global state or module-cache leakage is exposed across targets.
- [ ] Add focused tests for missing extension, valid registration, invalid API use, invalid module execution, and manifest isolation between runs.
- [ ] Run: `npm --workspace orchestrator test -- src/mocha/project-extension.test.ts src/mocha/workflow-success.test.ts src/mocha/workflow-failure.test.ts`

### Task 3: Thread prompt contributions into specify, implement, and review phases

**Files:**
- Modify: `orchestrator/src/phases/specify/prompt.ts`
- Modify: `orchestrator/src/phases/implement/prompt.ts`
- Modify: `orchestrator/src/phases/review/prompt.ts`
- Modify: `orchestrator/src/phases/specify/phase.ts`
- Modify: `orchestrator/src/phases/implement/phase.ts`
- Modify: `orchestrator/src/phases/review/phase.ts`
- Modify: `orchestrator/src/mocha/specify-phase.test.ts`
- Modify: `orchestrator/src/mocha/implement-phase.test.ts`
- Modify: `orchestrator/src/mocha/review-phase.test.ts`

- [ ] Extend the phase seams so each phase receives the compiled project-extension manifest for the current worktree/target.
- [ ] Apply prompt prepend/append contributions conservatively in a dedicated project-extension guidance section immediately before each phase's final response-contract section, keeping system prompts and safety hardening immutable.
- [ ] Keep prompt-builder callers compatible with the live eval helpers, updating eval callers/tests in the same task only if the prompt-builder signatures cannot remain backward-compatible.
- [ ] Add prompt assertions proving extension text appears in the right phase only, sits in the dedicated guidance section, and does not leak across phases.
- [ ] Re-run targeted phase tests before moving on.
- [ ] Run: `npm --workspace orchestrator test -- src/mocha/specify-phase.test.ts src/mocha/implement-phase.test.ts src/mocha/review-phase.test.ts`

### Task 4: Replace implicit quality-gate execution with extension-defined `zsh -c` gates plus fallback

**Files:**
- Modify: `orchestrator/src/activity-worktree.ts`
- Modify: `orchestrator/src/phases/implement/phase.ts`
- Modify: `orchestrator/src/mocha/activity-worktree.test.ts`
- Modify: `orchestrator/src/mocha/implement-phase.test.ts`

- [ ] Teach `runQualityGate(...)` to accept the current project-extension manifest and execute registered gates from the worktree with `zsh -c`.
- [ ] Preserve the current autodetected `make check` / `npm run check` path only as a fallback when the extension registers zero quality gates; once a repo registers any explicit gates, only those explicit gates participate in pass/fail.
- [ ] Keep gate summaries/log truncation deterministic and surface gate failures as normal implement-phase failures.
- [ ] Add tests for successful gate execution, failed gate execution, multiple explicit gates, fallback behavior, and the exact `zsh -c` command shape.
- [ ] Run: `npm --workspace orchestrator test -- src/mocha/activity-worktree.test.ts src/mocha/implement-phase.test.ts`

### Task 5: Document the new model and run the full verification suite

**Files:**
- Modify: `orchestrator/README.md`
- Modify: `orchestrator.config.ts`
- Modify: `docs/superpowers/specs/2026-05-03-project-extension-model-design.md`

- [ ] Update the README to explain `targets[]`, `git.branchPrefix`, the repo-mismatch rule, and `.orchestrator/project.extension.ts` authoring.
- [ ] Refresh the sample root config to show the new multi-target bootstrap shape.
- [ ] Verify the new design doc stays aligned with the code-level contract and remove any doc drift found during implementation.
- [ ] Run the smallest useful targeted tests again, then `npm --workspace orchestrator run build`, then `make check`.
- [ ] If all checks pass, prepare a concise implementation summary describing the migrated config shape, extension contract, and validation evidence.
