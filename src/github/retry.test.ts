import { describe, expect, it, vi } from "vitest";
import {
  GitHubApiError,
  GitHubAuthError,
  GitHubNotFoundError,
  GitHubRateLimitError,
  GitHubTransientError,
} from "./errors.js";
import { retryable } from "./retry.js";

function err(status: number, headers: Record<string, string> = {}, message = "boom") {
  const e = new Error(message) as Error & {
    status?: number;
    response?: { headers: Record<string, string> };
  };
  e.status = status;
  e.response = { headers };
  return e;
}

function makeHarness() {
  const sleeps: number[] = [];
  const opts = {
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
    random: () => 0.5, // no jitter
    baseDelayMs: 100,
    maxDelayMs: 30_000,
  };
  return { sleeps, opts };
}

describe("retryable", () => {
  it("returns immediately on success", async () => {
    const { opts } = makeHarness();
    const out = await retryable(async () => 42, opts);
    expect(out).toBe(42);
  });

  it("retries on 500 and succeeds on the third attempt", async () => {
    const { sleeps, opts } = makeHarness();
    let calls = 0;
    const out = await retryable(async () => {
      calls++;
      if (calls < 3) throw err(500);
      return "ok";
    }, opts);
    expect(calls).toBe(3);
    expect(out).toBe("ok");
    expect(sleeps).toHaveLength(2);
  });

  it("respects retry-after when set", async () => {
    const { sleeps, opts } = makeHarness();
    let calls = 0;
    await retryable(async () => {
      calls++;
      if (calls === 1) throw err(503, { "retry-after": "1" });
      return "ok";
    }, opts);
    expect(sleeps[0]).toBe(1000);
  });

  it("throws GitHubTransientError after exceeding maxAttempts", async () => {
    const { opts } = makeHarness();
    let calls = 0;
    await expect(
      retryable(async () => {
        calls++;
        throw err(500);
      }, opts),
    ).rejects.toBeInstanceOf(GitHubTransientError);
    expect(calls).toBe(5);
  });

  it("does not retry 404", async () => {
    const { opts } = makeHarness();
    let calls = 0;
    await expect(
      retryable(async () => {
        calls++;
        throw err(404, {}, "not found");
      }, opts),
    ).rejects.toBeInstanceOf(GitHubNotFoundError);
    expect(calls).toBe(1);
  });

  it("does not retry 401", async () => {
    const { opts } = makeHarness();
    await expect(
      retryable(async () => {
        throw err(401, {}, "unauthorized");
      }, opts),
    ).rejects.toBeInstanceOf(GitHubAuthError);
  });

  it("does not retry 422", async () => {
    const { opts } = makeHarness();
    await expect(
      retryable(async () => {
        throw err(422, {}, "validation");
      }, opts),
    ).rejects.toBeInstanceOf(GitHubApiError);
  });

  it("throws GitHubRateLimitError immediately on primary rate limit", async () => {
    const { opts } = makeHarness();
    const now = Math.floor(Date.now() / 1000);
    const resetIn = now + 60;
    let calls = 0;
    await expect(
      retryable(
        async () => {
          calls++;
          throw err(
            403,
            { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(resetIn) },
            "API rate limit exceeded",
          );
        },
        { ...opts, now: () => Date.now() },
      ),
    ).rejects.toBeInstanceOf(GitHubRateLimitError);
    expect(calls).toBe(1);
  });

  it("retries on secondary rate limit (403 with secondary marker)", async () => {
    const { sleeps, opts } = makeHarness();
    let calls = 0;
    await retryable(async () => {
      calls++;
      if (calls === 1) {
        throw err(
          403,
          { "retry-after": "2" },
          "You have exceeded a secondary rate limit",
        );
      }
      return "ok";
    }, opts);
    expect(calls).toBe(2);
    expect(sleeps[0]).toBe(2000);
  });

  it("retries on network errors with no status", async () => {
    const { opts } = makeHarness();
    let calls = 0;
    const out = await retryable(async () => {
      calls++;
      if (calls < 2) throw new Error("ECONNRESET");
      return "ok";
    }, opts);
    expect(calls).toBe(2);
    expect(out).toBe("ok");
  });
});
