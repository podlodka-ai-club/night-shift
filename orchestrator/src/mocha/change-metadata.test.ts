import assert from 'assert';
import { describe, it } from 'mocha';
import { changeMetadataJsonSchemaSource, changeMetadataSchema } from '../change-metadata';

describe('change metadata schemas', () => {
  it('keeps the Zod v4 parse schema and Zod v3 json-schema source aligned', () => {
    const cases: Array<{ label: string; input: unknown }> = [
      {
        label: 'valid metadata',
        input: {
          commitMessage: 'feat: align schemas',
          pullRequestTitle: 'feat: align structured metadata schemas',
          pullRequestBody: '## Summary\n- keep schema definitions synchronized',
        },
      },
      {
        label: 'missing commitMessage',
        input: {
          pullRequestTitle: 'feat: align structured metadata schemas',
          pullRequestBody: '## Summary\n- keep schema definitions synchronized',
        },
      },
      {
        label: 'wrong field type',
        input: {
          commitMessage: 42,
          pullRequestTitle: 'feat: align structured metadata schemas',
          pullRequestBody: '## Summary\n- keep schema definitions synchronized',
        },
      },
      { label: 'null payload', input: null },
    ];

    for (const testCase of cases) {
      const v4Result = changeMetadataSchema.safeParse(testCase.input);
      const v3Result = changeMetadataJsonSchemaSource.safeParse(testCase.input);
      assert.strictEqual(v4Result.success, v3Result.success, testCase.label);
      if (v4Result.success && v3Result.success) {
        assert.deepStrictEqual(v4Result.data, v3Result.data, testCase.label);
      }
    }
  });
});