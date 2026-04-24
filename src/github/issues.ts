import { retryable } from "./retry.js";
import { GitHubNotFoundError } from "./errors.js";
import { type Issue, IssueSchema } from "./types.js";

/**
 * Minimal Octokit REST surface we depend on. Satisfied by an `Octokit`
 * instance from `@octokit/rest` or `@octokit/core`.
 */
export interface RestClient {
  request<T = unknown>(
    route: string,
    params?: Record<string, unknown>,
  ): Promise<{ data: T; status: number; headers: Record<string, string> }>;
}

export async function getIssue(
  rest: RestClient,
  owner: string,
  repo: string,
  number: number,
): Promise<Issue> {
  const { data } = await retryable(() =>
    rest.request<{
      number: number;
      title: string;
      body: string | null;
      state: "open" | "closed";
      labels: Array<{ name: string } | string>;
      html_url: string;
    }>("GET /repos/{owner}/{repo}/issues/{number}", { owner, repo, number }),
  );
  const labels = data.labels.map((l) => (typeof l === "string" ? l : l.name));
  return IssueSchema.parse({
    number: data.number,
    title: data.title,
    body: data.body,
    state: data.state,
    labels,
    htmlUrl: data.html_url,
  });
}

export async function ensureLabel(
  rest: RestClient,
  owner: string,
  repo: string,
  name: string,
  color = "ededed",
  description?: string,
): Promise<void> {
  try {
    await retryable(() =>
      rest.request("POST /repos/{owner}/{repo}/labels", {
        owner,
        repo,
        name,
        color,
        ...(description ? { description } : {}),
      }),
    );
  } catch (err) {
    // 422 "already_exists" is the idempotent path we want.
    if (isAlreadyExists(err)) return;
    throw err;
  }
}

function isAlreadyExists(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { status?: number; message?: string };
  if (e.status !== 422) return false;
  const msg = (e.message ?? "").toLowerCase();
  return msg.includes("already_exists") || msg.includes("already exists");
}

export async function addLabels(
  rest: RestClient,
  owner: string,
  repo: string,
  issueNumber: number,
  labels: string[],
): Promise<void> {
  for (const label of labels) {
    await ensureLabel(rest, owner, repo, label);
  }
  await retryable(() =>
    rest.request("POST /repos/{owner}/{repo}/issues/{issue_number}/labels", {
      owner,
      repo,
      issue_number: issueNumber,
      labels,
    }),
  );
}

export async function removeLabel(
  rest: RestClient,
  owner: string,
  repo: string,
  issueNumber: number,
  label: string,
): Promise<void> {
  try {
    await retryable(() =>
      rest.request(
        "DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}",
        { owner, repo, issue_number: issueNumber, name: label },
      ),
    );
  } catch (err) {
    // 404 means the label was already not applied — idempotent no-op.
    if (err instanceof GitHubNotFoundError) return;
    throw err;
  }
}

export function markerLine(markerId: string): string {
  return `<!-- night-shift:marker=${markerId} -->`;
}

export async function upsertComment(
  rest: RestClient,
  owner: string,
  repo: string,
  issueNumber: number,
  markerId: string,
  body: string,
): Promise<{ commentId: number }> {
  const marker = markerLine(markerId);
  const bodyWithMarker = body.startsWith(marker) ? body : `${marker}\n${body}`;

  const existing = await retryable(() =>
    rest.request<Array<{ id: number; body: string | null }>>(
      "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
      { owner, repo, issue_number: issueNumber, per_page: 100 },
    ),
  );
  const match = existing.data.find((c) => (c.body ?? "").startsWith(marker));

  if (match) {
    await retryable(() =>
      rest.request("PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}", {
        owner,
        repo,
        comment_id: match.id,
        body: bodyWithMarker,
      }),
    );
    return { commentId: match.id };
  }

  const created = await retryable(() =>
    rest.request<{ id: number }>(
      "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
      { owner, repo, issue_number: issueNumber, body: bodyWithMarker },
    ),
  );
  return { commentId: created.data.id };
}
