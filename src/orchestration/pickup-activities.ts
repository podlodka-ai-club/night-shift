import type { GitHubClient } from "../github/client.js";
import type { ProjectItemSummary } from "../github/types.js";
import { deriveChangeName } from "../contracts/helpers.js";

export interface ScanBoardResult {
  items: Array<{
    itemId: string;
    ticketId: string;
    issueNumber: number;
    title: string;
    changeName: string;
    startPhase: "specify" | "implement";
  }>;
}

let _github: GitHubClient | undefined;

export function setPickupGitHubClient(github: GitHubClient): void {
  _github = github;
}

function getGitHubClient(): GitHubClient {
  if (!_github) {
    throw new Error("Pickup GitHub client not initialized. Call setPickupGitHubClient first.");
  }
  return _github;
}

export async function scanBoardActivity(): Promise<ScanBoardResult> {
  const github = getGitHubClient();

  const [backlogItems, readyItems] = await Promise.all([
    github.listItemsByStatus("Backlog"),
    github.listItemsByStatus("Ready"),
  ]);

  const tagged: Array<ProjectItemSummary & { startPhase: "specify" | "implement" }> = [
    ...backlogItems.map((it) => ({ ...it, startPhase: "specify" as const })),
    ...readyItems.map((it) => ({ ...it, startPhase: "implement" as const })),
  ];

  tagged.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  return {
    items: tagged.map((it) => ({
      itemId: it.itemId,
      ticketId: it.ticketId,
      issueNumber: it.issueNumber,
      title: it.title,
      changeName: deriveChangeName(it.title, it.issueNumber),
      startPhase: it.startPhase,
    })),
  };
}
