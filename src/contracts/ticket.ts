import { z } from "zod";
import { TicketStatusSchema } from "./status.js";
import { GitHubSourceRefSchema } from "./sources.js";

/**
 * Discriminated union of all supported source references.
 * M1 supports only GitHub. Adding a new source = adding a variant here.
 */
export const SourceRefSchema = z.discriminatedUnion("kind", [
  GitHubSourceRefSchema,
]);

export type SourceRef = z.infer<typeof SourceRefSchema>;

/**
 * Canonical, source-agnostic Ticket.
 * Every M1 module imports this type rather than redefining an equivalent.
 */
export const TicketSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  description: z.string(),
  status: TicketStatusSchema,
  labels: z.array(z.string()),
  url: z.string().url(),
  source: z.literal("github"),
  sourceRef: SourceRefSchema,
});

export type Ticket = z.infer<typeof TicketSchema>;
