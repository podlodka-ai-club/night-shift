import { z } from "zod";

/**
 * GitHub-specific source reference for a Ticket.
 * Other providers (GitLab, Linear, ...) would add new variants to the
 * discriminated union in `ticket.ts`.
 */
export const GitHubSourceRefSchema = z.object({
  kind: z.literal("github"),
  projectNodeId: z.string().min(1),
  projectItemId: z.string().min(1),
  repoOwner: z.string().min(1),
  repoName: z.string().min(1),
  issueNumber: z.number().int().positive(),
});

export type GitHubSourceRef = z.infer<typeof GitHubSourceRefSchema>;
