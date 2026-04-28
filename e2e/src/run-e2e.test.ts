import assert from 'assert';
import { describe, it } from 'mocha';
import type { E2EConfig } from './config';
import { FAKE_E2E_QUALITY_GATE_FILE, recordObservedStatus, resolveStartPhase, shouldCleanup } from './run-e2e';

function createTestConfig(): E2EConfig {
  return {
    targetRepo: { owner: 'Mugenor', name: 'orchestrator-testing' },
    projectOwner: 'Mugenor',
    projectNumber: 1,
    agentMode: 'fake',
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

    assert.deepStrictEqual(observed, ['Ready', 'In progress', 'In review']);
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

describe('FAKE_E2E_QUALITY_GATE_FILE', () => {
  it('seeds a deterministic make check target for the fake live harness', () => {
    assert.strictEqual(FAKE_E2E_QUALITY_GATE_FILE.path, 'Makefile');
    assert.match(FAKE_E2E_QUALITY_GATE_FILE.content, /^\.PHONY: check/m);
    assert.match(FAKE_E2E_QUALITY_GATE_FILE.content, /^check:$/m);
    assert.match(FAKE_E2E_QUALITY_GATE_FILE.content, /fake e2e quality gate passed/);
  });
});