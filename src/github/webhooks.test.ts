import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { WebhookSignatureError } from "./errors.js";
import { handleWebhook } from "./webhooks.js";

const SECRET = "shh";

function sign(body: string): string {
  return "sha256=" + createHmac("sha256", SECRET).update(body).digest("hex");
}

function hdrs(event: string, body: string, overrides: Record<string, string> = {}) {
  return {
    "x-github-event": event,
    "x-github-delivery": "deliv-1",
    "x-hub-signature-256": sign(body),
    ...overrides,
  };
}

describe("handleWebhook signature verification", () => {
  it("throws on missing signature header", () => {
    expect(() =>
      handleWebhook({
        headers: { "x-github-event": "issues" },
        rawBody: "{}",
        secret: SECRET,
      }),
    ).toThrow(WebhookSignatureError);
  });

  it("throws on mismatched signature", () => {
    expect(() =>
      handleWebhook({
        headers: {
          "x-github-event": "issues",
          "x-hub-signature-256": "sha256=deadbeef",
        },
        rawBody: "{}",
        secret: SECRET,
      }),
    ).toThrow(WebhookSignatureError);
  });

  it("throws when a different secret was used", () => {
    const body = "{}";
    const sig = "sha256=" + createHmac("sha256", "other").update(body).digest("hex");
    expect(() =>
      handleWebhook({
        headers: { "x-github-event": "issues", "x-hub-signature-256": sig },
        rawBody: body,
        secret: SECRET,
      }),
    ).toThrow(WebhookSignatureError);
  });
});

describe("handleWebhook event parsing", () => {
  it("returns ignored for unhandled events", () => {
    const body = "{}";
    const ev = handleWebhook({
      headers: hdrs("star", body),
      rawBody: body,
      secret: SECRET,
    });
    expect(ev.kind).toBe("ignored");
  });

  it("parses project_v2_item change with status resolver", () => {
    const payload = {
      projects_v2_item: {
        node_id: "PVTI_1",
        project_node_id: "PVT_1",
      },
      changes: {
        field_value: {
          from: { option_id: "opt-a" },
          to: { option_id: "opt-b" },
        },
      },
    };
    const body = JSON.stringify(payload);
    const ev = handleWebhook({
      headers: hdrs("project_v2_item", body),
      rawBody: body,
      secret: SECRET,
      statusNameForOptionId: (id) => (id === "opt-a" ? "Backlog" : "Ready"),
    });
    expect(ev.kind).toBe("project_v2_item.changed");
    if (ev.kind === "project_v2_item.changed") {
      expect(ev.itemId).toBe("PVTI_1");
      expect(ev.projectNodeId).toBe("PVT_1");
      expect(ev.previousStatus).toBe("Backlog");
      expect(ev.currentStatus).toBe("Ready");
    }
  });

  it("parses issues.labeled", () => {
    const payload = {
      action: "labeled",
      issue: { number: 42 },
      repository: { name: "widgets", owner: { login: "acme" } },
    };
    const body = JSON.stringify(payload);
    const ev = handleWebhook({
      headers: hdrs("issues", body),
      rawBody: body,
      secret: SECRET,
    });
    expect(ev.kind).toBe("issues.labeled");
    if (ev.kind === "issues.labeled") {
      expect(ev.issueNumber).toBe(42);
      expect(ev.repoOwner).toBe("acme");
      expect(ev.repoName).toBe("widgets");
    }
  });

  it("ignores unknown issues action", () => {
    const payload = { action: "pinned", issue: { number: 1 } };
    const body = JSON.stringify(payload);
    const ev = handleWebhook({
      headers: hdrs("issues", body),
      rawBody: body,
      secret: SECRET,
    });
    expect(ev.kind).toBe("ignored");
  });

  it("exposes deliveryId on every event", () => {
    const body = JSON.stringify({ action: "opened", issue: { number: 1 }, repository: { name: "r", owner: { login: "o" } } });
    const ev = handleWebhook({
      headers: hdrs("issues", body, { "x-github-delivery": "abc-123" }),
      rawBody: body,
      secret: SECRET,
    });
    expect(ev.deliveryId).toBe("abc-123");
  });
});
