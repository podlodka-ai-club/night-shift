import { z } from 'zod';
import { z as zodV3 } from 'zod/v3';

const MAX_ROOT_CAUSE_SUMMARY_LENGTH = 400;
const MAX_EVIDENCE_ITEMS = 8;
const MAX_EVIDENCE_ITEM_LENGTH = 300;
const MAX_RESOLUTION_SUMMARY_LENGTH = 800;
const MAX_FILE_COUNT = 20;
const MAX_FILE_CONTENT_LENGTH = 20_000;
const MAX_COMMIT_MESSAGE_LENGTH = 200;
const MAX_VALIDATION_PLAN_ITEMS = 8;
const MAX_VALIDATION_PLAN_ITEM_LENGTH = 300;
const MAX_HUMAN_REQUEST_LENGTH = 400;
const MAX_ISSUE_COMMENT_LENGTH = 4_000;

const RELATIVE_POSIX_PATH = /^(?!\/)(?!.*\\)(?!.*(^|\/)\.\.(\/|$))[^\s][^\r\n]*$/;
const FORBIDDEN_PATH_SEGMENTS = new Set(['.git', 'node_modules', '.pnpm-store', '.npm', '.yarn', '.ssh', '.aws']);
const FORBIDDEN_BASENAME_PATTERNS = [/^\.env(?:\..+)?$/i, /\.pem$/i, /\.key$/i, /^id_[a-z0-9_-]+$/i];

function refineRelativePath(value: string, ctx: z.RefinementCtx | zodV3.RefinementCtx): void {
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) {
    ctx.addIssue({ code: 'custom', message: 'path must not be absolute' });
    return;
  }

  if (value.includes('\\')) {
    ctx.addIssue({ code: 'custom', message: 'path must use POSIX separators' });
  }

  const segments = value.split('/');
  if (segments.some((segment) => segment === '..')) {
    ctx.addIssue({ code: 'custom', message: 'path must not contain `..` segments' });
  }
  if (segments.some((segment) => FORBIDDEN_PATH_SEGMENTS.has(segment))) {
    ctx.addIssue({ code: 'custom', message: 'path must not target .git, dependency caches, or credential directories' });
  }

  const basename = segments.at(-1) ?? value;
  if (FORBIDDEN_BASENAME_PATTERNS.some((pattern) => pattern.test(basename))) {
    ctx.addIssue({ code: 'custom', message: 'path must not target credential-like files' });
  }
}

function refineDuplicateFilePaths(
  value: { resolution: { files: Array<{ path: string }> } },
  ctx: z.RefinementCtx | zodV3.RefinementCtx,
): void {
  const paths = new Set(value.resolution.files.map((file) => file.path));
  if (paths.size !== value.resolution.files.length) {
    ctx.addIssue({
      code: 'custom',
      message: 'duplicate file paths in resolution.files',
      path: ['resolution', 'files'],
    });
  }
}

function refineOutcomeConstraints(
  value: { outcome: 'resolved' | 'needs_human'; confidence: 'high' | 'medium' | 'low'; humanRequest?: unknown },
  ctx: z.RefinementCtx | zodV3.RefinementCtx,
): void {
  if (value.outcome === 'resolved' && value.confidence === 'low') {
    ctx.addIssue({
      code: 'custom',
      message: 'resolved outcomes require high or medium confidence',
      path: ['confidence'],
    });
  }

  if (value.outcome === 'needs_human' && value.humanRequest === undefined) {
    ctx.addIssue({
      code: 'custom',
      message: 'needs_human outcomes require humanRequest',
      path: ['humanRequest'],
    });
  }
}

const escalationFileSchema = z.object({
  path: z.string().min(1).regex(RELATIVE_POSIX_PATH, {
    message: 'path must be a repo-relative POSIX path',
  }).superRefine(refineRelativePath),
  content: z.string().max(MAX_FILE_CONTENT_LENGTH),
});

const escalationRootCauseSchema = z.object({
  category: z.enum([
    'missing_spec_context',
    'spec_validation_failure',
    'agent_contract_failure',
    'quality_gate_failure',
    'review_findings',
    'infrastructure_failure',
    'ambiguous_requirement',
    'external_dependency',
    'unknown',
  ]),
  summary: z.string().min(1).max(MAX_ROOT_CAUSE_SUMMARY_LENGTH),
  evidence: z.array(z.string().min(1).max(MAX_EVIDENCE_ITEM_LENGTH)).max(MAX_EVIDENCE_ITEMS),
});

const escalationResolutionSchema = z.object({
  summary: z.string().min(1).max(MAX_RESOLUTION_SUMMARY_LENGTH),
  files: z.array(escalationFileSchema).max(MAX_FILE_COUNT),
  commitMessage: z.string().min(1).max(MAX_COMMIT_MESSAGE_LENGTH).optional(),
  validationPlan: z.array(z.string().min(1).max(MAX_VALIDATION_PLAN_ITEM_LENGTH)).max(MAX_VALIDATION_PLAN_ITEMS),
  resumeStatus: z.enum(['Backlog', 'Ready', 'In review']),
});

const escalationHumanRequestSchema = z.object({
  question: z.string().min(1).max(MAX_HUMAN_REQUEST_LENGTH),
  recommendedStatusAfterAnswer: z.enum(['Backlog', 'Ready', 'In review']),
});

