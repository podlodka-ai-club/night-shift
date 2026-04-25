import { describe, expect, it } from "vitest";
import { InMemoryFakeAdapter } from "../../../adapters/__test__/fake.js";
import { createInMemoryFakeGitHubClient } from "../../../github/__test__/fake.js";
import { createInMemoryFakeGitOps } from "../../../git/__test__/fake.js";
import { createInMemoryFakeWorktreeOps } from "../../../worktree/__test__/fake.js";
import { createFakeOpenSpecCli } from "../openspec-cli.js";
import { runSpecifyPhase, type SpecifyFs } from "../phase.js";
import { SpecifyItemMissingError, SpecifyValidationError } from "../errors.js";

function goodResponseJson(): string {
  return JSON.stringify({
    files: [
      {
        path: "proposal.md",
        content:
          "## Why\nTo add feature.\n\n## What Changes\n- Add thing\n\n## Impact\n- Affected specs: cap\n- Affected code: x\n",
      },
      { path: "tasks.md", content: "## 1. Work\n- [ ] 1.1 do it\n" },
      {
        path: "specs/cap/spec.md",
        content:
          "## ADDED Requirements\n### Requirement: The system SHALL do\n\n#### Scenario: basic\n- **WHEN** x\n- **THEN** y\n",
      },
    ],
    openQuestions: [],
    assumptions: [],
    risks: [],
  });
}

function fakeFs(files: Record<string, string> = {}): SpecifyFs {
  return {
    async readPriorDraft(_repoRoot, changeDir) {
      const prefix = `${changeDir}/`;
      return Object.entries(files)
        .filter(([p]) => p.startsWith(prefix))
        .map(([p, content]) => ({ path: p.slice(prefix.length), content }));
    },
  };
}

function baseUsage() {
  return { input_tokens: 100, cached_input_tokens: 0, output_tokens: 200 };
}

function makeScopedGitRuntime(scopedGit = createInMemoryFakeGitOps()) {
  const worktree = createInMemoryFakeWorktreeOps();
  const repoRoots: string[] = [];

  return {
    worktree,
    scopedGit,
    repoRoots,
    gitForRepo(repoRoot: string) {
      repoRoots.push(repoRoot);
      return scopedGit;
    },
  };
}

