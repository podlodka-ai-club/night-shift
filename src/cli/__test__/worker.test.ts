import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockLoadConfig = vi.fn();
const mockCreateGitHubClient = vi.fn();
const mockStartWorker = vi.fn();
const mockRunWorkerUntilShutdown = vi.fn();
const mockStartPickupCronWorkflow = vi.fn();
const mockCreateSimpleGitOps = vi.fn(({ repoRoot }) => ({ repoRoot }));
const mockCreateSimpleGitWorktreeOps = vi.fn(({ repoRoot }) => ({ repoRoot }));
const mockCreateNodeQualityGateRunner = vi.fn(() => ({ run: vi.fn() }));
const mockCreateOpenSpecCliValidate = vi.fn().mockResolvedValue({ ok: true });
const mockCreateOpenSpecCli = vi.fn(() => ({
  validate: mockCreateOpenSpecCliValidate,
}));

vi.mock("../../config/loader.js", () => ({
  loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
}));

vi.mock("../../github/factory.js", () => ({
  createGitHubClient: (...args: unknown[]) => mockCreateGitHubClient(...args),
}));

vi.mock("../../orchestration/worker.js", () => ({
  startWorker: (...args: unknown[]) => mockStartWorker(...args),
  startPickupCronWorkflow: (...args: unknown[]) => mockStartPickupCronWorkflow(...args),
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
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateGitHubClient.mockResolvedValue(fakeGitHubClient);
    mockStartWorker.mockResolvedValue({});
    mockRunWorkerUntilShutdown.mockResolvedValue(undefined);
    mockStartPickupCronWorkflow.mockResolvedValue(undefined);
    mockCreateOpenSpecCliValidate.mockResolvedValue({ ok: true });
  });

  it("uses repoRoot from config for local phase deps", async () => {
    const repoRoot = path.resolve("../feature-factory-target");
    mockLoadConfig.mockResolvedValue({
      ...resolvedConfig,
    });

    const code = await main([
      "--config",
      "./night-shift.config.ts",
      "--repo-root",
      repoRoot,
    ]);

    expect(code).toBe(0);
    expect(mockLoadConfig).toHaveBeenCalledWith({
      explicitPath: "./night-shift.config.ts",
      cwd: repoRoot,
    });

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
});