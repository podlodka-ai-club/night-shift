import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client, Connection, ScheduleClient, ScheduleNotFoundError, WorkflowNotFoundError } from "@temporalio/client";
import { createInMemoryFakeGitHubClient } from "../../github/index.js";
import { startPickupSchedule, startWorker } from "../worker.js";

vi.mock("../../phases/specify/phase.js", async () => {
  const actual = await vi.importActual<typeof import("../../phases/specify/phase.js")>("../../phases/specify/phase.js");
  return {
    ...actual,
    runSpecifyPhase: vi.fn(async (deps: { github: { setStatus(itemId: string, status: string): Promise<void> } }, input: { itemId: string; changeName: string }) => {
      await deps.github.setStatus(input.itemId, "Refined" as never);
      return {
        status: "refined",
        bundle: {
          specPath: "/tmp/openspec/changes/schedule-e2e",
          branch: "ticket-1-schedule-e2e",
          openQuestions: [],
          assumptions: ["Local e2e stub"],
          risks: [],
          commitSha: "abcdef1",
        },
        openQuestions: [],
        assumptions: ["Local e2e stub"],
        risks: [],
        summary: `Specify ready for ${input.changeName}`,
      };
    }),
  };
});

vi.mock("../../phases/implement/phase.js", async () => {
  const actual = await vi.importActual<typeof import("../../phases/implement/phase.js")>("../../phases/implement/phase.js");
  return {
    ...actual,
    runImplementPhase: vi.fn(async (deps: { github: any }, input: { itemId: string; changeName: string }) => {
      const item = await deps.github.getItem(input.itemId);
      const issue = await deps.github.getIssue(item.issueNumber);
      await deps.github.setStatus(input.itemId, "In review");

      return {
        status: "pr_opened",
        ticketId: item.ticketId,
        ticket: {
          id: `${deps.github.owner}/${deps.github.repo}#${issue.number}`,
          title: issue.title,
          description: issue.body ?? "",
          status: "Ready",
          labels: issue.labels,
          url: issue.htmlUrl,
          source: "github",
          sourceRef: {
            kind: "github",
            projectNodeId: deps.github.projectNodeId,
            projectItemId: input.itemId,
            repoOwner: deps.github.owner,
            repoName: deps.github.repo,
            issueNumber: issue.number,
          },
        },
        specBundle: {
          specPath: "/tmp/openspec/changes/schedule-e2e",
          branch: "ticket-1-schedule-e2e",
          openQuestions: [],
          assumptions: ["Local e2e stub"],
          risks: [],
          commitSha: "abcdef1",
        },
        result: {
          pr: {
            number: 1,
            url: `https://github.com/${deps.github.owner}/${deps.github.repo}/pull/1`,
            branch: "ticket-1-schedule-e2e",
            baseBranch: "main",
            headSha: "abcdef1",
          },
          qualityGates: [],
          summary: `Implement complete for ${input.changeName}`,
        },
        summary: `Implement complete for ${input.changeName}`,
      };
    }),
  };
});

vi.mock("../../phases/review/phase.js", async () => {
  const actual = await vi.importActual<typeof import("../../phases/review/phase.js")>("../../phases/review/phase.js");
  return {
    ...actual,
    runReviewPhase: vi.fn(async (phaseInput: { itemId: string; input: { iteration: number } }, deps: { github: { setStatus(itemId: string, status: string): Promise<void> } }) => {
      await deps.github.setStatus(phaseInput.itemId, "Ready to merge" as never);
      return {
        status: "ready_to_merge",
        result: {
          verdict: "ready-to-merge",
          findings: [],
          iteration: phaseInput.input.iteration,
          summary: "No blocking findings",
        },
      };
    }),
  };
});

const namespace = process.env.TEMPORAL_E2E_NAMESPACE;
const describeIfConfigured = namespace ? describe : describe.skip;

async function waitFor<T>(
  fn: () => Promise<T>,
  predicate: (value: T) => boolean | Promise<boolean>,
  timeoutMs: number,
  intervalMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastValue: T | undefined;

  while (Date.now() < deadline) {
    lastValue = await fn();
    if (await predicate(lastValue)) {
      return lastValue;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Timed out waiting for condition. Last value: ${JSON.stringify(lastValue)}`);
}

describeIfConfigured("pickup schedule e2e", () => {
  const github = createInMemoryFakeGitHubClient({ owner: "acme", repo: "night-shift" });
  const config = {
    roles: {},
    temporal: {
      serverUrl: "localhost:7233",
      namespace: namespace!,
      taskQueue: `pickup-e2e-${Date.now()}`,
    },
    pickup: {
      enabled: true,
      intervalSeconds: 10,
      maxConcurrent: 5,
    },
  } as const;

  const depsFactory = {
    buildSpecifyDeps: () => ({ github }) as any,
    buildImplementDeps: () => ({ github }) as any,
    buildReviewDeps: () => ({ github }) as any,
  };

  let worker: Awaited<ReturnType<typeof startWorker>> | undefined;
  let workerRunPromise: Promise<void> | undefined;
  let connection: Connection | undefined;
  let client: Client | undefined;
  let scheduleClient: ScheduleClient | undefined;

  beforeAll(async () => {
    connection = await Connection.connect({ address: config.temporal.serverUrl });
    client = new Client({ connection, namespace: config.temporal.namespace });
    scheduleClient = new ScheduleClient({ connection, namespace: config.temporal.namespace });

    worker = await startWorker({ config: config as any, depsFactory: depsFactory as any, github });
    workerRunPromise = worker.run();
    await startPickupSchedule({ config: config as any });
  }, 30_000);

  afterAll(async () => {
    if (scheduleClient) {
      try {
        await scheduleClient.getHandle("pickup-schedule").delete();
      } catch (error) {
        if (!(error instanceof ScheduleNotFoundError)) {
          throw error;
        }
      }
    }

    if (client) {
      try {
        await client.workflow.getHandle("ticket-1").terminate("e2e cleanup");
      } catch (error) {
        if (!(error instanceof WorkflowNotFoundError)) {
          throw error;
        }
      }
    }

    if (worker) {
      worker.shutdown();
    }
    await workerRunPromise;
  }, 30_000);

  it("starts from Backlog, picks up Ready via schedule, and reaches Ready to merge", async () => {
    const ticket = await github.createProjectTicket({
      title: "Schedule E2E smoke",
      body: "Local fake GitHub ticket for schedule pickup e2e",
      status: "Backlog",
      labels: ["e2e"],
    });

    const workflowHandle = await waitFor(
      async () => client!.workflow.getHandle(`ticket-${ticket.ticketId}`),
      async (handle) => {
        try {
          await handle.describe();
          return true;
        } catch {
          return false;
        }
      },
      15_000,
      500,
    );

    const blockedReason = await waitFor(
      async () => workflowHandle.query<string | null>("getBlockedReason"),
      (value) => value === "awaiting_spec_review",
      15_000,
      500,
    );
    expect(blockedReason).toBe("awaiting_spec_review");
    expect((await github.getItem(ticket.itemId)).status).toBe("Refined");

    await github.setStatus(ticket.itemId, "Ready");

    await waitFor(
      async () => (await github.getItem(ticket.itemId)).status,
      (status) => status === "Ready to merge",
      20_000,
      500,
    );

    await workflowHandle.result();

    expect((await github.getItem(ticket.itemId)).status).toBe("Ready to merge");
    expect(github.events.some((event) => event.kind === "listItemsByStatus" && event.args.status === "Ready")).toBe(true);
  }, 45_000);
});