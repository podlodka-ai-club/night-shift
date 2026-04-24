import type { Comment } from "../../github/types.js";
import type { Ticket } from "../../contracts/ticket.js";

export const IMPLEMENTER_SYSTEM_PROMPT = `You are the Implementer role in the Night-Shift system.
Given a product ticket and its approved spec bundle, produce the minimal
set of code changes that satisfy the spec. Your final message MUST be a
single JSON object matching the provided schema. Never include prose
outside the JSON.`;

/**
 * The four files that make up a change's "spec bundle" for the implementer.
 * Additional `specs/<capability>/spec.md` deltas may be included alongside.
 */
export interface SpecBundleFile {
  path: string;
  content: string;
}

export interface RetryContext {
  previousError: string;
  attempt: number;
}

function renderSpecBundle(bundle: SpecBundleFile[]): string {
  const parts: string[] = [];
  parts.push("## Spec bundle");
  for (const f of bundle) {
    parts.push(`### ${f.path}`);
    parts.push("```markdown");
    parts.push(f.content);
    parts.push("```");
    parts.push("");
  }
  return parts.join("\n");
}

function renderComments(comments: Comment[]): string {
  if (comments.length === 0) return "";
  const parts: string[] = ["## Comments"];
  for (const c of comments) {
    const author = c.authorLogin ? `@${c.authorLogin}` : "(unknown)";
    parts.push(`### ${author} — ${c.createdAt}`);
    parts.push(c.body.trim());
    parts.push("");
  }
  return parts.join("\n");
}

export function renderImplementerMessage(
  ticket: Ticket,
  bundle: SpecBundleFile[],
  comments: Comment[],
  retry?: RetryContext,
): string {
  const parts: string[] = [];
  parts.push(`# Ticket ${ticket.id}: ${ticket.title}`);
  parts.push("");
  parts.push(`URL: ${ticket.url}`);
  if (ticket.labels.length > 0) parts.push(`Labels: ${ticket.labels.join(", ")}`);
  parts.push("");
  parts.push("## Description");
  parts.push(ticket.description.trim() || "_(no description provided)_");
  parts.push("");
  parts.push(renderSpecBundle(bundle));
  const commentsBlock = renderComments(comments);
  if (commentsBlock) parts.push(commentsBlock);
  if (retry) {
    parts.push("## Retry feedback");
    parts.push(
      `Previous attempt #${retry.attempt} failed with: ${retry.previousError}`,
    );
    parts.push("Please address this before resubmitting.");
    parts.push("");
  }
  parts.push("## Response");
  parts.push(
    "Return a JSON object with keys: `filesWritten` (array of `{path, content}` for every file you create or modify), `commitMessage`, `summary`, and optional `followUps` (array of strings).",
  );
  parts.push(
    "`path` MUST be a repo-relative POSIX path; absolute paths and `..` segments are rejected.",
  );
  return parts.join("\n");
}
