import { SpecifyAgentError } from "./errors.js";
import { SpecifierResponseSchema, type SpecifierResponse } from "./response.js";

/**
 * Parse the final agent text into a validated `SpecifierResponse`. Errors
 * distinguish JSON-shape failures (`parse`) from contract violations (`schema`)
 * so callers can decide whether to retry or surface to the operator.
 */
export function parseResponse(
  finalText: string,
  ctx: { ticketId?: string; latencyMs?: number } = {},
): SpecifierResponse {
  let raw: unknown;
  try {
    raw = JSON.parse(finalText);
  } catch (err) {
    throw new SpecifyAgentError(
      "parse",
      `specifier final message was not valid JSON: ${(err as Error).message}`,
      {
        ...(ctx.ticketId !== undefined ? { ticketId: ctx.ticketId } : {}),
        ...(ctx.latencyMs !== undefined ? { latencyMs: ctx.latencyMs } : {}),
        cause: err,
      },
    );
  }
  const parsed = SpecifierResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new SpecifyAgentError(
      "schema",
      `specifier response failed schema validation: ${parsed.error.message}`,
      {
        ...(ctx.ticketId !== undefined ? { ticketId: ctx.ticketId } : {}),
        ...(ctx.latencyMs !== undefined ? { latencyMs: ctx.latencyMs } : {}),
        cause: parsed.error,
      },
    );
  }
  return parsed.data;
}
