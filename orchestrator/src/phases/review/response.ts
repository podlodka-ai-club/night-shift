import { z } from 'zod';
import { z as zodV3 } from 'zod/v3';

export const findingSchema = z.object({
  severity: z.enum(['error', 'warning']),
  message: z.string().min(1),
  location: z.object({
    file: z.string().min(1),
    line: z.number().int().positive().optional(),
  }).optional(),
  specRef: z.string().optional(),
});

const reviewerFindingInputSchema = z.object({
  severity: findingSchema.shape.severity,
  message: findingSchema.shape.message,
  location: z.object({
    file: z.string().min(1),
    line: z.number().int().positive().nullable().optional(),
  }).nullable().optional(),
  specRef: z.string().nullable().optional(),
});

const reviewerResponseInputSchema = z.object({
  summary: z.string().min(1),
  findings: z.array(reviewerFindingInputSchema),
});

export const reviewerResponseSchema = z.object({
  summary: z.string().min(1),
  findings: z.array(findingSchema),
});

export const reviewerResponseJsonSchemaSource = zodV3.object({
  summary: zodV3.string().min(1),
  findings: zodV3.array(zodV3.object({
    severity: zodV3.enum(['error', 'warning']),
    message: zodV3.string().min(1),
    location: zodV3.object({
      file: zodV3.string().min(1),
      line: zodV3.number().int().min(1).nullable().optional(),
    }).nullable().optional(),
    specRef: zodV3.string().nullable().optional(),
  })),
});

export type Finding = z.infer<typeof findingSchema>;
export type ReviewerResponse = z.infer<typeof reviewerResponseSchema>;

export function parseReviewerResponse(value: unknown): ReviewerResponse {
  const parsed = reviewerResponseInputSchema.parse(value);
  return reviewerResponseSchema.parse({
    summary: parsed.summary,
    findings: parsed.findings.map((finding) => ({
      severity: finding.severity,
      message: finding.message,
      ...(finding.location
        ? {
            location: {
              file: finding.location.file,
              ...(finding.location.line === null || finding.location.line === undefined ? {} : { line: finding.location.line }),
            },
          }
        : {}),
      ...(finding.specRef === null || finding.specRef === undefined ? {} : { specRef: finding.specRef }),
    })),
  });
}