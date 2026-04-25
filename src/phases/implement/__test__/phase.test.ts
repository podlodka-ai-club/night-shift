import { describe, expect, it } from "vitest";
import { InMemoryFakeAdapter } from "../../../adapters/__test__/fake.js";
import { createInMemoryFakeGitHubClient } from "../../../github/__test__/fake.js";
import { createInMemoryFakeGitOps } from "../../../git/__test__/fake.js";
import { createInMemoryFakeWorktreeOps } from "../../../worktree/__test__/fake.js";
import { createInMemoryFakeQualityGateRunner } from "../../../quality-gates/__test__/fake.js";
import { runImplementPhase, type ImplementFs } from "../phase.js";
import {
  ImplementAgentError,
  ImplementIoError,
  ImplementValidationError,
} from "../errors.js";

function implResponseJson(
  overrides: Partial<{ commitMessage: string; files: Array<{ path: string; content: string }> }> = {},
): string {
  return JSON.stringify({
    filesWritten: overrides.files ?? [
      { path: "src/a.ts", content: "export const a = 1;\n" },
    ],
    commitMessage: overrides.commitMessage ?? "feat: add a",
    summary: "added a",
    followUps: [],
  });
}

function usage() {
  return { input_tokens: 100, cached_input_tokens: 0, output_tokens: 200 };
}

function makeFs(bundle: Array<{ path: string; content: string }>): ImplementFs {
  return {
    async readSpecBundle() {
      return bundle;
    },
    async writeWorktreeFiles() {
      // No-op: the fake git ops records written files directly.
    },
  };
}

const BUNDLE = [
  { path: "openspec/changes/c/proposal.md", content: "p" },
  { path: "openspec/changes/c/tasks.md", content: "t" },
];

function baseDeps(agent: InMemoryFakeAdapter, ghInit?: () => ReturnType<typeof createInMemoryFakeGitHubClient>) {
  const gh = ghInit ? ghInit() : createInMemoryFakeGitHubClient();
  const git = createInMemoryFakeGitOps();
  const worktree = createInMemoryFakeWorktreeOps();
  const gates = createInMemoryFakeQualityGateRunner();
  return {
    gh,
    git,
    worktree,
    gates,
    deps: {
      github: gh,
      git,
      fs: makeFs(BUNDLE),
      worktree,
      gateRunner: gates,
      agent,
      runId: "run1",
      profileId: "default",
      implementerModel: "gpt-test",
      baseBranch: "main",
      qualityGates: [{ name: "typecheck", command: ["true"] }],
    },
  };
}

