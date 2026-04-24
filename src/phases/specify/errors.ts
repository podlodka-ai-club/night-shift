/**
 * Error taxonomy for the Specify phase. All phase errors subclass
 * `SpecifyPhaseError` so callers can `instanceof`-check a single base
 * while still discriminating by stable `code` strings for telemetry.
 */
export type SpecifyErrorCode =
  | "item_missing"
  | "agent"
  | "validation"
  | "parse"
  | "schema";

export class SpecifyPhaseError extends Error {
  readonly code: SpecifyErrorCode;
  readonly ticketId?: string;
  readonly latencyMs?: number;

  constructor(
    code: SpecifyErrorCode,
    message: string,
    opts: { ticketId?: string; latencyMs?: number; cause?: unknown } = {},
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "SpecifyPhaseError";
    this.code = code;
    if (opts.ticketId !== undefined) this.ticketId = opts.ticketId;
    if (opts.latencyMs !== undefined) this.latencyMs = opts.latencyMs;
  }
}

export class SpecifyItemMissingError extends SpecifyPhaseError {
  constructor(itemId: string) {
    super("item_missing", `project item ${itemId} has no linked issue`);
    this.name = "SpecifyItemMissingError";
  }
}

export class SpecifyAgentError extends SpecifyPhaseError {
  constructor(
    code: "agent" | "parse" | "schema",
    message: string,
    opts: { ticketId?: string; latencyMs?: number; cause?: unknown } = {},
  ) {
    super(code, message, opts);
    this.name = "SpecifyAgentError";
  }
}

export class SpecifyValidationError extends SpecifyPhaseError {
  constructor(message: string, opts: { ticketId?: string; cause?: unknown } = {}) {
    super("validation", message, opts);
    this.name = "SpecifyValidationError";
  }
}
