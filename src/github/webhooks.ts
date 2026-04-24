import { createHmac, timingSafeEqual } from "node:crypto";
import { WebhookSignatureError } from "./errors.js";
import {
  type ParsedWebhookEvent,
  type StatusName,
  StatusNameSchema,
} from "./types.js";

export interface HandleWebhookInput {
  headers: Record<string, string | string[] | undefined>;
  rawBody: string | Buffer;
  secret: string;
  /**
   * Optional resolver that maps a Projects v2 single-select option ID to the
   * canonical {@link StatusName}. When omitted, the parser returns the event
   * without `previousStatus` / `currentStatus` populated. The client wires
   * this with its resolved option map at startup.
   */
  statusNameForOptionId?: (optionId: string) => StatusName | undefined;
}

/**
 * Pure webhook handler: verifies the `X-Hub-Signature-256` header and
 * returns a normalised event. Does not perform I/O, does not schedule work,
 * does not log. Throws {@link WebhookSignatureError} on verification
 * failure; returns `{ kind: "ignored" }` for unhandled event types.
 */
export function handleWebhook(input: HandleWebhookInput): ParsedWebhookEvent {
  verifySignature(input.headers, input.rawBody, input.secret);
  const deliveryId = headerString(input.headers, "x-github-delivery") ?? "unknown";
  const event = headerString(input.headers, "x-github-event");
  const body = parseBody(input.rawBody);

  if (!event) {
    return { kind: "ignored", deliveryId, reason: "missing X-GitHub-Event" };
  }

  if (event === "project_v2_item") {
    return parseProjectV2Item(body, deliveryId, input.statusNameForOptionId);
  }
  if (event === "issues") {
    return parseIssues(body, deliveryId);
  }
  return { kind: "ignored", deliveryId, reason: `event not handled: ${event}` };
}

function verifySignature(
  headers: Record<string, string | string[] | undefined>,
  rawBody: string | Buffer,
  secret: string,
): void {
  const provided = headerString(headers, "x-hub-signature-256");
  if (!provided || !provided.startsWith("sha256=")) {
    throw new WebhookSignatureError("missing or malformed X-Hub-Signature-256");
  }
  const expected = "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new WebhookSignatureError("signature mismatch");
  }
}

function parseBody(raw: string | Buffer): Record<string, unknown> {
  const text = typeof raw === "string" ? raw : raw.toString("utf8");
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
    return {};
  } catch {
    return {};
  }
}

function headerString(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== lower) continue;
    if (Array.isArray(v)) return v[0];
    if (typeof v === "string") return v;
  }
  return undefined;
}

function parseProjectV2Item(
  body: Record<string, unknown>,
  deliveryId: string,
  resolver?: (optionId: string) => StatusName | undefined,
): ParsedWebhookEvent {
  const item = (body.projects_v2_item ?? body.project_v2_item) as
    | Record<string, unknown>
    | undefined;
  const itemId = typeof item?.node_id === "string" ? (item.node_id as string) : undefined;
  const projectNodeId =
    typeof item?.project_node_id === "string"
      ? (item.project_node_id as string)
      : undefined;

  if (!itemId || !projectNodeId) {
    return {
      kind: "ignored",
      deliveryId,
      reason: "project_v2_item payload missing node ids",
    };
  }

  const changes = (body.changes ?? {}) as Record<string, unknown>;
  const fieldValue = (changes.field_value ?? {}) as Record<string, unknown>;
  const fromOptionId = readOptionId(fieldValue.from);
  const toOptionId = readOptionId(fieldValue.to);

  const previousStatus = resolveStatus(fromOptionId, resolver);
  const currentStatus = resolveStatus(toOptionId, resolver);

  const result: ParsedWebhookEvent = {
    kind: "project_v2_item.changed",
    deliveryId,
    itemId,
    projectNodeId,
    raw: body,
    ...(previousStatus !== undefined ? { previousStatus } : {}),
    ...(currentStatus !== undefined ? { currentStatus } : {}),
  };
  return result;
}

function readOptionId(v: unknown): string | undefined {
  if (!v || typeof v !== "object") return undefined;
  const obj = v as Record<string, unknown>;
  const id = obj.option_id ?? obj.optionId ?? obj.id;
  return typeof id === "string" ? id : undefined;
}

function resolveStatus(
  optionId: string | undefined,
  resolver?: (id: string) => StatusName | undefined,
): StatusName | undefined {
  if (!optionId || !resolver) return undefined;
  const name = resolver(optionId);
  if (!name) return undefined;
  const parsed = StatusNameSchema.safeParse(name);
  return parsed.success ? parsed.data : undefined;
}

function parseIssues(body: Record<string, unknown>, deliveryId: string): ParsedWebhookEvent {
  const action = body.action;
  const allowed = new Set(["opened", "edited", "labeled", "closed"]);
  if (typeof action !== "string" || !allowed.has(action)) {
    return { kind: "ignored", deliveryId, reason: `issues action not handled: ${String(action)}` };
  }
  const issue = body.issue as Record<string, unknown> | undefined;
  const repo = body.repository as Record<string, unknown> | undefined;
  const issueNumber =
    typeof issue?.number === "number" ? (issue.number as number) : undefined;
  const repoName = typeof repo?.name === "string" ? (repo.name as string) : undefined;
  const ownerObj = repo?.owner as Record<string, unknown> | undefined;
  const repoOwner = typeof ownerObj?.login === "string" ? (ownerObj.login as string) : undefined;

  if (!issueNumber || !repoOwner || !repoName) {
    return { kind: "ignored", deliveryId, reason: "issues payload missing identifiers" };
  }

  return {
    kind: `issues.${action}` as
      | "issues.opened"
      | "issues.edited"
      | "issues.labeled"
      | "issues.closed",
    deliveryId,
    issueNumber,
    repoOwner,
    repoName,
    raw: body,
  };
}
