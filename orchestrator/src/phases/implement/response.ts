import path from 'node:path';
import { z } from 'zod';
import { z as zodV3 } from 'zod/v3';

const RELATIVE_POSIX_PATH = /^(?!\/)(?!.*\\)(?!.*(^|\/)\.\.(\/|$))[^\s][^\r\n]*$/;

function refineRelativePath(value: string, ctx: z.RefinementCtx | zodV3.RefinementCtx): void {
  if (path.isAbsolute(value)) {
    ctx.addIssue({ code: 'custom', message: 'path must not be absolute' });
    return;
  }
  if (value.split('/').some((segment) => segment === '..')) {
    ctx.addIssue({ code: 'custom', message: 'path must not contain `..` segments' });
  }
  if (value.includes('\\')) {
    ctx.addIssue({ code: 'custom', message: 'path must use POSIX separators' });
  }
}

function refineDuplicateImplementPaths(
  value: { filesWritten: Array<{ path: string }> },
  ctx: z.RefinementCtx | zodV3.RefinementCtx,
): void {
  const paths = new Set(value.filesWritten.map((file) => file.path));
  if (paths.size !== value.filesWritten.length) {
    ctx.addIssue({
      code: 'custom',
      message: 'duplicate file paths in filesWritten',
      path: ['filesWritten'],
    });
  }
}

const implementerFileSchema = z.object({
  path: z.string().min(1).regex(RELATIVE_POSIX_PATH, {
    message: 'path must be a repo-relative POSIX path',
  }).superRefine(refineRelativePath),
  content: z.string(),
});

export const implementResponseSchema = z
  .object({
    filesWritten: z.array(implementerFileSchema),
    commitMessage: z.string().min(1),
    summary: z.string().min(1),
    followUps: z.array(z.string()),
  })
  .superRefine(refineDuplicateImplementPaths);

export const implementResponseJsonSchemaSource = zodV3
  .object({
    filesWritten: zodV3.array(zodV3.object({
      path: zodV3.string().min(1).regex(RELATIVE_POSIX_PATH, {
        message: 'path must be a repo-relative POSIX path',
      }).superRefine(refineRelativePath),
      content: zodV3.string(),
    })),
    commitMessage: zodV3.string().min(1),
    summary: zodV3.string().min(1),
    followUps: zodV3.array(zodV3.string()),
  })
  .superRefine(refineDuplicateImplementPaths);

export type ImplementResponse = z.infer<typeof implementResponseSchema>;

export function parseImplementResponse(value: unknown): ImplementResponse {
  return implementResponseSchema.parse(value);
}