const escalationResponseInputSchema = z.object({
  outcome: z.enum(['resolved', 'needs_human']),
  originPhase: z.enum(['specify', 'implement', 'review']),
  confidence: z.enum(['high', 'medium', 'low']),
  rootCause: escalationRootCauseSchema,
  resolution: z.object({
    summary: escalationResolutionSchema.shape.summary,
    files: escalationResolutionSchema.shape.files,
    commitMessage: escalationResolutionSchema.shape.commitMessage.nullable().optional(),
    validationPlan: escalationResolutionSchema.shape.validationPlan,
    resumeStatus: escalationResolutionSchema.shape.resumeStatus.nullable().optional(),
  }),
  humanRequest: escalationHumanRequestSchema.nullable().optional(),
  issueComment: z.string().min(1).max(MAX_ISSUE_COMMENT_LENGTH),
});

export const escalationResponseSchema = z
  .object({
    outcome: z.enum(['resolved', 'needs_human']),
    originPhase: z.enum(['specify', 'implement', 'review']),
    confidence: z.enum(['high', 'medium', 'low']),
    rootCause: escalationRootCauseSchema,
    resolution: escalationResolutionSchema,
    humanRequest: escalationHumanRequestSchema.optional(),
    issueComment: z.string().min(1).max(MAX_ISSUE_COMMENT_LENGTH),
  })
  .superRefine(refineDuplicateFilePaths)
  .superRefine(refineOutcomeConstraints);

export const escalationResponseJsonSchemaSource = zodV3
  .object({
    outcome: zodV3.enum(['resolved', 'needs_human']),
    originPhase: zodV3.enum(['specify', 'implement', 'review']),
    confidence: zodV3.enum(['high', 'medium', 'low']),
    rootCause: zodV3.object({
      category: zodV3.enum([
        'missing_spec_context',
        'spec_validation_failure',
        'agent_contract_failure',
        'quality_gate_failure',
        'review_findings',
        'infrastructure_failure',
        'ambiguous_requirement',
        'external_dependency',
        'unknown',
      ]),
      summary: zodV3.string().min(1).max(MAX_ROOT_CAUSE_SUMMARY_LENGTH),
      evidence: zodV3.array(zodV3.string().min(1).max(MAX_EVIDENCE_ITEM_LENGTH)).max(MAX_EVIDENCE_ITEMS),
    }),
    resolution: zodV3.object({
      summary: zodV3.string().min(1).max(MAX_RESOLUTION_SUMMARY_LENGTH),
      files: zodV3.array(zodV3.object({
        path: zodV3.string().min(1).regex(RELATIVE_POSIX_PATH, {
          message: 'path must be a repo-relative POSIX path',
        }).superRefine(refineRelativePath),
        content: zodV3.string().max(MAX_FILE_CONTENT_LENGTH),
      })).max(MAX_FILE_COUNT),
      commitMessage: zodV3.string().min(1).max(MAX_COMMIT_MESSAGE_LENGTH).nullable().optional(),
      validationPlan: zodV3.array(zodV3.string().min(1).max(MAX_VALIDATION_PLAN_ITEM_LENGTH)).max(MAX_VALIDATION_PLAN_ITEMS),
      resumeStatus: zodV3.enum(['Backlog', 'Ready', 'In review']).nullable().optional(),
    }),
    humanRequest: zodV3.object({
      question: zodV3.string().min(1).max(MAX_HUMAN_REQUEST_LENGTH),
      recommendedStatusAfterAnswer: zodV3.enum(['Backlog', 'Ready', 'In review']),
    }).nullable().optional(),
    issueComment: zodV3.string().min(1).max(MAX_ISSUE_COMMENT_LENGTH),
  })
  .superRefine(refineDuplicateFilePaths)
  .superRefine(refineOutcomeConstraints);

export type EscalationResponse = z.infer<typeof escalationResponseSchema>;

export function parseEscalationResponse(value: unknown): EscalationResponse {
  const parsed = escalationResponseInputSchema.parse(value);
  return escalationResponseSchema.parse({
    outcome: parsed.outcome,
    originPhase: parsed.originPhase,
    confidence: parsed.confidence,
    rootCause: parsed.rootCause,
    resolution: {
      summary: parsed.resolution.summary,
      files: parsed.resolution.files,
      validationPlan: parsed.resolution.validationPlan,
      resumeStatus: parsed.resolution.resumeStatus ?? deriveResumeStatus(parsed.originPhase),
      ...(parsed.resolution.commitMessage === null || parsed.resolution.commitMessage === undefined
        ? {}
        : { commitMessage: parsed.resolution.commitMessage }),
    },
    ...(parsed.humanRequest === null || parsed.humanRequest === undefined
      ? {}
      : { humanRequest: parsed.humanRequest }),
    issueComment: parsed.issueComment,
  });
}

function deriveResumeStatus(originPhase: 'specify' | 'implement' | 'review'): 'Backlog' | 'Ready' | 'In review' {
  switch (originPhase) {
    case 'specify':
      return 'Backlog';
    case 'implement':
      return 'Ready';
    case 'review':
      return 'In review';
  }
}