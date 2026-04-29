import assert from 'assert';
import { describe, it } from 'mocha';
import type { AutomateReadyIssueResult } from '../../orchestrator/lib/shared';
import type { E2EConfig } from './config';
import {
  FAKE_E2E_QUALITY_GATE_FILE,
  recordObservedStatus,
  resolveSeedStatus,
  resolveStartPhase,
  runConfiguredIntake,
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

function buildWorkflowResult(): AutomateReadyIssueResult {
  return {
    issueNumber: 77,
    issueTitle: 'Seeded issue',
    issueUrl: 'https://github.com/Mugenor/orchestrator-testing/issues/77',
    pullRequestNumber: 12,
    pullRequestUrl: 'https://github.com/Mugenor/orchestrator-testing/pull/12',
    branchName: 'orchestrator-e2e-run-123/issue-77',
    filePath: 'orchestrator-e2e/run-123',
    targetStatusName: 'Ready to merge',
  };
}