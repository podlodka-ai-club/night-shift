import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

/**
 * Response contract the specifier agent MUST return as a JSON object in its
 * final message. We enforce this both via `TurnOpts.outputSchema` (hint to
 * the model/runtime) and via `SpecifierResponseSchema.parse` (runtime guard).
 *
 * `files[].path` is restricted to the files we allow under a change folder,
 * plus a single `specs/<capability>/spec.md` delta. Everything else is
 * rejected so the agent cannot accidentally modify unrelated paths.
 */
const ALLOWED_PATH =
  /^(proposal|design|tasks)\.md$|^specs\/[a-z0-9-]+\/spec\.md$/;

export const SpecifierFileSchema = z.object({
  path: z.string().regex(ALLOWED_PATH, {
    message:
      "path must be proposal.md, design.md, tasks.md, or specs/<capability>/spec.md",
  }),
  content: z.string().min(1),
});

export const SpecifierResponseSchema = z
  .object({
    files: z.array(SpecifierFileSchema).min(1),
    openQuestions: z.array(z.string()),
    assumptions: z.array(z.string()),
    risks: z.array(z.string()),
  })
  .superRefine((val, ctx) => {
    const paths = new Set(val.files.map((f) => f.path));
    for (const required of ["proposal.md", "tasks.md"]) {
      if (!paths.has(required)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `missing required file ${required}`,
          path: ["files"],
        });
      }
    }
    if (paths.size !== val.files.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "duplicate file paths",
        path: ["files"],
      });
    }
  });

export type SpecifierResponse = z.infer<typeof SpecifierResponseSchema>;

/**
 * JSON-Schema projection for `TurnOpts.outputSchema`.
 *
 * Omitting a schema name keeps the result as a plain top-level object schema
 * instead of a `$ref` wrapper under `definitions`, which the Codex API rejects.
 */
export const SpecifierResponseJsonSchema = zodToJsonSchema(
  SpecifierResponseSchema,
  { $refStrategy: "none" },
);
