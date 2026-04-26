import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { FindingSchema, type Finding } from "../../contracts/review.js";
import type { Ticket } from "../../contracts/ticket.js";
import type { ChangedFile, ReviewComment } from "../../github/types.js";
import { ReviewAgentError, type ReviewErrorOpts } from "./errors.js";

export const ReviewerResponseSchema = z.object({
  summary: z.string().min(1),
  findings: z.array(FindingSchema),
});
export type ReviewerResponse = z.infer<typeof ReviewerResponseSchema>;

const ReviewerFindingInputSchema = z.object({
  severity: FindingSchema.shape.severity,
  message: FindingSchema.shape.message,
  location: z
    .object({
      file: z.string().min(1),
      line: z.number().int().positive().nullable().optional(),
    })
    .nullable()
    .optional(),
  specRef: z.string().nullable().optional(),
});

const ReviewerResponseInputSchema = z.object({
  summary: z.string().min(1),
  findings: z.array(ReviewerFindingInputSchema),
});

// Codex requires object schemas to list every property in `required`, so the
// provider-facing schema uses explicit nulls where the app contract is optional.
const ReviewerOutputSchema = z.object({
  summary: z.string().min(1),
  findings: z.array(
    z.object({
      severity: FindingSchema.shape.severity,
      message: FindingSchema.shape.message,
      location: z
        .object({
          file: z.string().min(1),
          line: z.number().int().positive().nullable(),
        })
        .nullable(),
      specRef: z.string().nullable(),
    }),
  ),
});

export const ReviewerResponseJsonSchema = zodToJsonSchema(
  ReviewerOutputSchema,
  { $refStrategy: "none" },
);

export interface SpecBundleFile {
  path: string;
  content: string;
}

export interface RetryContext {
  previousError: string;
  attempt: number;
}

const NIGHT_SHIFT_MARKER_PREFIX = "<!-- night-shift:marker=";

function normalizeFinding(input: z.infer<typeof ReviewerFindingInputSchema>): Finding {
  return {
    severity: input.severity,
    message: input.message,
    ...(input.location
      ? {
          location: {
            file: input.location.file,
            ...(input.location.line === null || input.location.line === undefined
              ? {}
              : { line: input.location.line }),
          },
        }
      : {}),
    ...(input.specRef === null || input.specRef === undefined
      ? {}
      : { specRef: input.specRef }),
  };
}

function renderTicket(ticket: Ticket): string {
  const parts: string[] = [];
  parts.push(`# Ticket ${ticket.id}: ${ticket.title}`);
  parts.push("");
  parts.push(`URL: ${ticket.url}`);
  if (ticket.labels.length > 0) parts.push(`Labels: ${ticket.labels.join(", ")}`);
  parts.push("");
  parts.push("## Description");
  parts.push(ticket.description.trim() || "_(no description provided)_");
  return parts.join("\n");
}

function renderSpecBundle(bundle: SpecBundleFile[]): string {
  const parts: string[] = [];
  parts.push("## Spec bundle");
  for (const f of bundle) {
    parts.push(`### ${f.path}`);
    parts.push("```markdown");
    parts.push(f.content);
    parts.push("```");
    parts.push("");
  }
  return parts.join("\n");
}

function renderDiff(
  diff: string,
  maxDiffBytes: number,
  changedFiles: ChangedFile[],
): string {
  const parts: string[] = [];
  parts.push("## PR Diff");

  if (Buffer.byteLength(diff, "utf8") <= maxDiffBytes) {
    parts.push("```diff");
    parts.push(diff);
    parts.push("```");
  } else {
    const truncated = Buffer.from(diff, "utf8").subarray(0, maxDiffBytes).toString("utf8");
    parts.push("```diff");
    parts.push(truncated);
    parts.push("```");
    parts.push("");
    parts.push(
      `<!-- diff truncated at ${maxDiffBytes} bytes; full diff available via listChangedFiles -->`,
    );
    parts.push("");
    parts.push("### Changed files breakdown");
    parts.push("| File | Additions | Deletions |");
    parts.push("| --- | --- | --- |");
    for (const f of changedFiles) {
      parts.push(`| ${f.path} | +${f.additions} | -${f.deletions} |`);
    }
  }
  return parts.join("\n");
}

function renderReviewComments(comments: ReviewComment[]): string {
  const filtered = comments.filter(
    (c) => !c.body.startsWith(NIGHT_SHIFT_MARKER_PREFIX),
  );
  if (filtered.length === 0) return "";
  const parts: string[] = ["## Existing review comments"];
  for (const c of filtered) {
    parts.push(`- **${c.path}${c.line ? `:${c.line}` : ""}**: ${c.body.trim()}`);
  }
  return parts.join("\n");
}

export function renderReviewerMessage(
  ticket: Ticket,
  specBundle: SpecBundleFile[],
  diff: string,
  changedFiles: ChangedFile[],
  reviewComments: ReviewComment[],
  maxDiffBytes: number,
  retryContext?: RetryContext,
): string {
  const parts: string[] = [];
  parts.push(renderTicket(ticket));
  parts.push("");
  parts.push(renderSpecBundle(specBundle));
  parts.push(renderDiff(diff, maxDiffBytes, changedFiles));
  const commentsBlock = renderReviewComments(reviewComments);
  if (commentsBlock) {
    parts.push("");
    parts.push(commentsBlock);
  }
  if (retryContext) {
    parts.push("");
    parts.push("## Retry feedback");
    parts.push(
      `Previous attempt #${retryContext.attempt} failed with: ${retryContext.previousError}`,
    );
    parts.push("Please address this before resubmitting.");
  }
  parts.push("");
  parts.push("## Response");
  parts.push(
    "Return a JSON object with keys: `summary` (string, non-empty) and `findings` (array of Finding objects).",
  );
  parts.push(
    "Each Finding has: `severity` (\"error\" | \"warning\"), `message` (string), optional `location` ({file, line?}), optional `specRef` (string).",
  );
  return parts.join("\n");
}

export function parseReviewerResponse(
  finalText: string,
  ctx: ReviewErrorOpts = {},
): ReviewerResponse {
  let raw: unknown;
  try {
    raw = JSON.parse(finalText);
  } catch (err) {
    throw new ReviewAgentError(
      "parse",
      `reviewer final message was not valid JSON: ${(err as Error).message}`,
      { ...ctx, cause: err },
    );
  }
  const parsed = ReviewerResponseInputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ReviewAgentError(
      "schema",
      `reviewer response failed schema validation: ${parsed.error.message}`,
      { ...ctx, cause: parsed.error },
    );
  }
  return {
    summary: parsed.data.summary,
    findings: parsed.data.findings.map(normalizeFinding),
  };
}
