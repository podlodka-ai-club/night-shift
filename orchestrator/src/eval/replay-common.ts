import { z } from 'zod';

export const recordedUsageSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  cached_input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
});

export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}