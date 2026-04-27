import assert from 'assert';
import { describe, it } from 'mocha';
import { parseE2EConfig } from './config';

describe('parseE2EConfig', () => {
  it('parses required env and boolean flags', () => {
    const config = parseE2EConfig({
      E2E_TARGET_REPO: 'Mugenor/orchestrator-testing',
      E2E_PROJECT_OWNER: 'Mugenor',
      E2E_PROJECT_NUMBER: '1',
      E2E_AGENT_MODE: 'fake',
      E2E_CLEANUP: 'true',
      E2E_PRESERVE_ON_FAILURE: 'false',
      GITHUB_TOKEN: 'test-token',
    });

    assert.deepStrictEqual(config, {
      targetRepo: { owner: 'Mugenor', name: 'orchestrator-testing' },
      projectOwner: 'Mugenor',
      projectNumber: 1,
      agentMode: 'fake',
      cleanup: true,
      preserveOnFailure: false,
      githubToken: 'test-token',
    });
  });

  it('rejects invalid boolean flag values', () => {
    assert.throws(
      () =>
        parseE2EConfig({
          E2E_TARGET_REPO: 'Mugenor/orchestrator-testing',
          E2E_PROJECT_OWNER: 'Mugenor',
          E2E_PROJECT_NUMBER: '1',
          E2E_AGENT_MODE: 'real',
          E2E_CLEANUP: '1',
          E2E_PRESERVE_ON_FAILURE: 'true',
          GITHUB_TOKEN: 'test-token',
        }),
      /E2E_CLEANUP must be "true" or "false"/,
    );
  });
});