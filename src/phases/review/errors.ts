export type ReviewErrorCode =
  | "validation"
  | "parse"
  | "schema"
  | "provider"
  | "github"
  | "io";

export interface ReviewErrorOpts {
  ticketId?: string;
  prNumber?: number;
  iteration?: number;
  latencyMs?: number;
  cause?: unknown;
}

export class ReviewPhaseError extends Error {
  readonly code: ReviewErrorCode;
  readonly ticketId?: string;
  readonly prNumber?: number;
  readonly iteration?: number;
  readonly latencyMs?: number;

  constructor(code: ReviewErrorCode, message: string, opts: ReviewErrorOpts = {}) {
    const suffixes: string[] = [];
    if (opts.prNumber !== undefined) suffixes.push(`pr=#${opts.prNumber}`);
    if (opts.iteration !== undefined) suffixes.push(`iteration=${opts.iteration}`);
    const suffix = suffixes.length > 0 ? ` [${suffixes.join(", ")}]` : "";
    super(
      `${message}${suffix}`,
      opts.cause !== undefined ? { cause: opts.cause } : undefined,
    );
    this.name = "ReviewPhaseError";
    this.code = code;
    if (opts.ticketId !== undefined) this.ticketId = opts.ticketId;
    if (opts.prNumber !== undefined) this.prNumber = opts.prNumber;
    if (opts.iteration !== undefined) this.iteration = opts.iteration;
    if (opts.latencyMs !== undefined) this.latencyMs = opts.latencyMs;
  }
}

export class ReviewAgentError extends ReviewPhaseError {
  constructor(
    code: "parse" | "schema" | "provider",
    message: string,
    opts: ReviewErrorOpts = {},
  ) {
    super(code, message, opts);
    this.name = "ReviewAgentError";
  }
}

export class ReviewValidationError extends ReviewPhaseError {
  constructor(message: string, opts: ReviewErrorOpts = {}) {
    super("validation", message, opts);
    this.name = "ReviewValidationError";
  }
}

export class ReviewGitHubError extends ReviewPhaseError {
  constructor(message: string, opts: ReviewErrorOpts = {}) {
    super("github", message, opts);
    this.name = "ReviewGitHubError";
  }
}

export class ReviewIoError extends ReviewPhaseError {
  constructor(message: string, opts: ReviewErrorOpts = {}) {
    super("io", message, opts);
    this.name = "ReviewIoError";
  }
}
