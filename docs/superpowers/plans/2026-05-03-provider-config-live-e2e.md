# Provider Configuration Live E2E Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove in live fake e2e that repo-local `.orchestrator/project.extension.ts` provider overrides are loaded, resolved per phase, and reflected in deterministic workflow artifacts.

**Architecture:** Reuse the existing fake live harness. Seed a project-extension file into the temporary branch, capture the resolved provider/model inside the fake adapter hooks, and extend fake artifact assertions to verify those markers for implement and review.

**Tech Stack:** TypeScript, npm workspaces, Mocha, GitHub-backed e2e harness, Temporal test environment.

---

### Task 1: Seed project-extension provider overrides in the fake live harness

**Files:**
- Modify: `.worktrees/project-extension-model/e2e/src/run-e2e.ts`
- Test: `.worktrees/project-extension-model/e2e/src/run-e2e.test.ts`
- Doc reference: `.worktrees/project-extension-model/docs/superpowers/specs/2026-05-03-provider-config-live-e2e-design.md`

- [ ] Add a deterministic helper that returns the seeded `.orchestrator/project.extension.ts` content for the fake live scenario.
- [ ] Update `seedApprovedSpecBundle()` to write that project-extension file into the worktree before commit/push.
- [ ] Add a focused test proving the fake harness seed includes the new file content alongside the existing quality-gate/spec bundle seed.
- [ ] Run: `npm --workspace e2e test -- --grep "FAKE_E2E_QUALITY_GATE_FILE|seedApprovedSpecBundle|runConfiguredIntake"`
- [ ] Commit.

### Task 2: Capture resolved provider/model selection in the fake adapter

**Files:**
- Modify: `.worktrees/project-extension-model/e2e/src/fake-agent.ts`
- Test: `.worktrees/project-extension-model/e2e/src/fake-agent.test.ts`
- Reference: `.worktrees/project-extension-model/orchestrator/src/activity-deps.ts`

- [ ] Update fake Codex/Claude session factories to retain the selected provider/model in fake thread/session state using the actual adapter hook inputs.
- [ ] Extend deterministic fake implement and review outputs so they include stable provider/model markers derived from that captured state.
- [ ] Add focused tests for both Codex and Claude fake paths proving the markers reflect the resolved runtime selection.
- [ ] Run: `npm --workspace e2e test -- --grep "createFakeAgentDeps"`
- [ ] Commit.

### Task 3: Assert provider markers in fake live artifacts and docs

**Files:**
- Modify: `.worktrees/project-extension-model/e2e/src/live-github.ts`
- Modify: `.worktrees/project-extension-model/e2e/src/live-github.test.ts`
- Modify: `.worktrees/project-extension-model/e2e/README.md`

- [ ] Extend fake artifact expectations so implement and review provider/model markers are asserted in the existing fake live snapshot checks.
- [ ] Update artifact tests to the new expected snapshot.
- [ ] Document that the fake live run now seeds `.orchestrator/project.extension.ts` and verifies provider configuration end-to-end.
- [ ] Run: `npm --workspace e2e test -- --grep "assertWorkflowArtifacts|verifies deterministic fake-agent artifacts"`
- [ ] Commit.

### Task 4: Full verification and review

**Files:**
- Verify only; no intentional code edits unless fixes are required.

- [ ] Run: `npm --workspace e2e test`
- [ ] Run: `npm --workspace e2e run build`
- [ ] If credentials/environment are available and the user wants the live gate, run: `npm --workspace e2e run live:fake`
- [ ] Run external review against the design spec using the review-code workflow.
- [ ] Address any findings, rerun the smallest affected checks, then rerun the broader verification commands.
- [ ] Commit the final reviewed state.
