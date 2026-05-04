import assert from 'assert';
import { describe, it } from 'mocha';
import type {
  AutomateReadyIssueResult,
  CommitAndPushInput,
  CreateWorktreeForIssueIfNeededInput,
  SelectedProjectIssue,
  WorktreeContext,
  WriteOpenSpecChangeFilesInput,
  WriteRepositoryFilesInput,
} from '../../orchestrator/lib/shared';
import type { E2EConfig } from './config';
import {
  assertFakeAgentWorkflowCurrentDetails,
  buildFakeE2EProjectExtensionContent,
  FAKE_E2E_QUALITY_GATE_FILE,
  FAKE_E2E_PROJECT_EXTENSION_FILE,
  recordObservedStatus,
  resolveSeedStatus,
  resolveStartPhase,
  runConfiguredIntake,
  seedApprovedSpecBundle,
  shouldCleanup,
} from './run-e2e';

function createTestConfig(): E2EConfig {
  return {
    targetRepo: { owner: 'Mugenor', name: 'orchestrator-testing' },
    projectOwner: 'Mugenor',
    projectNumber: 1,
    agentMode: 'fake',
    intakeMode: 'manual',
    cleanup: true,
    preserveOnFailure: true,
    githubToken: 'test-token',
  };
}

describe('shouldCleanup', () => {
  const baseConfig = createTestConfig();

  it('returns true when cleanup is enabled and the run succeeds', () => {
    assert.strictEqual(shouldCleanup(baseConfig), true);
  });

  it('returns false when cleanup is disabled', () => {
    assert.strictEqual(shouldCleanup({ ...baseConfig, cleanup: false }), false);
  });

  it('returns false on failure when preserveOnFailure is enabled', () => {
    assert.strictEqual(shouldCleanup(baseConfig, new Error('boom')), false);
  });
});

describe('recordObservedStatus', () => {
  it('appends only non-empty status transitions', () => {
    const observed: string[] = [];

    recordObservedStatus(observed, undefined);
    recordObservedStatus(observed, 'Ready');
    recordObservedStatus(observed, 'Ready');
    recordObservedStatus(observed, 'In progress');
    recordObservedStatus(observed, 'In progress');
    recordObservedStatus(observed, 'In review');
    recordObservedStatus(observed, 'Ready to merge');

    assert.deepStrictEqual(observed, ['Ready', 'In progress', 'In review', 'Ready to merge']);
  });
});

describe('runConfiguredIntake', () => {
  it('dispatches to pickupWorkflow when intakeMode is pickup', async () => {
    const calls: string[] = [];
    const result = buildWorkflowResult();

    const observed = await runConfiguredIntake(
      { intakeMode: 'pickup' },
      {
        async executePickupWorkflow() {
          calls.push('pickup');
        },
        async executeManualIntake() {
          calls.push('manual');
        },
        async awaitWorkflowResult() {
          calls.push('result');
          return result;
        },
      },
    );

    assert.deepStrictEqual(calls, ['pickup', 'result']);
    assert.strictEqual(observed, result);
  });

  it('dispatches to manual intake when intakeMode is manual', async () => {
    const calls: string[] = [];

    await runConfiguredIntake(
      { intakeMode: 'manual' },
      {
        async executePickupWorkflow() {
          calls.push('pickup');
        },
        async executeManualIntake() {
          calls.push('manual');
        },
        async awaitWorkflowResult() {
          calls.push('result');
          return buildWorkflowResult();
        },
      },
    );

    assert.deepStrictEqual(calls, ['manual', 'result']);
  });
});

describe('resolveStartPhase', () => {
  it('starts fake-agent runs at Implement so the harness can seed an approved spec bundle', () => {
    assert.strictEqual(resolveStartPhase('fake'), 'implement');
  });

  it('starts real-agent runs at Specify so they do not require a pre-seeded approved spec bundle', () => {
    assert.strictEqual(resolveStartPhase('real'), 'specify');
  });
});

describe('resolveSeedStatus', () => {
  it('seeds fake-agent runs in Ready so shared intake starts Implement', () => {
    assert.strictEqual(resolveSeedStatus('fake'), 'Ready');
  });

  it('seeds real-agent runs in Backlog so shared intake starts Specify', () => {
    assert.strictEqual(resolveSeedStatus('real'), 'Backlog');
  });
});

describe('FAKE_E2E_QUALITY_GATE_FILE', () => {
  it('seeds a deterministic make check target for the fake live harness', () => {
    assert.strictEqual(FAKE_E2E_QUALITY_GATE_FILE.path, 'Makefile');
    assert.match(FAKE_E2E_QUALITY_GATE_FILE.content, /^\.PHONY: check/m);
    assert.match(FAKE_E2E_QUALITY_GATE_FILE.content, /^check:$/m);
    assert.match(FAKE_E2E_QUALITY_GATE_FILE.content, /fake e2e quality gate passed/);
  });
});

describe('buildFakeE2EProjectExtensionContent', () => {
  it('returns deterministic provider overrides for implement and review', () => {
    const content = buildFakeE2EProjectExtensionContent();

    assert.match(content, /defineProjectExtension/);
    assert.match(content, /project\.agent\('implement', \{ provider: 'anthropic', config: \{ model: 'claude-haiku-4-5' \} \}\);/);
    assert.match(content, /project\.agent\('review', \{ provider: 'openai', config: \{ model: 'gpt-5\.4' \} \}\);/);
    assert.strictEqual(FAKE_E2E_PROJECT_EXTENSION_FILE.path, '.orchestrator/project.extension.ts');
    assert.strictEqual(FAKE_E2E_PROJECT_EXTENSION_FILE.content, content);
  });
});

