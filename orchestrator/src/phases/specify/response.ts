import { z } from 'zod';
import { z as zodV3 } from 'zod/v3';

const ALLOWED_PATH = /^(proposal|design|tasks)\.md$|^specs\/[a-z0-9-]+\/spec\.md$/;

const REQUIRED_SPECIFY_FILE_PATHS = ['proposal.md', 'tasks.md'] as const;

function refineSpecifyFiles(
  value: { files: Array<{ path: string }> },
  ctx: z.RefinementCtx | zodV3.RefinementCtx,
): void {
  const paths = new Set(value.files.map((file) => file.path));
  for (const requiredPath of REQUIRED_SPECIFY_FILE_PATHS) {
    if (!paths.has(requiredPath)) {
      ctx.addIssue({
        code: 'custom',
        message: `missing required file ${requiredPath}`,
        path: ['files'],
      });
    }
  }

  if (paths.size !== value.files.length) {
    ctx.addIssue({
      code: 'custom',
      message: 'duplicate file paths',
      path: ['files'],
    });
  }
}

export const specifyResponseSchema = z
  .object({
    files: z.array(
      z.object({
        path: z.string().regex(ALLOWED_PATH, {
          message: 'path must be proposal.md, design.md, tasks.md, or specs/<capability>/spec.md',
        }),
        content: z.string().min(1),
      }),
    ).min(1),
    openQuestions: z.array(z.string()),
    assumptions: z.array(z.string()),
    risks: z.array(z.string()),
  })
  .superRefine(refineSpecifyFiles);

export const specifyResponseJsonSchemaSource = zodV3
  .object({
    files: zodV3.array(
      zodV3.object({
        path: zodV3.string().regex(ALLOWED_PATH, {
          message: 'path must be proposal.md, design.md, tasks.md, or specs/<capability>/spec.md',
        }),
        content: zodV3.string().min(1),
      }),
    ).min(1),
    openQuestions: zodV3.array(zodV3.string()),
    assumptions: zodV3.array(zodV3.string()),
    risks: zodV3.array(zodV3.string()),
  })
  .superRefine(refineSpecifyFiles);

export type SpecifyResponse = z.infer<typeof specifyResponseSchema>;

export function parseSpecifyResponse(value: unknown): SpecifyResponse {
  return specifyResponseSchema.parse(value);
}