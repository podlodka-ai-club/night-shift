import path from "node:path";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

/**
 * Response contract for the implementer agent. Paths are strictly scoped
 * to repo-relative POSIX paths — no absolute paths, no `..` segments,
 * no backslashes — so the implementer can never write outside the
 * worktree.
 */
const RELATIVE_POSIX_PATH = /^(?!\/)(?!.*\\)(?!.*(^|\/)\.\.(\/|$))[^\s][^\r\n]*$/;

function refineRelativePath(
  val: string,
  ctx: z.RefinementCtx,
): void {
  if (path.isAbsolute(val)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "path must not be absolute",
    });
    return;
  }
  const segments = val.split("/");
  if (segments.some((s) => s === "..")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "path must not contain `..` segments",
    });
  }
  if (val.includes("\\")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "path must use POSIX separators",
    });
  }
}

export const ImplementerFileSchema = z.object({
  path: z
    .string()
    .min(1)
    .regex(RELATIVE_POSIX_PATH, {
      message: "path must be a repo-relative POSIX path",
    })
    .superRefine(refineRelativePath),
  content: z.string(),
});

export const ImplementerResponseSchema = z
  .object({
    filesWritten: z.array(ImplementerFileSchema).min(1, {
      message: "at least one file must be written",
    }),
    commitMessage: z.string().min(1),
    summary: z.string().min(1),
    followUps: z.array(z.string()).optional(),
  })
  .superRefine((val, ctx) => {
    const paths = new Set(val.filesWritten.map((f) => f.path));
    if (paths.size !== val.filesWritten.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "duplicate file paths in filesWritten",
        path: ["filesWritten"],
      });
    }
  });
export type ImplementerResponse = z.infer<typeof ImplementerResponseSchema>;

export const ImplementerResponseJsonSchema = zodToJsonSchema(
  ImplementerResponseSchema,
  { name: "ImplementerResponse", $refStrategy: "none" },
);
