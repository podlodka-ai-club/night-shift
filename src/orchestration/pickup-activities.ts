import { Client, Connection } from "@temporalio/client";
import type { GitHubClient } from "../github/client.js";
import type { ProjectItemSummary } from "../github/types.js";
import { deriveChangeName } from "../contracts/helpers.js";
import { handleWorkflowTrigger } from "./webhook-bridge.js";

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

export interface StartTicketWorkflowsInput {
  items: ScanBoardResult["items"];
  maxStarts: number;
  taskQueue: string;
}

export interface StartTicketWorkflowsResult {
  started: number;
  signaled: number;
  skipped: number;
}

let _github: GitHubClient | undefined;
let _temporalAddress: string = "localhost:7233";
let _temporalNamespace: string = "default";

export function setPickupGitHubClient(github: GitHubClient): void {
  _github = github;
}

export function setPickupTemporalConfig(address: string, namespace: string): void {
  _temporalAddress = address;
  _temporalNamespace = namespace;
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

export async function startTicketWorkflowsActivity(
  input: StartTicketWorkflowsInput,
): Promise<StartTicketWorkflowsResult> {
  const connection = await Connection.connect({ address: _temporalAddress });
  const client = new Client({ connection, namespace: _temporalNamespace });

  let started = 0;
  let signaled = 0;
  let skipped = 0;

  for (const item of input.items) {
    if (started + signaled >= input.maxStarts) {
      break;
    }

    const workflowId = `ticket-${item.ticketId}`;
    const result = await handleWorkflowTrigger(
      {
        action: "pickup.scan",
        currentStatus: item.startPhase === "specify" ? "Backlog" : "Ready",
        itemId: item.itemId,
        ticketId: item.ticketId,
        changeName: item.changeName,
      },
      client,
      input.taskQueue,
    );

    if (result.action === "started") {
      started++;
      continue;
    }

    if (result.action === "signaled") {
      signaled++;
      continue;
    }

    skipped++;
  }

  return { started, signaled, skipped };
}
