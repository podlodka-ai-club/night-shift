import { describe, expect, it } from "vitest";
import {
  GitHubConfigSchema,
  ParsedWebhookEventSchema,
  StatusNameSchema,
  STATUS_NAMES,
} from "../types.js";

describe("StatusNameSchema", () => {
  it("accepts all 7 canonical statuses", () => {
    for (const s of STATUS_NAMES) {
      expect(() => StatusNameSchema.parse(s)).not.toThrow();
    }
  });
  it("rejects unknown statuses", () => {
    expect(() => StatusNameSchema.parse("Wontfix")).toThrow();
  });
});

describe("GitHubConfigSchema", () => {
  const common = {
    owner: "acme",
    repo: "widgets",
    projectNodeId: "PVT_xxx",
  };

  const appBase = {
    ...common,
    appId: 1,
    installationId: 2,
    webhookSecret: "shh",
  };

  it("parses App auth with privateKey", () => {
    const parsed = GitHubConfigSchema.parse({ ...appBase, privateKey: "abc" });
    expect(parsed.statusFieldName).toBe("Status");
    expect(parsed.manageStatusOptions).toBe(true);
  });

  it("parses App auth with privateKeyPath", () => {
    const parsed = GitHubConfigSchema.parse({ ...appBase, privateKeyPath: "./key.pem" });
    expect(parsed.privateKeyPath).toBe("./key.pem");
  });

  it("rejects App auth when both privateKey and privateKeyPath are provided", () => {
    expect(() =>
      GitHubConfigSchema.parse({ ...appBase, privateKey: "a", privateKeyPath: "b" }),
    ).toThrow();
  });

  it("rejects App auth when neither key is provided", () => {
    expect(() => GitHubConfigSchema.parse(appBase)).toThrow();
  });

  it("parses PAT auth with token", () => {
    const parsed = GitHubConfigSchema.parse({ ...common, token: "ghp_abc123" });
    expect(parsed.token).toBe("ghp_abc123");
    expect(parsed.appId).toBeUndefined();
  });

  it("rejects when both token and App auth are provided", () => {
    expect(() =>
      GitHubConfigSchema.parse({ ...appBase, privateKey: "abc", token: "ghp_abc123" }),
    ).toThrow();
  });

  it("rejects when no auth is provided", () => {
    expect(() => GitHubConfigSchema.parse(common)).toThrow();
  });

  it("webhookSecret is optional", () => {
    const parsed = GitHubConfigSchema.parse({ ...common, token: "ghp_abc123" });
    expect(parsed.webhookSecret).toBeUndefined();
  });

  it("accepts projectNumber + projectOwner + projectOwnerType instead of projectNodeId", () => {
    const parsed = GitHubConfigSchema.parse({
      token: "ghp_abc",
      owner: "acme",
      repo: "widgets",
      projectNumber: 1,
      projectOwner: "acme",
      projectOwnerType: "org",
    });
    expect(parsed.projectNumber).toBe(1);
    expect(parsed.projectNodeId).toBeUndefined();
  });

  it("rejects when neither projectNodeId nor projectNumber is provided", () => {
    expect(() =>
      GitHubConfigSchema.parse({
        token: "ghp_abc",
        owner: "acme",
        repo: "widgets",
      }),
    ).toThrow("projectNodeId");
  });

  it("honors custom statusFieldName and manageStatusOptions", () => {
    const parsed = GitHubConfigSchema.parse({
      ...appBase,
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
