import type { Comment } from "../../github/types.js";
import type { Ticket } from "../../contracts/ticket.js";

/**
 * System prompt for the specifier role. Kept short and declarative — the
 * heavy lifting lives in `renderUserMessage` + the structured output schema.
 */
export const SPECIFIER_SYSTEM_PROMPT = `You are the Specifier role in the Night-Shift system.
Given a product ticket, produce an OpenSpec-compatible change proposal.
Your final message MUST be a single JSON object matching the provided schema.
Never include explanatory prose outside the JSON.`;

export interface PriorDraftFile {
  path: string;
  content: string;
}

/**
 * Build the user message delivered to the specifier agent. Includes the
 * ticket, all non-Night-Shift comments in chronological order, a prose
 * summary of the expected JSON response, and — when a prior draft exists —
 * every file from the current change folder so the agent can revise.
 */
export function renderUserMessage(
  ticket: Ticket,
  comments: Comment[],
  priorDraft?: PriorDraftFile[],
): string {
  const parts: string[] = [];
  parts.push(`# Ticket ${ticket.id}: ${ticket.title}`);
  parts.push("");
  parts.push(`URL: ${ticket.url}`);
  if (ticket.labels.length > 0) {
    parts.push(`Labels: ${ticket.labels.join(", ")}`);
  }
  parts.push("");
  parts.push("## Description");
  parts.push(ticket.description.trim() || "_(no description provided)_");
  parts.push("");

  if (comments.length > 0) {
    parts.push("## Comments");
    for (const c of comments) {
      const author = c.authorLogin ? `@${c.authorLogin}` : "(unknown)";
      parts.push(`### ${author} — ${c.createdAt}`);
      parts.push(c.body.trim());
      parts.push("");
    }
  }

  if (priorDraft && priorDraft.length > 0) {
    parts.push("## Current draft");
    parts.push(
      "The following files already exist on the ticket branch. Revise them as needed.",
    );
    parts.push("");
    for (const f of priorDraft) {
      parts.push(`### ${f.path}`);
      parts.push("```markdown");
      parts.push(f.content);
      parts.push("```");
      parts.push("");
    }
  }

  parts.push("## Response");
  parts.push(
    "Return a JSON object with keys: `files` (array of `{path, content}`), `openQuestions`, `assumptions`, `risks`.",
  );
  parts.push(
    "`files` MUST include `proposal.md` and `tasks.md`. It MAY include `design.md` and one or more `specs/<capability>/spec.md` deltas.",
  );
  parts.push(
    "If there are unresolved questions that block writing the spec, list them in `openQuestions` (non-empty).",
  );
  return parts.join("\n");
}
