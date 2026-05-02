import assert from 'assert';
import { describe, it } from 'mocha';
import { getAgentSchema } from '../agent-schema-registry';
import { implementResponseJsonSchemaSource, implementResponseSchema, parseImplementResponse } from '../phases/implement/response';
import { parseReviewerResponse, reviewerResponseJsonSchemaSource, reviewerResponseSchema } from '../phases/review/response';
import { parseSpecifyResponse, specifyResponseJsonSchemaSource, specifyResponseSchema } from '../phases/specify/response';

describe('phase response contracts', () => {
  describe('SpecifyResponse', () => {
    it('accepts the donor-compatible spec bundle shape', () => {
      const result = parseSpecifyResponse({
        files: [
          { path: 'proposal.md', content: '# Proposal' },
          { path: 'tasks.md', content: '- [ ] Do the thing' },
          { path: 'specs/deterministic-phases/spec.md', content: '## ADDED Requirements' },
        ],
        openQuestions: [],
        assumptions: ['GitHub auth is configured'],
        risks: ['Spec may need follow-up review'],
      });

      assert.strictEqual(result.files[2]?.path, 'specs/deterministic-phases/spec.md');
    });

    it('rejects missing required files and duplicate file paths', () => {
      assert.throws(
        () => parseSpecifyResponse({
          files: [
            { path: 'proposal.md', content: '# Proposal' },
            { path: 'proposal.md', content: '# Duplicate' },
          ],
          openQuestions: [],
          assumptions: [],
          risks: [],
        }),
        /missing required file tasks\.md|duplicate file paths/i,
      );
    });

    it('keeps the parser and json-schema source aligned on representative cases', () => {
      const cases: Array<{ label: string; input: unknown }> = [
        {
          label: 'valid response',
          input: {
            files: [
              { path: 'proposal.md', content: '# Proposal' },
              { path: 'tasks.md', content: '- [ ] Task' },
            ],
            openQuestions: [],
            assumptions: [],
            risks: [],
          },
        },
        {
          label: 'invalid file path',
          input: {
            files: [
              { path: 'notes.txt', content: 'nope' },
              { path: 'tasks.md', content: '- [ ] Task' },
            ],
            openQuestions: [],
            assumptions: [],
            risks: [],
          },
        },
        {
          label: 'missing tasks file',
          input: {
            files: [{ path: 'proposal.md', content: '# Proposal' }],
            openQuestions: [],
            assumptions: [],
            risks: [],
          },
        },
      ];

      for (const testCase of cases) {
        const parseResult = specifyResponseSchema.safeParse(testCase.input);
        const jsonSourceResult = specifyResponseJsonSchemaSource.safeParse(testCase.input);
        assert.strictEqual(parseResult.success, jsonSourceResult.success, testCase.label);
      }
    });
  });

  describe('ImplementResponse', () => {
    it('accepts repo-relative POSIX paths', () => {
      const result = parseImplementResponse({
        filesWritten: [{ path: 'src/phases/runtime.ts', content: 'export const ok = true;\n' }],
        commitMessage: 'feat: add runtime helper',
        summary: 'Adds the runtime helper.',
        followUps: ['Add phase orchestration wiring'],
      });

      assert.strictEqual(result.filesWritten[0]?.path, 'src/phases/runtime.ts');
    });

    it('rejects absolute paths, parent traversal, and duplicates', () => {
      for (const invalidPath of ['/tmp/bad.ts', '../bad.ts']) {
        assert.throws(
          () => parseImplementResponse({
            filesWritten: [{ path: invalidPath, content: 'x' }],
            commitMessage: 'feat: invalid path',
            summary: 'Should fail.',
            followUps: [],
          }),
          /repo-relative POSIX path|must not be absolute|must not contain `..` segments/i,
        );
      }

      assert.throws(
        () => parseImplementResponse({
          filesWritten: [
            { path: 'src/a.ts', content: 'a' },
            { path: 'src/a.ts', content: 'b' },
          ],
          commitMessage: 'feat: duplicate writes',
          summary: 'Should fail.',
          followUps: [],
        }),
        /duplicate file paths/i,
      );
    });

    it('keeps the parser and json-schema source aligned on representative cases', () => {
      const cases: Array<{ label: string; input: unknown }> = [
        {
          label: 'valid response',
          input: {
            filesWritten: [{ path: 'src/phases/runtime.ts', content: 'export const ok = true;\n' }],
            commitMessage: 'feat: add runtime helper',
            summary: 'Adds the runtime helper.',
            followUps: [],
          },
        },
        {
          label: 'absolute path',
          input: {
            filesWritten: [{ path: '/tmp/bad.ts', content: 'x' }],
            commitMessage: 'feat: invalid path',
            summary: 'Should fail.',
            followUps: [],
          },
        },
        {
          label: 'duplicate paths',
          input: {
            filesWritten: [
              { path: 'src/a.ts', content: 'a' },
              { path: 'src/a.ts', content: 'b' },
            ],
            commitMessage: 'feat: duplicate writes',
            summary: 'Should fail.',
            followUps: [],
          },
        },
      ];

      for (const testCase of cases) {
        const parseResult = implementResponseSchema.safeParse(testCase.input);
        const jsonSourceResult = implementResponseJsonSchemaSource.safeParse(testCase.input);
        assert.strictEqual(parseResult.success, jsonSourceResult.success, testCase.label);
      }
    });
  });

  describe('ReviewerResponse', () => {
    it('normalizes nullable provider-facing optional fields', () => {
      const result = parseReviewerResponse({
        summary: 'Needs one fix.',
        findings: [
          {
            severity: 'warning',
            message: 'Consider tightening the helper boundary.',
            location: null,
            specRef: null,
          },
          {
            severity: 'error',
            message: 'Missing validation.',
            location: { file: 'src/workflows.ts', line: 41 },
            specRef: '§Implement',
          },
        ],
      });

      assert.deepStrictEqual(result.findings[0], {
        severity: 'warning',
        message: 'Consider tightening the helper boundary.',
      });
      assert.strictEqual(result.findings[1]?.location?.line, 41);
    });

    it('rejects invalid finding severities', () => {
      assert.throws(
        () => parseReviewerResponse({
          summary: 'Bad response',
          findings: [{ severity: 'info', message: 'not allowed' }],
        }),
        /invalid value|error|warning/i,
      );
    });

    it('keeps the parser and json-schema source aligned on representative cases', () => {
      const cases: Array<{ label: string; input: unknown }> = [
        { label: 'valid response', input: { summary: 'Looks good.', findings: [{ severity: 'warning', message: 'note', location: { file: 'src/index.ts', line: 1 } }] } },
        { label: 'empty location file', input: { summary: 'Bad.', findings: [{ severity: 'error', message: 'missing path', location: { file: '', line: 1 } }] } },
      ];

      for (const testCase of cases) {
        const parseResult = reviewerResponseSchema.safeParse(testCase.input);
        const jsonSourceResult = reviewerResponseJsonSchemaSource.safeParse(testCase.input);
        assert.strictEqual(parseResult.success, jsonSourceResult.success, testCase.label);
      }
    });

    it('generates an OpenAI-compatible line-number schema', () => {
      const jsonSchema = getAgentSchema('reviewer-response-v1').jsonSchema as {
        properties?: {
          findings?: {
            items?: {
              properties?: {
                location?: {
                  anyOf?: Array<{
                    properties?: {
                      line?: { anyOf?: Array<Record<string, unknown>> };
                    };
                  }>;
                };
              };
            };
          };
        };
      };

      const lineSchema = jsonSchema.properties?.findings?.items?.properties?.location?.anyOf?.[0]?.properties?.line?.anyOf?.[0];
      assert.deepStrictEqual(lineSchema, {
        type: 'integer',
        minimum: 1,
      });
    });
  });
});