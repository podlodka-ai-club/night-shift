/**
 * Error taxonomy for the Implement phase. All phase errors subclass
 * `ImplementPhaseError` so callers can `instanceof`-check a single base
 * while still discriminating by stable `code` strings for telemetry.
 */
export type ImplementErrorCode =
  | "agent"
  | "validation"
  | "parse"
  | "schema"
  | "git"
  | "io"
  | "push_rejected";

export interface ImplementErrorOpts {
  ticketId?: string;
  worktreePath?: string;
  latencyMs?: number;
  cause?: unknown;
}

export class ImplementPhaseError extends Error {
  readonly code: ImplementErrorCode;
  readonly ticketId?: string;
  readonly worktreePath?: string;
  readonly latencyMs?: number;

  constructor(code: ImplementErrorCode, message: string, opts: ImplementErrorOpts = {}) {
    const suffix = opts.worktreePath ? ` [worktree=${opts.worktreePath}]` : "";
    super(
      `${message}${suffix}`,
      opts.cause !== undefined ? { cause: opts.cause } : undefined,
    );
    this.name = "ImplementPhaseError";
    this.code = code;
    if (opts.ticketId !== undefined) this.ticketId = opts.ticketId;
    if (opts.worktreePath !== undefined) this.worktreePath = opts.worktreePath;
    if (opts.latencyMs !== undefined) this.latencyMs = opts.latencyMs;
  }
}

export class ImplementAgentError extends ImplementPhaseError {
  constructor(
    code: "agent" | "parse" | "schema",
    message: string,
    opts: ImplementErrorOpts = {},
  ) {
    super(code, message, opts);
    this.name = "ImplementAgentError";
  }
}

export class ImplementValidationError extends ImplementPhaseError {
  constructor(message: string, opts: ImplementErrorOpts = {}) {
    super("validation", message, opts);
    this.name = "ImplementValidationError";
  }
}

export class ImplementGitError extends ImplementPhaseError {
  constructor(
    message: string,
    opts: ImplementErrorOpts & { code?: "git" | "push_rejected" } = {},
  ) {
    super(opts.code ?? "git", message, opts);
    this.name = "ImplementGitError";
  }
}

export class ImplementIoError extends ImplementPhaseError {
  constructor(message: string, opts: ImplementErrorOpts = {}) {
    super("io", message, opts);
    this.name = "ImplementIoError";
  }
}