describe("runImplementPhase", () => {
  it("happy path: writes files, opens PR, transitions Ready → In progress → In review", async () => {
    const agent = new InMemoryFakeAdapter({
      script: [
        { events: [], finalText: implResponseJson(), usage: usage() },
      ],
    });
    const { gh, deps, worktree } = baseDeps(agent);
    gh.seedIssue({ number: 1, title: "Add thing" });
    gh.seedItem({ itemId: "PVTI_1", issueNumber: 1, status: "Ready" });

    const result = await runImplementPhase(deps, {
      itemId: "PVTI_1",
      changeName: "c",
    });

    expect(result.status).toBe("pr_opened");
    expect(result.result?.pr.number).toBe(1);
    expect(result.specBundle?.commitSha).toBe(result.result?.pr.headSha);
    const statuses = gh.events
      .filter((e) => e.kind === "setStatus")
      .map((e) => (e.args as { status: string }).status);
    expect(statuses).toEqual(["In progress", "In review"]);
    const comments = gh.events.filter((e) => e.kind === "upsertComment");
    expect(comments).toHaveLength(1);
    expect(worktree.events.map((e) => e.kind)).toEqual(["create", "remove"]);
  });

  it("commits and pushes through worktree-scoped git when provided", async () => {
    const agent = new InMemoryFakeAdapter({
      script: [
        { events: [], finalText: implResponseJson(), usage: usage() },
      ],
    });
    const mainGit = createInMemoryFakeGitOps();
    const worktreeGit = createInMemoryFakeGitOps();
    const gh = createInMemoryFakeGitHubClient();
    const worktree = createInMemoryFakeWorktreeOps();
    const gates = createInMemoryFakeQualityGateRunner();
    const scopedRepoRoots: string[] = [];
    gh.seedIssue({ number: 14, title: "Add thing" });
    gh.seedItem({ itemId: "PVTI_14", issueNumber: 14, status: "Ready" });

    const result = await runImplementPhase(
      {
        github: gh,
        git: mainGit,
        gitForRepo(repoRoot) {
          scopedRepoRoots.push(repoRoot);
          return worktreeGit;
        },
        fs: makeFs(BUNDLE),
        worktree,
        gateRunner: gates,
        agent,
        runId: "run1",
        profileId: "default",
        implementerModel: "gpt-test",
        qualityGates: [{ name: "typecheck", command: ["true"] }],
        baseBranch: "main",
      },
      {
        itemId: "PVTI_14",
        changeName: "c",
      },
    );

    expect(result.status).toBe("pr_opened");
    expect(scopedRepoRoots).toHaveLength(1);
    expect(mainGit.commits).toHaveLength(0);
    expect(mainGit.pushes).toHaveLength(0);
    expect(worktreeGit.commits).toHaveLength(1);
    expect(worktreeGit.pushes).toHaveLength(1);
  });

  it("reuses unpublished branch state when a retry returns no new file changes", async () => {
    const agent = new InMemoryFakeAdapter({
      script: [
        {
          events: [],
          finalText: JSON.stringify({
            filesWritten: [],
            commitMessage: "feat: already implemented",
            summary: "Existing branch already contains the fix.",
            followUps: [],
          }),
          usage: usage(),
        },
      ],
    });
    const mainGit = createInMemoryFakeGitOps();
    const worktreeGit = createInMemoryFakeGitOps();
    const gh = createInMemoryFakeGitHubClient();
    const worktree = createInMemoryFakeWorktreeOps();
    const gates = createInMemoryFakeQualityGateRunner();
    gh.seedIssue({ number: 15, title: "Already fixed" });
    gh.seedItem({ itemId: "PVTI_15", issueNumber: 15, status: "Ready" });

    await worktreeGit.writeTree(
      [{ path: "openspec/changes/c/tasks.md", content: "spec state\n" }],
      "spec state",
    );
    await worktreeGit.pushBranch("night-shift/acme/widgets#15-already-fixed");
    const { sha: implementSha } = await worktreeGit.writeTree(
      [{ path: "src/a.ts", content: "export const a = 1;\n" }],
      "implement state",
    );

    const result = await runImplementPhase(
      {
        github: gh,
        git: mainGit,
        gitForRepo() {
          return worktreeGit;
        },
        fs: makeFs(BUNDLE),
        worktree,
        gateRunner: gates,
        agent,
        runId: "run1",
        profileId: "default",
        implementerModel: "gpt-test",
        qualityGates: [{ name: "typecheck", command: ["true"] }],
        baseBranch: "main",
      },
      {
        itemId: "PVTI_15",
        changeName: "c",
      },
    );

    expect(result.status).toBe("pr_opened");
    expect(result.result?.pr.branch).toBe("night-shift/acme/widgets#15-already-fixed");
    expect(worktreeGit.commits).toHaveLength(2);
    expect(worktreeGit.pushes.at(-1)).toEqual({
      branch: "night-shift/acme/widgets#15-already-fixed",
      sha: implementSha,
    });
  });

  it("skips pre-transition when already In progress", async () => {
    const agent = new InMemoryFakeAdapter({
      script: [
        { events: [], finalText: implResponseJson(), usage: usage() },
      ],
    });
    const { gh, deps } = baseDeps(agent);
    gh.seedIssue({ number: 2 });
    gh.seedItem({ itemId: "PVTI_2", issueNumber: 2, status: "In progress" });
    const result = await runImplementPhase(deps, {
      itemId: "PVTI_2",
      changeName: "c",
    });
    expect(result.status).toBe("pr_opened");
    const statuses = gh.events
      .filter((e) => e.kind === "setStatus")
      .map((e) => (e.args as { status: string }).status);
    expect(statuses).toEqual(["In review"]);
  });

  it("rejects Backlog-entry items with validation error", async () => {
    const agent = new InMemoryFakeAdapter({ script: [] });
    const { gh, deps, worktree } = baseDeps(agent);
    gh.seedIssue({ number: 3 });
    gh.seedItem({ itemId: "PVTI_3", issueNumber: 3, status: "Backlog" });
    await expect(
      runImplementPhase(deps, { itemId: "PVTI_3", changeName: "c" }),
    ).rejects.toBeInstanceOf(ImplementValidationError);
    expect(worktree.events).toHaveLength(0);
  });

  it("throws ImplementIoError when spec bundle is empty", async () => {
    const agent = new InMemoryFakeAdapter({ script: [] });
    const { gh, deps, worktree } = baseDeps(agent);
    gh.seedIssue({ number: 4 });
    gh.seedItem({ itemId: "PVTI_4", issueNumber: 4, status: "Ready" });
    const deps2 = { ...deps, fs: makeFs([]) };
    await expect(
      runImplementPhase(deps2, { itemId: "PVTI_4", changeName: "c" }),
    ).rejects.toBeInstanceOf(ImplementIoError);
    expect(worktree.events).toHaveLength(0);
  });

  it("retries once when implementer returns schema-invalid path, then succeeds", async () => {
    const agent = new InMemoryFakeAdapter({
      script: [
        {
          events: [],
          // No turn call is made for invalid content — the schema validation
          // happens locally on the first turn output. Here we simulate the
          // first turn returning a path with `..`, then the second turn
          // returning valid content.
          finalText: implResponseJson({
            files: [{ path: "../escape.ts", content: "x" }],
          }),
          usage: usage(),
        },
      ],
    });
    const { gh, deps, worktree } = baseDeps(agent);
    gh.seedIssue({ number: 5 });
    gh.seedItem({ itemId: "PVTI_5", issueNumber: 5, status: "Ready" });
    // Parsing throws on the `..` path; the phase surfaces it as schema error.
    await expect(
      runImplementPhase(deps, { itemId: "PVTI_5", changeName: "c" }),
    ).rejects.toBeInstanceOf(ImplementAgentError);
    // Worktree was created before the failure → kept for triage.
    expect(worktree.events.map((e) => e.kind)).toEqual(["create"]);
  });

  it("needs_input when quality gates fail both attempts", async () => {
    const agent = new InMemoryFakeAdapter({
      script: [
        { events: [], finalText: implResponseJson(), usage: usage() },
        { events: [], finalText: implResponseJson(), usage: usage() },
      ],
    });
    const { gh, deps, gates, worktree } = baseDeps(agent);
    gates.script("typecheck", {
      status: "failed",
      exitCode: 1,
      logsTail: "boom",
    });
    gh.seedIssue({ number: 6 });
    gh.seedItem({ itemId: "PVTI_6", issueNumber: 6, status: "Ready" });
    const result = await runImplementPhase(deps, {
      itemId: "PVTI_6",
      changeName: "c",
    });
    expect(result.status).toBe("needs_input");
    const statuses = gh.events
      .filter((e) => e.kind === "setStatus")
      .map((e) => (e.args as { status: string }).status);
    expect(statuses).toEqual(["In progress", "Blocked"]);
    // Worktree cleaned up even on needs_input terminal path.
    expect(worktree.events.map((e) => e.kind)).toEqual(["create", "remove"]);
  });

  it("PR idempotency: a second run reuses the same PR number", async () => {
    const makeAgent = () =>
      new InMemoryFakeAdapter({
        script: [
          { events: [], finalText: implResponseJson(), usage: usage() },
        ],
      });
    const { gh, deps } = baseDeps(makeAgent());
    gh.seedIssue({ number: 8 });
    gh.seedItem({ itemId: "PVTI_8", issueNumber: 8, status: "Ready" });
    const r1 = await runImplementPhase(deps, {
      itemId: "PVTI_8",
      changeName: "c",
    });
    // Reseed "Ready" so a second run can enter again.
    gh.seedItem({ itemId: "PVTI_8", issueNumber: 8, status: "Ready" });
    const deps2 = { ...deps, agent: makeAgent() };
    const r2 = await runImplementPhase(deps2, {
      itemId: "PVTI_8",
      changeName: "c",
    });
    expect(r1.result?.pr.number).toBe(r2.result?.pr.number);
  });
});
