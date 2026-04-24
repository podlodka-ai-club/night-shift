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
  issueNumber: z.number().int().positive().optional(),
  status: StatusNameSchema.optional(),
});
export type ProjectItem = z.infer<typeof ProjectItemSchema>;

export { PRRefSchema };
export type PRRef = z.infer<typeof PRRefSchema>;

/**
 * GitHub App configuration. Exactly one of `privateKey` | `privateKeyPath`
 * must be supplied; the loader resolves `privateKeyPath` relative to the
 * config file's directory.
 */
export const GitHubConfigSchema = z
  .object({
    appId: z.number().int().positive(),
    installationId: z.number().int().positive(),
    privateKey: z.string().min(1).optional(),
    privateKeyPath: z.string().min(1).optional(),
    webhookSecret: z.string().min(1),
    owner: z.string().min(1),
    repo: z.string().min(1),
    projectNodeId: z.string().min(1),
    statusFieldName: z.string().min(1).default("Status"),
    manageStatusOptions: z.boolean().default(true),
  })
  .refine(
    (v) => Boolean(v.privateKey) !== Boolean(v.privateKeyPath),
    {
      message: "Provide exactly one of `privateKey` or `privateKeyPath`",
      path: ["privateKey"],
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
