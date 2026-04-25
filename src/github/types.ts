import { z } from "zod";
import { PRRefSchema } from "../contracts/implement.js";

export const STATUS_NAMES = [
  "Backlog",
  "Refinement",
  "Refined",
  "Ready",
  "In progress",
  "In review",
  "Ready to merge",
  "Blocked",
] as const;

export const StatusNameSchema = z.enum(STATUS_NAMES);
export type StatusName = z.infer<typeof StatusNameSchema>;

export const LabelSchema = z.object({
  name: z.string().min(1),
  color: z
    .string()
    .regex(/^[0-9a-fA-F]{6}$/)
    .optional(),
  description: z.string().optional(),
});
export type Label = z.infer<typeof LabelSchema>;

export const CommentSchema = z.object({
  id: z.number().int(),
  body: z.string(),
  authorLogin: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Comment = z.infer<typeof CommentSchema>;

export const IssueSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string().nullable(),
  state: z.enum(["open", "closed"]),
  labels: z.array(z.string()),
  htmlUrl: z.string().url(),
});
export type Issue = z.infer<typeof IssueSchema>;

export const ProjectItemSchema = z.object({
  itemId: z.string().min(1),
  projectNodeId: z.string().min(1),
  ticketId: z.string().min(1),
  title: z.string(),
  issueNumber: z.number().int().positive().optional(),
  status: StatusNameSchema.optional(),
});
export type ProjectItem = z.infer<typeof ProjectItemSchema>;

export const ProjectItemSummarySchema = z.object({
  itemId: z.string().min(1),
  issueNumber: z.number().int().positive(),
  title: z.string(),
  ticketId: z.string().min(1),
  createdAt: z.string(),
});
export type ProjectItemSummary = z.infer<typeof ProjectItemSummarySchema>;

export { PRRefSchema };
export type PRRef = z.infer<typeof PRRefSchema>;

export const ChangedFileStatusSchema = z.enum(["added", "modified", "removed", "renamed"]);

export const ChangedFileSchema = z.object({
  path: z.string().min(1),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  status: ChangedFileStatusSchema,
});
export type ChangedFile = z.infer<typeof ChangedFileSchema>;

export const ReviewCommentSchema = z.object({
  id: z.number().int(),
  body: z.string(),
  path: z.string(),
  line: z.number().int().positive().nullable(),
});
export type ReviewComment = z.infer<typeof ReviewCommentSchema>;

export const ReviewSchema = z.object({
  id: z.number().int(),
  body: z.string(),
  state: z.string(),
  authorAssociation: z.string(),
});
export type Review = z.infer<typeof ReviewSchema>;

/**
 * GitHub configuration. Supports two auth modes:
 *
 * 1. **GitHub App** — provide `appId`, `installationId`, and exactly one of
 *    `privateKey` | `privateKeyPath`. Preferred for production (bot identity,
 *    higher rate limits, auto-rotating tokens).
 *
 * 2. **Personal Access Token** — provide `token`. Simpler for solo / local use.
 *
 * Project board can be identified by `projectNodeId` (direct) or by
 * `projectNumber` + `projectOwner` + `projectOwnerType` (resolved at startup).
 *
 * `webhookSecret` is only required when receiving webhooks.
 */
export const GitHubConfigSchema = z
  .object({
    // App auth (all three required together)
    appId: z.number().int().positive().optional(),
    installationId: z.number().int().positive().optional(),
    privateKey: z.string().min(1).optional(),
    privateKeyPath: z.string().min(1).optional(),
    // PAT auth
    token: z.string().min(1).optional(),
    // Common
    webhookSecret: z.string().min(1).optional(),
    owner: z.string().min(1),
    repo: z.string().min(1),
    // Project — either nodeId directly, or number + owner + ownerType to resolve
    projectNodeId: z.string().min(1).optional(),
    projectNumber: z.number().int().positive().optional(),
    projectOwner: z.string().min(1).optional(),
    projectOwnerType: z.enum(["user", "org"]).optional(),
    statusFieldName: z.string().min(1).default("Status"),
    manageStatusOptions: z.boolean().default(true),
  })
  .refine(
    (v) => {
      const hasApp = v.appId != null && v.installationId != null;
      const hasKey = Boolean(v.privateKey) || Boolean(v.privateKeyPath);
      const hasToken = Boolean(v.token);
      // Exactly one auth mode
      if (hasToken && hasApp) return false;
      if (hasToken) return true;
      if (hasApp && hasKey) {
        // Exactly one of privateKey / privateKeyPath
        return Boolean(v.privateKey) !== Boolean(v.privateKeyPath);
      }
      return false;
    },
    {
      message:
        "Provide either `token` (PAT) or `appId` + `installationId` + exactly one of `privateKey` | `privateKeyPath` (GitHub App)",
      path: ["token"],
    },
  )
  .refine(
    (v) => {
      const hasNodeId = Boolean(v.projectNodeId);
      const hasNumber = v.projectNumber != null && Boolean(v.projectOwner) && Boolean(v.projectOwnerType);
      return hasNodeId || hasNumber;
    },
    {
      message:
        "Provide either `projectNodeId` or `projectNumber` + `projectOwner` + `projectOwnerType`",
      path: ["projectNodeId"],
    },
  );
export type GitHubConfig = z.infer<typeof GitHubConfigSchema>;

/**
 * Normalised webhook event returned by `handleWebhook`. Transport-agnostic;
 * no HTTP concerns leak into downstream code.
 */
const WebhookBase = {
  deliveryId: z.string().min(1),
} as const;

export const ProjectV2ItemChangedSchema = z.object({
  kind: z.literal("project_v2_item.changed"),
  ...WebhookBase,
  itemId: z.string().min(1),
  projectNodeId: z.string().min(1),
  previousStatus: StatusNameSchema.optional(),
  currentStatus: StatusNameSchema.optional(),
  raw: z.unknown(),
});

export const IssuesEventSchema = z.object({
  kind: z.enum([
    "issues.opened",
    "issues.edited",
    "issues.labeled",
    "issues.closed",
  ]),
  ...WebhookBase,
  issueNumber: z.number().int().positive(),
  repoOwner: z.string().min(1),
  repoName: z.string().min(1),
  raw: z.unknown(),
});

export const IgnoredEventSchema = z.object({
  kind: z.literal("ignored"),
  ...WebhookBase,
  reason: z.string().min(1),
});

export const ParsedWebhookEventSchema = z.discriminatedUnion("kind", [
  ProjectV2ItemChangedSchema,
  IssuesEventSchema,
  IgnoredEventSchema,
]);
export type ParsedWebhookEvent = z.infer<typeof ParsedWebhookEventSchema>;
