import { describe, expect, it } from "vitest";
import {
  ConfigError,
  GitHubApiError,
  GitHubAuthError,
  GitHubError,
  GitHubNotFoundError,
  GitHubPermissionError,
  GitHubRateLimitError,
  GitHubTransientError,
  WebhookSignatureError,
  redactPem,
} from "../errors.js";

describe("GitHub error hierarchy", () => {
  it("every subclass extends GitHubError with a stable code", () => {
    const cases: Array<[GitHubError, string]> = [
      [new GitHubAuthError(), "auth"],
      [new GitHubPermissionError(), "forbidden"],
      [new GitHubNotFoundError(), "not_found"],
      [new GitHubRateLimitError("x", new Date()), "rate_limit"],
      [new GitHubTransientError("x", 5), "transient"],
      [new GitHubApiError(500, "x"), "api"],
      [new WebhookSignatureError(), "webhook_signature"],
      [new ConfigError("x"), "config"],
    ];
    for (const [err, code] of cases) {
      expect(err).toBeInstanceOf(GitHubError);
      expect(err).toBeInstanceOf(Error);
      expect(err.code).toBe(code);
      expect(err.name).toBe(err.constructor.name);
    }
  });

  it("rate limit error carries resetAt", () => {
    const d = new Date("2026-04-24T10:00:00Z");
    const err = new GitHubRateLimitError("limited", d);
    expect(err.resetAt).toBe(d);
  });

  it("transient error carries attempts", () => {
    expect(new GitHubTransientError("x", 5).attempts).toBe(5);
  });

  it("api error carries status", () => {
    expect(new GitHubApiError(422, "x").status).toBe(422);
  });

  it("cause is preserved", () => {
    const cause = new Error("root");
    const err = new GitHubApiError(500, "boom", cause);
    expect(err.cause).toBe(cause);
  });
});

describe("redactPem", () => {
  const PEM = [
    "-----BEGIN RSA PRIVATE KEY-----",
    "MIIEowIBAAKCAQEAxxxxxxxxxxxxxxxxxxxxxxxx",
    "abcd1234abcd1234abcd1234abcd1234",
    "-----END RSA PRIVATE KEY-----",
  ].join("\n");

  it("replaces PEM blocks with [REDACTED_PEM]", () => {
    const out = redactPem(`before\n${PEM}\nafter`);
    expect(out).toContain("[REDACTED_PEM]");
    expect(out).not.toContain("MIIEowIBAAKCAQEA");
    expect(out).not.toContain("-----BEGIN RSA PRIVATE KEY-----");
  });

  it("is a no-op when no PEM block is present", () => {
    expect(redactPem("just a message")).toBe("just a message");
  });

  it("error message is redacted automatically", () => {
    const err = new ConfigError(`bad config near ${PEM} end`);
    expect(err.message).not.toContain("MIIEowIBAAKCAQEA");
    expect(err.message).toContain("[REDACTED_PEM]");
  });
});
