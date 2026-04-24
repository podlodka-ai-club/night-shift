import { describe, expect, it } from "vitest";
import {
  GitHubConfigSchema,
  ParsedWebhookEventSchema,
  StatusNameSchema,
  STATUS_NAMES,
} from "./types.js";

describe("StatusNameSchema", () => {
  it("accepts all 7 canonical statuses", () => {
    for (const s of STATUS_NAMES) {
      expect(() => StatusNameSchema.parse(s)).not.toThrow();
    }
  });
  it("rejects unknown statuses", () => {
    expect(() => StatusNameSchema.parse("Blocked")).toThrow();
  });
});

describe("GitHubConfigSchema", () => {
  const base = {
    appId: 1,
    installationId: 2,
    webhookSecret: "shh",
    owner: "acme",
    repo: "widgets",
    projectNodeId: "PVT_xxx",
  };

  it("parses with privateKey", () => {
    const parsed = GitHubConfigSchema.parse({ ...base, privateKey: "abc" });
    expect(parsed.statusFieldName).toBe("Status");
    expect(parsed.manageStatusOptions).toBe(true);
  });

  it("parses with privateKeyPath", () => {
    const parsed = GitHubConfigSchema.parse({ ...base, privateKeyPath: "./key.pem" });
    expect(parsed.privateKeyPath).toBe("./key.pem");
  });

  it("rejects when both privateKey and privateKeyPath are provided", () => {
    expect(() =>
      GitHubConfigSchema.parse({ ...base, privateKey: "a", privateKeyPath: "b" }),
    ).toThrow();
  });

  it("rejects when neither is provided", () => {
    expect(() => GitHubConfigSchema.parse(base)).toThrow();
  });

  it("honors custom statusFieldName and manageStatusOptions", () => {
    const parsed = GitHubConfigSchema.parse({
      ...base,
      privateKey: "x",
      statusFieldName: "Column",
      manageStatusOptions: false,
    });
    expect(parsed.statusFieldName).toBe("Column");
    expect(parsed.manageStatusOptions).toBe(false);
  });
});

describe("ParsedWebhookEventSchema", () => {
  it("parses project_v2_item.changed", () => {
    const ev = {
      kind: "project_v2_item.changed",
      deliveryId: "d",
      itemId: "PVTI_1",
      projectNodeId: "PVT_1",
      currentStatus: "Ready",
      raw: {},
    };
    expect(() => ParsedWebhookEventSchema.parse(ev)).not.toThrow();
  });

  it.each([
    "issues.opened",
    "issues.edited",
    "issues.labeled",
    "issues.closed",
  ] as const)("parses %s", (kind) => {
    const ev = {
      kind,
      deliveryId: "d",
      issueNumber: 1,
      repoOwner: "a",
      repoName: "b",
      raw: {},
    };
    expect(() => ParsedWebhookEventSchema.parse(ev)).not.toThrow();
  });

  it("parses ignored", () => {
    expect(() =>
      ParsedWebhookEventSchema.parse({
        kind: "ignored",
        deliveryId: "d",
        reason: "event not handled: star",
      }),
    ).not.toThrow();
  });

  it("rejects unknown kind", () => {
    expect(() =>
      ParsedWebhookEventSchema.parse({ kind: "mystery", deliveryId: "d" }),
    ).toThrow();
  });
});
