import assert from 'assert';
import { describe, it } from 'mocha';
import { getAgentSchema } from '../agent-schema-registry';
import {
  escalationResponseJsonSchemaSource,
  escalationResponseSchema,
  parseEscalationResponse,
} from '../phases/escalation/response';

describe('EscalationResponse', () => {
  it('accepts a resolved escalation response with repo-relative file writes', () => {
    const result = parseEscalationResponse({
      outcome: 'resolved',
      originPhase: 'implement',
      confidence: 'high',
      rootCause: {
        category: 'quality_gate_failure',
        summary: 'The quality gate failed because the new helper was never exported.',
        evidence: ['make check failed in TypeScript compile', 'src/index.ts does not re-export the helper'],
      },
      resolution: {
        summary: 'Export the helper and rerun the quality gate.',
        files: [{ path: 'src/index.ts', content: "export * from './runtime';\n" }],
        commitMessage: 'fix: export runtime helper',
        validationPlan: ['Run make check', 'Confirm the existing PR updates cleanly'],
        resumeStatus: 'Ready',
      },
      issueComment: 'Escalation Manager exported the missing helper and will return the ticket to Ready.',
    });

    assert.strictEqual(result.resolution.files[0]?.path, 'src/index.ts');
    assert.strictEqual(result.resolution.resumeStatus, 'Ready');
  });

  it('derives the resume status from originPhase when the provider omits it', () => {
    const result = parseEscalationResponse({
      outcome: 'resolved',
      originPhase: 'review',
      confidence: 'medium',
      rootCause: {
        category: 'review_findings',
        summary: 'The prior inline comment referenced an outdated diff location.',
        evidence: ['Current changed-file list no longer includes the old hunk'],
      },
      resolution: {
        summary: 'Refresh review context and rerun Review only.',
        files: [],
        validationPlan: ['Refresh PR metadata', 'Rerun review phase'],
      },
      issueComment: 'Escalation Manager determined this is a review-only recovery and will return the ticket to In review.',
    });

    assert.strictEqual(result.resolution.resumeStatus, 'In review');
  });

  it('rejects forbidden paths, duplicate writes, and credential-like targets', () => {
    for (const invalidPath of ['.git/config', 'node_modules/pkg/index.js', '.env', '/tmp/bad.ts']) {
      assert.throws(
        () => parseEscalationResponse({
          outcome: 'resolved',
          originPhase: 'implement',
          confidence: 'high',
          rootCause: {
            category: 'quality_gate_failure',
            summary: 'Bad path.',
            evidence: ['Validation reported an issue.'],
          },
          resolution: {
            summary: 'Attempt a fix.',
            files: [{ path: invalidPath, content: 'x' }],
            validationPlan: ['Run make check'],
            resumeStatus: 'Ready',
          },
          issueComment: 'Should fail.',
        }),
        /repo-relative POSIX path|must not be absolute|must not target/i,
      );
    }

    assert.throws(
      () => parseEscalationResponse({
        outcome: 'resolved',
        originPhase: 'implement',
        confidence: 'high',
        rootCause: {
          category: 'quality_gate_failure',
          summary: 'Duplicate writes.',
          evidence: ['The same file was listed twice.'],
        },
        resolution: {
          summary: 'Attempt a fix.',
          files: [
            { path: 'src/index.ts', content: 'a' },
            { path: 'src/index.ts', content: 'b' },
          ],
          validationPlan: ['Run make check'],
          resumeStatus: 'Ready',
        },
        issueComment: 'Should fail.',
      }),
      /duplicate file paths/i,
    );
  });

  it('rejects low-confidence resolved outcomes and missing human requests', () => {
    assert.throws(
      () => parseEscalationResponse({
        outcome: 'resolved',
        originPhase: 'specify',
        confidence: 'low',
        rootCause: {
          category: 'ambiguous_requirement',
          summary: 'Unsure how to proceed.',
          evidence: ['The ticket is ambiguous.'],
        },
        resolution: {
          summary: 'Guess a path anyway.',
          files: [],
          validationPlan: ['Rerun Specify'],
          resumeStatus: 'Backlog',
        },
        issueComment: 'Should fail.',
      }),
      /high or medium confidence/i,
    );

    assert.throws(
      () => parseEscalationResponse({
        outcome: 'needs_human',
        originPhase: 'specify',
        confidence: 'low',
        rootCause: {
          category: 'ambiguous_requirement',
          summary: 'Product direction is unclear.',
          evidence: ['The ticket and comments conflict.'],
        },
        resolution: {
          summary: 'No safe automated action.',
          files: [],
          validationPlan: [],
          resumeStatus: 'Backlog',
        },
        issueComment: 'Need a human decision.',
      }),
      /require humanRequest/i,
    );
  });

  it('keeps parser, json-schema source, and registry aligned on representative cases', () => {
    const cases: Array<{ label: string; input: unknown }> = [
      {
        label: 'valid human fallback',
        input: {
          outcome: 'needs_human',
          originPhase: 'review',
          confidence: 'low',
          rootCause: {
            category: 'external_dependency',
            summary: 'The PR depends on an external outage being resolved.',
            evidence: ['The upstream API is returning 503s.'],
          },
          resolution: {
            summary: 'No repository change is safe until the outage clears.',
            files: [],
            validationPlan: [],
            resumeStatus: 'In review',
          },
          humanRequest: {
            question: 'Wait for the upstream service to recover, then move the ticket back to In review.',
            recommendedStatusAfterAnswer: 'In review',
          },
          issueComment: 'Escalation Manager needs a human to decide how to handle the upstream outage.',
        },
      },
      {
        label: 'invalid credential path',
        input: {
          outcome: 'resolved',
          originPhase: 'implement',
          confidence: 'high',
          rootCause: {
            category: 'quality_gate_failure',
            summary: 'Invalid output.',
            evidence: ['Credential path proposed.'],
          },
          resolution: {
            summary: 'Bad fix.',
            files: [{ path: '.env.production', content: 'SECRET=1' }],
            validationPlan: ['Run make check'],
          },
          issueComment: 'Should fail.',
        },
      },
    ];

    for (const testCase of cases) {
      const parseResult = escalationResponseSchema.safeParse(testCase.input);
      const jsonSourceResult = escalationResponseJsonSchemaSource.safeParse(testCase.input);
      assert.strictEqual(parseResult.success, jsonSourceResult.success, testCase.label);
    }

    const schema = getAgentSchema('escalation-response-v1');
    assert.ok(schema.jsonSchema);
  });
});