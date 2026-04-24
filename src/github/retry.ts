import { setTimeout as sleep } from "node:timers/promises";
import {
  GitHubApiError,
  GitHubAuthError,
  GitHubError,
  GitHubNotFoundError,
  GitHubPermissionError,
  GitHubRateLimitError,
  GitHubTransientError,
} from "./errors.js";

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Deterministic source of randomness for tests. Defaults to `Math.random`. */
  random?: () => number;
  /** Injectable sleep, defaults to `node:timers/promises.setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  /** Reference clock for Retry-After calculations. Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Minimal shape of the Octokit-like errors we classify. We only read fields
 * we know exist; unknown shapes fall through to a transient classification.
 */
interface OctokitLikeError {
  status?: number;
  message?: string;
  response?: {
    headers?: Record<string, string | undefined>;
    data?: { message?: string };
  };
}

const DEFAULTS: Required<Omit<RetryOptions, "sleep" | "random" | "now">> = {
  maxAttempts: 5,
  baseDelayMs: 250,
  maxDelayMs: 30_000,
};

/**
 * Executes `fn`, retrying on transient errors per the documented policy:
 *   - Retry on network errors, 5xx, and GitHub secondary rate-limit signals
 *   - Honor `retry-after` / `x-ratelimit-reset` when present
 *   - Otherwise exponential backoff with ±25% jitter
 *   - Primary rate-limit exhaustion throws `GitHubRateLimitError` immediately
 *   - 4xx (other than secondary rate-limit) throws `GitHubApiError` without retry
 *   - Max `maxAttempts` (default 5); overflow throws `GitHubTransientError`
 */
export async function retryable<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? DEFAULTS.maxAttempts;
  const baseDelayMs = opts.baseDelayMs ?? DEFAULTS.baseDelayMs;
  const maxDelayMs = opts.maxDelayMs ?? DEFAULTS.maxDelayMs;
  const random = opts.random ?? Math.random;
  const doSleep = opts.sleep ?? ((ms: number) => sleep(ms));
  const now = opts.now ?? Date.now;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const classified = classifyError(err, now);
      if (classified.kind === "fatal") throw classified.error;
      if (attempt === maxAttempts) {
        throw new GitHubTransientError(
          `request failed after ${attempt} attempts: ${describe(err)}`,
          attempt,
          err,
        );
      }
      const delay =
        classified.retryAfterMs ?? computeBackoff(attempt, baseDelayMs, maxDelayMs, random);
      await doSleep(delay);
    }
  }
  // Should be unreachable; keep TS happy.
  throw new GitHubTransientError(
    `request failed: ${describe(lastError)}`,
    maxAttempts,
    lastError,
  );
}

type Classification =
  | { kind: "retry"; retryAfterMs?: number }
  | { kind: "fatal"; error: GitHubError };

function classifyError(err: unknown, now: () => number): Classification {
  // Already one of ours — rethrow as-is.
  if (err instanceof GitHubError) return { kind: "fatal", error: err };

  const e = err as OctokitLikeError | undefined;
  const status = e?.status;
  const headers = e?.response?.headers ?? {};
  const message = e?.message ?? e?.response?.data?.message ?? "";

  // Network / no-status errors → transient retry.
  if (typeof status !== "number") {
    return { kind: "retry" };
  }

  if (status >= 500) {
    const wait = readRetryAfterMs(headers, now);
    return wait !== undefined ? { kind: "retry", retryAfterMs: wait } : { kind: "retry" };
  }

  if (status === 403) {
    // Secondary rate limit: retry with server-directed wait.
    const lower = message.toLowerCase();
    const isSecondary =
      lower.includes("secondary rate limit") ||
      lower.includes("abuse") ||
      headers["x-ratelimit-resource"] === "abuse";
    if (isSecondary) {
      const wait = readRetryAfterMs(headers, now);
      return wait !== undefined ? { kind: "retry", retryAfterMs: wait } : { kind: "retry" };
    }
    // Primary rate limit: remaining === 0 with reset in the future.
    const remaining = parseIntSafe(headers["x-ratelimit-remaining"]);
    const reset = parseIntSafe(headers["x-ratelimit-reset"]);
    if (remaining === 0 && reset !== undefined) {
      const resetAt = new Date(reset * 1000);
      if (resetAt.getTime() > now()) {
        return {
          kind: "fatal",
          error: new GitHubRateLimitError(
            `primary rate limit exceeded; resets at ${resetAt.toISOString()}`,
            resetAt,
            err,
          ),
        };
      }
    }
    return { kind: "fatal", error: new GitHubPermissionError(message || "forbidden", err) };
  }

  if (status === 401) {
    return { kind: "fatal", error: new GitHubAuthError(message || "unauthorized", err) };
  }
  if (status === 404) {
    return { kind: "fatal", error: new GitHubNotFoundError(message || "not found", err) };
  }

  // Remaining 4xx: non-retryable API error.
  if (status >= 400) {
    return {
      kind: "fatal",
      error: new GitHubApiError(status, message || `request failed with ${status}`, err),
    };
  }

  // 2xx/3xx shouldn't land here, but treat as retryable just in case.
  return { kind: "retry" };
}

function readRetryAfterMs(
  headers: Record<string, string | undefined>,
  now: () => number,
): number | undefined {
  const retryAfter = parseIntSafe(headers["retry-after"]);
  if (retryAfter !== undefined) return retryAfter * 1000;
  const reset = parseIntSafe(headers["x-ratelimit-reset"]);
  if (reset !== undefined) return Math.max(0, reset * 1000 - now());
  return undefined;
}

function parseIntSafe(v: unknown): number | undefined {
  if (typeof v !== "string" && typeof v !== "number") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function computeBackoff(
  attempt: number,
  base: number,
  max: number,
  random: () => number,
): number {
  const exp = Math.min(2 ** (attempt - 1) * base, max);
  const jitter = 1 + (random() - 0.5) * 0.5; // ±25%
  return Math.max(0, Math.round(exp * jitter));
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
