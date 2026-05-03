import assert from 'assert';
import { describe, it } from 'mocha';
import { computeModelCostMicroUsd } from '../agent-pricing';

describe('agent pricing', () => {
  it('returns undefined when cost data is unavailable for a model', () => {
    assert.strictEqual(computeModelCostMicroUsd('unknown-model', {
      input_tokens: 100,
      cached_input_tokens: 0,
      output_tokens: 10,
    }), undefined);
  });

  it('prices cached and uncached input separately for known models', () => {
    assert.strictEqual(computeModelCostMicroUsd('claude-sonnet-4-6', {
      input_tokens: 1300,
      cached_input_tokens: 200,
      output_tokens: 50,
    }), 4110);
  });
});