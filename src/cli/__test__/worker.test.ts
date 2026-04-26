import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mockLoadRepoLocalConfig = vi.fn();
const mockCreateRoleAdapter = vi.fn(() => ({ openSession: vi.fn() }));
const mockCreateGitHubClient = vi.fn();
const mockStartWorker = vi.fn();
const mockRunWorkerUntilShutdown = vi.fn();
const mockStartPickupSchedule = vi.fn();
const mockAcquireWorkerLock = vi.fn();
const mockCreateSimpleGitOps = vi.fn(({ repoRoot }) => ({ repoRoot }));
const mockCreateSimpleGitWorktreeOps = vi.fn(({ repoRoot }) => ({ repoRoot }));
const mockCreateNodeQualityGateRunner = vi.fn(() => ({ run: vi.fn() }));
const mockCreateOpenSpecCliValidate = vi.fn().mockResolvedValue({ ok: true });
const mockCreateOpenSpecCli = vi.fn(() => ({
  validate: mockCreateOpenSpecCliValidate,
}));

vi.mock("../shared.js", () => ({
  loadRepoLocalConfig: (...args: unknown[]) => mockLoadRepoLocalConfig(...args),
  createRoleAdapter: (...args: unknown[]) => mockCreateRoleAdapter(...args),
}));

vi.mock("../../github/factory.js", () => ({
  createGitHubClient: (...args: unknown[]) => mockCreateGitHubClient(...args),
}));

vi.mock("../worker-lock.js", () => ({
  acquireWorkerLock: (...args: unknown[]) => mockAcquireWorkerLock(...args),
}));

vi.mock("../../orchestration/worker.js", () => ({
  startWorker: (...args: unknown[]) => mockStartWorker(...args),
  startPickupSchedule: (...args: unknown[]) => mockStartPickupSchedule(...args),
  runWorkerUntilShutdown: (...args: unknown[]) => mockRunWorkerUntilShutdown(...args),
}));

vi.mock("../../git/index.js", () => ({
  createSimpleGitOps: (arg: unknown) => mockCreateSimpleGitOps(arg),
}));

vi.mock("../../worktree/index.js", () => ({
  createSimpleGitWorktreeOps: (arg: unknown) => mockCreateSimpleGitWorktreeOps(arg),
}));

vi.mock("../../quality-gates/index.js", () => ({
  createNodeQualityGateRunner: () => mockCreateNodeQualityGateRunner(),
}));

vi.mock("../../phases/specify/openspec-cli.js", () => ({
  createOpenSpecCli: () => mockCreateOpenSpecCli(),
}));

vi.mock("simple-git", () => ({
  simpleGit: vi.fn((repoRoot: string) => ({ repoRoot })),
}));

const resolvedConfig = {
  roles: {
    specifier: { provider: "codex", model: "gpt-spec" },
    implementer: { provider: "codex", model: "gpt-impl" },
    reviewer: { provider: "codex", model: "gpt-review" },
  },
  temporal: {
    serverUrl: "localhost:7233",
    namespace: "default",
    taskQueue: "night-shift",
  },
  pickup: {
    enabled: true,
    intervalSeconds: 10,
    maxConcurrent: 5,
  },
  github: {
    token: "test-token",
    owner: "acme",
    repo: "widgets",
    projectNumber: 1,
    projectOwner: "acme",
    projectOwnerType: "org",
  },
};

const fakeGitHubClient = {
  owner: "acme",
  repo: "widgets",
  projectNodeId: "PVT_1",
};

import { main } from "../worker.js";

describe("night-shift worker CLI", () => {
  let stdout = "";

  beforeEach(() => {
    vi.clearAllMocks();
    stdout = "";
    mockCreateGitHubClient.mockResolvedValue(fakeGitHubClient);
    mockStartWorker.mockResolvedValue({});
    mockRunWorkerUntilShutdown.mockResolvedValue(undefined);
    mockStartPickupSchedule.mockResolvedValue(undefined);
    mockAcquireWorkerLock.mockResolvedValue({
      lockPath: "/tmp/repo/.night-shift/locks/worker.json",
      release: vi.fn().mockResolvedValue(undefined),
    });
    mockCreateOpenSpecCliValidate.mockResolvedValue({ ok: true });
    vi.spyOn(process.stdout, "write").mockImplementation((s) => {
      stdout += String(s);
      return true;
    });
  });

  it("uses repoRoot from config for local phase deps", async () => {
    const repoRoot = path.resolve("../feature-factory-target");
    mockLoadRepoLocalConfig.mockResolvedValue({
      config: {
        ...resolvedConfig,
        temporal: {
          ...resolvedConfig.temporal,
          taskQueue: "night-shift-abc123",
        },
      },
      repoRoot,
    });

    const code = await main([
      "--config",
      "./night-shift.config.ts",
      "--repo-root",
      repoRoot,
    ]);

    expect(code).toBe(0);
    expect(mockLoadRepoLocalConfig).toHaveBeenCalledWith({
      explicitPath: "./night-shift.config.ts",
      repoRoot,
    });
    expect(mockAcquireWorkerLock).toHaveBeenCalledWith(repoRoot, "night-shift-abc123");

    const workerArgs = mockStartWorker.mock.calls[0]?.[0] as {
      depsFactory: {
        buildSpecifyDeps(runId: string, profileId: string): {
          worktree: unknown;
          gitForRepo(repoRoot: string): unknown;
          openspecCli: { validate(name: string, opts?: { strict?: boolean; cwd?: string }): Promise<unknown> };
        };
        buildReviewDeps(runId: string, profileId: string): { workingDirectory?: string };
      };
    };

    const specifyDeps = workerArgs.depsFactory.buildSpecifyDeps("run-1", "default");
    expect(specifyDeps.worktree).toEqual({ repoRoot });
    const worktreePath = path.join(repoRoot, ".worktrees", "ticket-1");
    specifyDeps.gitForRepo(worktreePath);
    expect(mockCreateSimpleGitOps).toHaveBeenCalledWith({
      repoRoot: worktreePath,
      git: { repoRoot: worktreePath },
    });
    await specifyDeps.openspecCli.validate("change-1", { strict: false, cwd: "/tmp/specify-worktree" });
    expect(mockCreateOpenSpecCliValidate).toHaveBeenCalledWith("change-1", {
      strict: false,
      cwd: "/tmp/specify-worktree",
    });

    const reviewDeps = workerArgs.depsFactory.buildReviewDeps("run-2", "default");
    expect(reviewDeps.workingDirectory).toBe(repoRoot);
  });

  it("reports when pickup cron is disabled in config", async () => {
    mockLoadRepoLocalConfig.mockResolvedValue({
      config: {
        ...resolvedConfig,
        pickup: undefined,
      },
      repoRoot: "/tmp/repo",
    });

    const code = await main([]);

    expect(code).toBe(0);
    expect(mockStartPickupSchedule).not.toHaveBeenCalled();
    expect(stdout).toContain("Pickup schedule disabled");
  });

  it("releases the worker lock when startup fails", async () => {
    const release = vi.fn().mockResolvedValue(undefined);
    mockAcquireWorkerLock.mockResolvedValue({
      lockPath: "/tmp/repo/.night-shift/locks/worker.json",
      release,
    });
    mockLoadRepoLocalConfig.mockResolvedValue({
      config: {
        ...resolvedConfig,
      },
      repoRoot: "/tmp/repo",
    });
    mockStartWorker.mockRejectedValue(new Error("boom"));

    const code = await main([]);

    expect(code).toBe(1);
    expect(release).toHaveBeenCalledOnce();
  });
});