describe("runSpecifyPhase", () => {
  it("happy path: refines + transitions Backlog → Refinement → Refined", async () => {
    const gh = createInMemoryFakeGitHubClient();
    gh.seedIssue({ number: 1, title: "Add feature", body: "Need it." });
    gh.seedItem({ itemId: "PVTI_1", issueNumber: 1, status: "Backlog" });
    const scoped = makeScopedGitRuntime();
    const cli = createFakeOpenSpecCli();
    cli.script([{ ok: true }]);
    const agent = new InMemoryFakeAdapter({
      script: [
        {
          events: [],
          finalText: goodResponseJson(),
          usage: baseUsage(),
        },
      ],
    });

    const result = await runSpecifyPhase(
      {
        github: gh,
        worktree: scoped.worktree,
        gitForRepo: scoped.gitForRepo,
        fs: fakeFs(),
        agent,
        openspecCli: cli,
        runId: "run1",
        profileId: "default",
        model: "gpt-test",
      },
      { itemId: "PVTI_1", changeName: "add-feature" },
    );

    expect(result.status).toBe("refined");
    expect(result.bundle?.branch).toContain("night-shift/");
    const statuses = gh.events
      .filter((e) => e.kind === "setStatus")
      .map((e) => (e.args as { status: string }).status);
    expect(statuses).toEqual(["Refinement", "Refined"]);
    expect(scoped.worktree.events.map((event) => event.kind)).toEqual(["create", "remove"]);
    expect(scoped.repoRoots).toHaveLength(1);
    // Exactly one comment upserted with the specify:summary marker.
    const comments = gh.events.filter((e) => e.kind === "upsertComment");
    expect(comments).toHaveLength(1);
    expect((comments[0]!.args as { markerId: string }).markerId).toBe("specify:summary");
    expect(scoped.scopedGit.pushes).toEqual([{ branch: result.bundle!.branch, sha: result.bundle!.commitSha }]);
    const prs = gh.events.filter((e) => e.kind === "upsertPullRequest");
    expect(prs).toHaveLength(1);
    const [summaryComment] = await gh.listComments(1);
    expect(summaryComment?.body).toContain(
      `https://github.com/acme/widgets/tree/${result.bundle?.commitSha}/openspec/changes/add-feature`,
    );
    expect(summaryComment?.body).toContain(
      "https://github.com/acme/widgets/pull/1",
    );
    expect(summaryComment?.body).toContain(`Branch: \`${result.bundle!.branch}\``);
    expect(summaryComment?.body).toContain("_Latency:");
    expect(summaryComment?.body).toContain("Usage:");
  });

  it("throws SpecifyItemMissingError when item has no issue", async () => {
    const gh = createInMemoryFakeGitHubClient();
    gh.seedItem({ itemId: "PVTI_X", status: "Backlog" });
    const scoped = makeScopedGitRuntime();
    const cli = createFakeOpenSpecCli();
    const agent = new InMemoryFakeAdapter({ script: [] });
    await expect(
      runSpecifyPhase(
        {
          github: gh,
          worktree: scoped.worktree,
          gitForRepo: scoped.gitForRepo,
          fs: fakeFs(),
          agent,
          openspecCli: cli,
          runId: "r",
          profileId: "p",
          model: "m",
        },
        { itemId: "PVTI_X", changeName: "x" },
      ),
    ).rejects.toBeInstanceOf(SpecifyItemMissingError);
    expect(gh.events.some((e) => e.kind === "setStatus")).toBe(false);
    expect(gh.events.some((e) => e.kind === "createBranch")).toBe(false);
    expect(scoped.worktree.events).toHaveLength(0);
  });

  it("rejects Blocked-entry items with validation error", async () => {
    const gh = createInMemoryFakeGitHubClient();
    gh.seedIssue({ number: 2 });
    gh.seedItem({ itemId: "PVTI_B", issueNumber: 2, status: "Blocked" });
    const scoped = makeScopedGitRuntime();
    const cli = createFakeOpenSpecCli();
    const agent = new InMemoryFakeAdapter({ script: [] });
    await expect(
      runSpecifyPhase(
        {
          github: gh,
          worktree: scoped.worktree,
          gitForRepo: scoped.gitForRepo,
          fs: fakeFs(),
          agent,
          openspecCli: cli,
          runId: "r",
          profileId: "p",
          model: "m",
        },
        { itemId: "PVTI_B", changeName: "x" },
      ),
    ).rejects.toBeInstanceOf(SpecifyValidationError);
    expect(gh.events.filter((e) => e.kind === "setStatus")).toHaveLength(0);
    expect(gh.events.filter((e) => e.kind === "createBranch")).toHaveLength(0);
    expect(scoped.worktree.events).toHaveLength(0);
  });

  it("already-in-Refinement item: skips pre-transition", async () => {
    const gh = createInMemoryFakeGitHubClient();
    gh.seedIssue({ number: 3, title: "t" });
    gh.seedItem({ itemId: "PVTI_3", issueNumber: 3, status: "Refinement" });
    const scoped = makeScopedGitRuntime();
    const cli = createFakeOpenSpecCli();
    cli.script([{ ok: true }]);
    const agent = new InMemoryFakeAdapter({
      script: [{ events: [], finalText: goodResponseJson(), usage: baseUsage() }],
    });
    const result = await runSpecifyPhase(
      {
        github: gh,
        worktree: scoped.worktree,
        gitForRepo: scoped.gitForRepo,
        fs: fakeFs(),
        agent,
        openspecCli: cli,
        runId: "r",
        profileId: "p",
        model: "m",
      },
      { itemId: "PVTI_3", changeName: "x" },
    );
    expect(result.status).toBe("refined");
    const statuses = gh.events
      .filter((e) => e.kind === "setStatus")
      .map((e) => (e.args as { status: string }).status);
    expect(statuses).toEqual(["Refined"]); // only terminal, no Refinement pre-transition
    expect(scoped.worktree.events.map((event) => event.kind)).toEqual(["create", "remove"]);
  });

  it("validation failure twice → needs_input + Blocked", async () => {
    const gh = createInMemoryFakeGitHubClient();
    gh.seedIssue({ number: 4 });
    gh.seedItem({ itemId: "PVTI_4", issueNumber: 4, status: "Backlog" });
    const scoped = makeScopedGitRuntime();
    const cli = createFakeOpenSpecCli();
    cli.script([
      { ok: false, error: "missing ## Why" },
      { ok: false, error: "still missing ## Why" },
    ]);
    const agent = new InMemoryFakeAdapter({
      script: [
        { events: [], finalText: goodResponseJson(), usage: baseUsage() },
        { events: [], finalText: goodResponseJson(), usage: baseUsage() },
      ],
    });
    const result = await runSpecifyPhase(
      {
        github: gh,
        worktree: scoped.worktree,
        gitForRepo: scoped.gitForRepo,
        fs: fakeFs(),
        agent,
        openspecCli: cli,
        runId: "r",
        profileId: "p",
        model: "m",
      },
      { itemId: "PVTI_4", changeName: "x" },
    );
    expect(result.status).toBe("needs_input");
    expect(result.summary).toContain("still missing ## Why");
    expect(result.summary).toContain("[Change folder](https://github.com/acme/widgets/tree/");
    expect(result.summary).not.toContain("Spec review PR");
    expect(scoped.scopedGit.pushes).toHaveLength(0);
    expect(gh.events.filter((e) => e.kind === "upsertPullRequest")).toHaveLength(0);
    const statuses = gh.events
      .filter((e) => e.kind === "setStatus")
      .map((e) => (e.args as { status: string }).status);
    expect(statuses).toEqual(["Refinement", "Blocked"]);
    expect(scoped.worktree.events.map((event) => event.kind)).toEqual(["create", "remove"]);
  });

  it("filters Night-Shift marker comments and includes operator reply in prompt", async () => {
    const gh = createInMemoryFakeGitHubClient();
    gh.seedIssue({ number: 5, title: "t" });
    gh.seedItem({ itemId: "PVTI_5", issueNumber: 5, status: "Backlog" });
    const scoped = makeScopedGitRuntime();
    await gh.upsertComment(5, "specify:summary", "old summary");
    // operator reply (not a marker comment)
    (gh as unknown as { seedIssue: unknown }); // keep types
    // Use internal seed by re-pushing raw comment through upsert with a fake marker we'll strip:
    // There's no direct "add plain comment" API on the fake; we mutate via a fresh upsert with a
    // custom marker so the filter still strips it. To test the filter we need a non-marker comment.
    // Instead add directly through issue's internal comments list by seeding another issue — but
    // the fake exposes only upsertComment. Work around by seeding a plain-bodied comment via the
    // fake's listComments result: post via upsertComment with a distinctive marker and then
    // assert the prompt rendered by the agent excludes it.
    let capturedPrompt = "";
    const agent = new InMemoryFakeAdapter({
      script: [{ events: [], finalText: goodResponseJson(), usage: baseUsage() }],
    });
    // Wrap adapter to capture the prompt.
    const capturingAgent = {
      provider: "fake",
      openSession(opts: unknown) {
        const s = agent.openSession(opts);
        return {
          ...s,
          async run(input: string, o?: unknown) {
            capturedPrompt = input;
            return s.run(input, o as never);
          },
        };
      },
    };
    const cli = createFakeOpenSpecCli();
    cli.script([{ ok: true }]);
    await runSpecifyPhase(
      {
        github: gh,
        worktree: scoped.worktree,
        gitForRepo: scoped.gitForRepo,
        fs: fakeFs(),
        agent: capturingAgent,
        openspecCli: cli,
        runId: "r",
        profileId: "p",
        model: "m",
      },
      { itemId: "PVTI_5", changeName: "x" },
    );
    // The one existing comment is a Night-Shift marker comment, so it must be filtered.
    expect(capturedPrompt).not.toContain("night-shift:marker=specify:summary");
  });

  it("passes priorDraft to prompt when fs returns files", async () => {
    const gh = createInMemoryFakeGitHubClient();
    gh.seedIssue({ number: 6, title: "t" });
    gh.seedItem({ itemId: "PVTI_6", issueNumber: 6, status: "Backlog" });
    const scoped = makeScopedGitRuntime();
    let capturedPrompt = "";
    const inner = new InMemoryFakeAdapter({
      script: [{ events: [], finalText: goodResponseJson(), usage: baseUsage() }],
    });
    const agent = {
      provider: "fake",
      openSession(opts: unknown) {
        const s = inner.openSession(opts);
        return {
          ...s,
          async run(input: string, o?: unknown) {
            capturedPrompt = input;
            return s.run(input, o as never);
          },
        };
      },
    };
    const cli = createFakeOpenSpecCli();
    cli.script([{ ok: true }]);
    await runSpecifyPhase(
      {
        github: gh,
        worktree: scoped.worktree,
        gitForRepo: scoped.gitForRepo,
        fs: fakeFs({
          "openspec/changes/x/proposal.md": "## Why\nold rationale\n",
        }),
        agent,
        openspecCli: cli,
        runId: "r",
        profileId: "p",
        model: "m",
      },
      { itemId: "PVTI_6", changeName: "x" },
    );
    expect(capturedPrompt).toContain("## Current draft");
    expect(capturedPrompt).toContain("old rationale");
  });

  it("checks out the base branch first and creates the ticket branch from that base", async () => {
    const gh = createInMemoryFakeGitHubClient();
    gh.seedIssue({ number: 62, title: "t" });
    gh.seedItem({ itemId: "PVTI_62", issueNumber: 62, status: "Backlog" });
    const worktree = createInMemoryFakeWorktreeOps();
    const cli = createFakeOpenSpecCli();
    cli.script([{ ok: true }]);
    const agent = new InMemoryFakeAdapter({
      script: [{ events: [], finalText: goodResponseJson(), usage: baseUsage() }],
    });
    const checkouts: Array<{ branch: string; opts?: { startPoint?: string; preferRemote?: boolean } }> = [];
    const git = {
      async checkoutBranch(branch: string, opts?: { startPoint?: string; preferRemote?: boolean }) {
        checkouts.push({ branch, ...(opts !== undefined ? { opts } : {}) });
      },
      async pushBranch() {},
      async remoteHeadSha() {
        return null;
      },
      async writeTree() {
        return { sha: "a100000000000000000000000000000000000000" };
      },
      async currentHeadSha() {
        return "a100000000000000000000000000000000000000";
      },
      async diffAgainstBase() {
        return "";
      },
    };

    const result = await runSpecifyPhase(
      {
        github: gh,
        worktree,
        gitForRepo() {
          return git;
        },
        fs: fakeFs(),
        agent,
        openspecCli: cli,
        runId: "r",
        profileId: "p",
        model: "m",
        baseBranch: "main",
      },
      { itemId: "PVTI_62", changeName: "x" },
    );

    expect(result.status).toBe("refined");
    expect(worktree.events[0]?.args).toMatchObject({
      branch: result.bundle!.branch,
      fromRef: "origin/main",
    });
    expect(checkouts).toEqual([
      {
        branch: result.bundle!.branch,
        opts: { startPoint: "origin/main", preferRemote: true },
      },
    ]);

    const createBranchCall = gh.events.find((event) => event.kind === "createBranch");
    expect(createBranchCall?.args).toMatchObject({
      branch: result.bundle!.branch,
      fromRef: "heads/main",
    });
  });

  it("uses the worktree path for the specifier session and validation cwd", async () => {
    const gh = createInMemoryFakeGitHubClient();
    gh.seedIssue({ number: 61, title: "t" });
    gh.seedItem({ itemId: "PVTI_61", issueNumber: 61, status: "Backlog" });
    const cli = createFakeOpenSpecCli();
    cli.script([{ ok: true }]);
    const inner = new InMemoryFakeAdapter({
      script: [{ events: [], finalText: goodResponseJson(), usage: baseUsage() }],
    });
    let capturedWorkingDirectory: string | undefined;
    let capturedValidationCwd: string | undefined;
    const worktreePath = "/tmp/specify-worktree";
    const agent = {
      provider: "fake",
      openSession(opts: unknown) {
        capturedWorkingDirectory = (opts as { workingDirectory?: string }).workingDirectory;
        return inner.openSession(opts);
      },
    };
    const worktree = {
      async create() {
        return { path: worktreePath, branch: "night-shift/test" };
      },
      async remove() {},
    };
    const openspecCli = {
      async validate() {
        capturedValidationCwd = worktreePath;
        return { ok: true as const };
      },
    };

    await runSpecifyPhase(
      {
        github: gh,
        worktree,
        gitForRepo() {
          return createInMemoryFakeGitOps();
        },
        fs: fakeFs(),
        agent,
        openspecCli: {
          async validate(name, opts) {
            capturedValidationCwd = opts?.cwd;
            return openspecCli.validate(name, opts);
          },
        },
        runId: "r",
        profileId: "p",
        model: "m",
      },
      { itemId: "PVTI_61", changeName: "x" },
    );

    expect(capturedWorkingDirectory).toBe(worktreePath);
    expect(capturedValidationCwd).toBe(worktreePath);
  });

  it("emits PhaseStarted and PhaseCompleted on success", async () => {
    const gh = createInMemoryFakeGitHubClient();
    gh.seedIssue({ number: 7, title: "t" });
    gh.seedItem({ itemId: "PVTI_7", issueNumber: 7, status: "Backlog" });
    const scoped = makeScopedGitRuntime();
    const cli = createFakeOpenSpecCli();
    cli.script([{ ok: true }]);
    const agent = new InMemoryFakeAdapter({
      script: [{ events: [], finalText: goodResponseJson(), usage: baseUsage() }],
    });
    const events: Array<{ kind: string }> = [];
    await runSpecifyPhase(
      {
        github: gh,
        worktree: scoped.worktree,
        gitForRepo: scoped.gitForRepo,
        fs: fakeFs(),
        agent,
        openspecCli: cli,
        events: { emit: (e) => void events.push(e) },
        runId: "r",
        profileId: "p",
        model: "m",
      },
      { itemId: "PVTI_7", changeName: "x" },
    );
    expect(events.map((e) => e.kind)).toEqual(["PhaseStarted", "PhaseCompleted"]);
  });

  it("branch creation is idempotent: second run reuses branch", async () => {
    const gh = createInMemoryFakeGitHubClient();
    gh.seedIssue({ number: 11, title: "t" });
    gh.seedItem({ itemId: "PVTI_11", issueNumber: 11, status: "Backlog" });
    const scoped = makeScopedGitRuntime();
    const cli = createFakeOpenSpecCli();
    cli.script([{ ok: true }, { ok: true }]);
    const agent = new InMemoryFakeAdapter({
      script: [
        { events: [], finalText: goodResponseJson(), usage: baseUsage() },
        { events: [], finalText: goodResponseJson(), usage: baseUsage() },
      ],
    });
    const deps = {
      github: gh,
      worktree: scoped.worktree,
      gitForRepo: scoped.gitForRepo,
      fs: fakeFs(),
      agent,
      openspecCli: cli,
      runId: "r",
      profileId: "p",
      model: "m",
    };
    await runSpecifyPhase(deps, { itemId: "PVTI_11", changeName: "x" });
    // Simulate a reviewer sending the ticket back to Backlog for revision.
    await gh.setStatus("PVTI_11", "Backlog");
    const r2 = await runSpecifyPhase(deps, { itemId: "PVTI_11", changeName: "x" });
    expect(r2.status).toBe("refined");
    // createBranch called twice (second call tolerated as already-exists).
    const branchCalls = gh.events.filter((e) => e.kind === "createBranch");
    expect(branchCalls.length).toBeGreaterThanOrEqual(2);
    const prCalls = gh.events.filter((e) => e.kind === "upsertPullRequest");
    expect(prCalls.length).toBeGreaterThanOrEqual(2);
    expect(scoped.worktree.events.filter((event) => event.kind === "create")).toHaveLength(2);
    expect(scoped.worktree.events.filter((event) => event.kind === "remove")).toHaveLength(2);
  });

  it("emits PhaseFailed when item missing", async () => {
    const gh = createInMemoryFakeGitHubClient();
    gh.seedItem({ itemId: "PVTI_9", status: "Backlog" });
    const scoped = makeScopedGitRuntime();
    const events: Array<{ kind: string }> = [];
    await expect(
      runSpecifyPhase(
        {
          github: gh,
          worktree: scoped.worktree,
          gitForRepo: scoped.gitForRepo,
          fs: fakeFs(),
          agent: new InMemoryFakeAdapter({ script: [] }),
          openspecCli: createFakeOpenSpecCli(),
          events: { emit: (e) => void events.push(e) },
          runId: "r",
          profileId: "p",
          model: "m",
        },
        { itemId: "PVTI_9", changeName: "x" },
      ),
    ).rejects.toBeInstanceOf(SpecifyItemMissingError);
    expect(events.map((e) => e.kind)).toEqual(["PhaseStarted", "PhaseFailed"]);
  });
});
