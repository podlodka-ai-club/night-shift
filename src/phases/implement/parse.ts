import { ImplementAgentError } from "./errors.js";
import {
  ImplementerResponseSchema,
  type ImplementerResponse,
} from "./response.js";

export interface ParseCtx {
  ticketId?: string;
  latencyMs?: number;
  worktreePath?: string;
}

function commonOpts(ctx: ParseCtx, cause: unknown) {
  return {
    ...(ctx.ticketId !== undefined ? { ticketId: ctx.ticketId } : {}),
    ...(ctx.latencyMs !== undefined ? { latencyMs: ctx.latencyMs } : {}),
    ...(ctx.worktreePath !== undefined ? { worktreePath: ctx.worktreePath } : {}),
    cause,
  };
}

export function parseImplementerResponse(
  finalText: string,
  ctx: ParseCtx = {},
): ImplementerResponse {
  let raw: unknown;
  try {
    raw = JSON.parse(finalText);
  } catch (err) {
    throw new ImplementAgentError(
      "parse",
      `implementer final message was not valid JSON: ${(err as Error).message}`,
      commonOpts(ctx, err),
    );
  }
  const parsed = ImplementerResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ImplementAgentError(
      "schema",
      `implementer response failed schema validation: ${parsed.error.message}`,
      commonOpts(ctx, parsed.error),
    );
  }
  return parsed.data;
}
