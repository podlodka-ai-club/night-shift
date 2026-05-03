import { z } from 'zod';

export const recordedUsageSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  cached_input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
});

export type RecordedUsage = z.infer<typeof recordedUsageSchema>;

export const ZERO_RECORDED_USAGE: RecordedUsage = {
  input_tokens: 0,
  cached_input_tokens: 0,
  output_tokens: 0,
};

export function totalRecordedTokens(usage: RecordedUsage | undefined): number {
  if (!usage) {
    return 0;
  }
  return usage.input_tokens + usage.output_tokens;
}

export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}