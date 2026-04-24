/**
 * Error hierarchy for the GitHub module. Every error thrown out of
 * `src/github/**` MUST extend `GitHubError`, carry a stable `code`, and
 * never include raw private-key material.
 */

export type GitHubErrorCode =
  | "auth"
  | "forbidden"
  | "not_found"
  | "rate_limit"
  | "transient"
  | "api"
  | "webhook_signature"
  | "config"
  | "push_rejected";

export class GitHubError extends Error {
  readonly code: GitHubErrorCode;
  override readonly cause?: unknown;

  constructor(code: GitHubErrorCode, message: string, cause?: unknown) {
    super(redactPem(message));
    this.name = new.target.name;
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

export class GitHubAuthError extends GitHubError {
  constructor(message = "authentication failed", cause?: unknown) {
    super("auth", message, cause);
  }
}

export class GitHubPermissionError extends GitHubError {
  constructor(message = "permission denied", cause?: unknown) {
    super("forbidden", message, cause);
  }
}

export class GitHubNotFoundError extends GitHubError {
  constructor(message = "resource not found", cause?: unknown) {
    super("not_found", message, cause);
  }
}

export class GitHubRateLimitError extends GitHubError {
  readonly resetAt: Date;
  constructor(message: string, resetAt: Date, cause?: unknown) {
    super("rate_limit", message, cause);
    this.resetAt = resetAt;
  }
}

export class GitHubTransientError extends GitHubError {
  readonly attempts: number;
  constructor(message: string, attempts: number, cause?: unknown) {
    super("transient", message, cause);
    this.attempts = attempts;
  }
}

export class GitHubApiError extends GitHubError {
  readonly status: number;
  constructor(status: number, message: string, cause?: unknown) {
    super("api", message, cause);
    this.status = status;
  }
}

export class WebhookSignatureError extends GitHubError {
  constructor(message = "webhook signature verification failed", cause?: unknown) {
    super("webhook_signature", message, cause);
  }
}

export class ConfigError extends GitHubError {
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

export class GitHubPushRejectedError extends GitHubError {
  readonly branch: string;
  constructor(branch: string, message?: string, cause?: unknown) {
    super(
      "push_rejected",
      message ?? `push to ${branch} rejected (non-fast-forward or conflict)`,
      cause,
    );
    this.branch = branch;
  }
}

/**
 * Strips anything that looks like a PEM block (and its contents) from a
 * string so private-key material never ends up in error messages, logs, or
 * serialised `cause` chains. Conservative by design — anything between
 * `-----BEGIN` and `-----END` markers is replaced wholesale.
 */
export function redactPem(s: string): string {
  if (typeof s !== "string") return s;
  return s.replace(
    /-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g,
    "[REDACTED_PEM]",
  );
}