describe('seedApprovedSpecBundle', () => {
  it('writes the approved spec bundle plus fake repository seed files before commit', async () => {
    const calls: string[] = [];
    let writeOpenSpecChangeFilesInput: unknown;
    let writeRepositoryFilesInput: unknown;
    let commitAndPushInput: unknown;
    const worktree: WorktreeContext = {
      issueNumber: 7,
      issueTitle: 'Create a dummy PR',
      taskDescription: 'Implement the requested repository change for issue 7.',
      issueUrl: 'https://github.com/Mugenor/orchestrator-testing/issues/7',
      repoOwner: 'Mugenor',
      repoName: 'orchestrator-testing',
      defaultBranch: 'main',
      branchName: 'orchestrator-e2e-test/issue-7',
      generatedAt: '2026-05-03T00:00:00.000Z',
      repoRoot: '/tmp/repo',
      worktreePath: '/tmp/worktree',
    };
    const selectedIssue = buildSelectedIssue();

    await seedApprovedSpecBundle(
      {
        async createWorktreeForIssueIfNeeded(input: CreateWorktreeForIssueIfNeededInput) {
          calls.push('createWorktreeForIssueIfNeeded');
          assert.deepStrictEqual(input, { issue: selectedIssue, branchPrefix: 'orchestrator-e2e-test' });
          return worktree;
        },
        async writeOpenSpecChangeFiles(input: WriteOpenSpecChangeFilesInput) {
          calls.push('writeOpenSpecChangeFiles');
          writeOpenSpecChangeFilesInput = input;
        },
        async writeRepositoryFiles(input: WriteRepositoryFilesInput) {
          calls.push('writeRepositoryFiles');
          writeRepositoryFilesInput = input;
        },
        async commitAndPush(input: CommitAndPushInput) {
          calls.push('commitAndPush');
          commitAndPushInput = input;
        },
      } as never,
      selectedIssue,
      'orchestrator-e2e-test',
    );

    assert.deepStrictEqual(calls, [
      'createWorktreeForIssueIfNeeded',
      'writeOpenSpecChangeFiles',
      'writeRepositoryFiles',
      'commitAndPush',
    ]);
    assert.deepStrictEqual(writeOpenSpecChangeFilesInput, {
      worktree,
      changeName: '7-create-a-dummy-pr',
      files: [
        { path: 'proposal.md', content: '# Proposal\n\n## Why\n- Seed an approved spec bundle for the fake-agent e2e run.' },
        { path: 'tasks.md', content: '# Tasks\n\n- [x] Approve the fake-agent e2e spec bundle.' },
        { path: 'specs/e2e/spec.md', content: '## ADDED Requirements\n### Requirement: Fake agent e2e implement flow\nThe live fake-agent path MUST start from Ready with an approved spec bundle.' },
      ],
    });
    assert.deepStrictEqual(writeRepositoryFilesInput, {
      worktree,
      files: [FAKE_E2E_QUALITY_GATE_FILE, FAKE_E2E_PROJECT_EXTENSION_FILE],
    });
    assert.deepStrictEqual(commitAndPushInput, {
      worktree,
      commitMessage: 'test: seed approved spec bundle for 7',
    });
  });
});

describe('assertFakeAgentWorkflowCurrentDetails', () => {
  it('accepts current details that retain fake assistant summaries', () => {
    assert.doesNotThrow(() => {
      assertFakeAgentWorkflowCurrentDetails([
        '## Deterministic phases workflow',
        '- Start phase: implement',
        '- Current phase: review',
        '- Blocked reason: none',
        '- Review iteration: 1/3',
        '- Latest activity: Review approved PR #63; issue moved to Ready to merge.',
        '- Recent summaries:',
        '  - Opened PR #63 and moved the issue to In review.',
        '  - Review verdict for PR #63: ready-to-merge.',
        '  - Review approved PR #63; issue moved to Ready to merge.',
      ].join('\n'), [
        '## Deterministic phases workflow',
        '- Recent summaries:',
        '  - Preparing deterministic fake review verdict.',
      ].join('\n'));
    });
  });
});

function buildWorkflowResult(): AutomateReadyIssueResult {
  return {
    issueNumber: 77,
    issueTitle: 'Seeded issue',
    issueUrl: 'https://github.com/Mugenor/orchestrator-testing/issues/77',
    pullRequestNumber: 12,
    pullRequestUrl: 'https://github.com/Mugenor/orchestrator-testing/pull/12',
    branchName: 'orchestrator-e2e-run-123/issue-77',
    targetStatusName: 'Ready to merge',
  };
}

function buildSelectedIssue(): SelectedProjectIssue {
  return {
    projectId: 'project-1',
    projectItemId: 'item-1',
    statusFieldId: 'status-field',
    backlogOptionId: 'backlog-option',
    refinementOptionId: 'refinement-option',
    refinedOptionId: 'refined-option',
    readyOptionId: 'ready-option',
    inProgressOptionId: 'progress-option',
    inReviewOptionId: 'review-option',
    readyToMergeOptionId: 'ready-to-merge-option',
    escalatedOptionId: 'escalated-option',
    blockedOptionId: 'blocked-option',
    issueNumber: 7,
    issueTitle: 'Create a dummy PR',
    taskDescription: 'Implement the requested repository change for issue 7.',
    issueUrl: 'https://github.com/Mugenor/orchestrator-testing/issues/7',
    repoOwner: 'Mugenor',
    repoName: 'orchestrator-testing',
    defaultBranch: 'main',
    backlogStatusName: 'Backlog',
    refinementStatusName: 'Refinement',
    refinedStatusName: 'Refined',
    readyStatusName: 'Ready',
    inReviewStatusName: 'In review',
    escalatedStatusName: 'Escalated',
    readyToMergeStatusName: 'Ready to merge',
  };
}