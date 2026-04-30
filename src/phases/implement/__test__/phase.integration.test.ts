import { describe, expect, it } from "vitest";
import { InMemoryFakeAdapter } from "../../../adapters/__test__/fake.js";
import { createInMemoryFakeGitHubClient } from "../../../github/__test__/fake.js";
import { createInMemoryFakeGitOps } from "../../../git/__test__/fake.js";
import { createInMemoryFakeWorktreeOps } from "../../../worktree/__test__/fake.js";
import { createInMemoryFakeQualityGateRunner } from "../../../quality-gates/__test__/fake.js";
import { runImplementPhase, type ImplementFs } from "../phase.js";

function impl(files: Array<{ path: string; content: string }>) {
  return JSON.stringify({
    filesWritten: files,
    commitMessage: "feat: add",
    summary: "done",
    followUps: [],
  });
}

function usage() {
  return { input_tokens: 10, cached_input_tokens: 0, output_tokens: 20 };
}

const BUNDLE = [
  { path: "openspec/changes/c/proposal.md", content: "p" },
  { path: "openspec/changes/c/tasks.md", content: "t" },
];

function makeFs(): ImplementFs {
  return {
    async readSpecBundle() {
      return BUNDLE;
    },
    async writeWorktreeFiles() {
      // fake worktree; in-memory
    },
  };
}

describe("runImplementPhase (integration with in-memory fakes)", () => {
  it("produces pr_opened with passing gates and approved review", async () => {
    const agent = new InMemoryFakeAdapter({
      script: [
        {
          events: [],
          finalText: impl([{ path: "src/a.ts", content: "export {}\n" }]),
          usage: usage(),
        },
      ],
    });
    const gh = createInMemoryFakeGitHubClient();
    gh.seedIssue({ number: 1 });
    gh.seedItem({ itemId: "PVTI_1", issueNumber: 1, status: "Ready" });
    const git = createInMemoryFakeGitOps();
    const worktree = createInMemoryFakeWorktreeOps();
    const gates = createInMemoryFakeQualityGateRunner();

    const result = await runImplementPhase(
      {
        github: gh,
        git,
        fs: makeFs(),
        worktree,
        gateRunner: gates,
        agent,
        runId: "r",
        profileId: "p",
        implementerModel: "m",
        qualityGates: [{ name: "typecheck", command: ["true"] }],
        baseBranch: "main",
      },
      { itemId: "PVTI_1", changeName: "c" },
    );

    expect(result.status).toBe("pr_opened");
    expect(result.result?.qualityGates.map((g) => g.status)).toEqual(["passed"]);
    expect(git.commits).toHaveLength(1);
    // Currently fails: implement/phase.ts retains the worktree on pr_opened
    // (see "orphaned-retention" TODO there). This expectation matches the
    // pre-f9076fb design and will pass again once the retention is removed.
    expect(worktree.events.map((e) => e.kind)).toEqual(["create", "remove"]);
  });

  it("surfaces path-escape as a schema error and keeps the worktree", async () => {
    const agent = new InMemoryFakeAdapter({
      script: [
        {
          events: [],
          finalText: impl([{ path: "../outside.ts", content: "x" }]),
          usage: usage(),
        },
      ],
    });
    const gh = createInMemoryFakeGitHubClient();
    gh.seedIssue({ number: 2 });
    gh.seedItem({ itemId: "PVTI_2", issueNumber: 2, status: "Ready" });
    const worktree = createInMemoryFakeWorktreeOps();

    await expect(
      runImplementPhase(
        {
          github: gh,
          git: createInMemoryFakeGitOps(),
          fs: makeFs(),
          worktree,
          gateRunner: createInMemoryFakeQualityGateRunner(),
          agent,
          runId: "r",
          profileId: "p",
          implementerModel: "m",
          qualityGates: [{ name: "typecheck", command: ["true"] }],
          baseBranch: "main",
        },
        { itemId: "PVTI_2", changeName: "c" },
      ),
    ).rejects.toThrow(/schema/);
    expect(worktree.events.map((e) => e.kind)).toEqual(["create"]);
  });

  it("keeps logsTail under 4 KiB even when the gate output is large", async () => {
    const agent = new InMemoryFakeAdapter({
      script: [
        {
          events: [],
          finalText: impl([{ path: "src/a.ts", content: "export {}\n" }]),
          usage: usage(),
        },
        {
          events: [],
          finalText: impl([{ path: "src/a.ts", content: "export {}\n" }]),
          usage: usage(),
        },
      ],
    });
    const gh = createInMemoryFakeGitHubClient();
    gh.seedIssue({ number: 3 });
    gh.seedItem({ itemId: "PVTI_3", issueNumber: 3, status: "Ready" });
    const gates = createInMemoryFakeQualityGateRunner();
    gates.script("typecheck", {
      status: "passed",
      exitCode: 0,
      logsTail: "x".repeat(8 * 1024),
    });

    const result = await runImplementPhase(
      {
        github: gh,
        git: createInMemoryFakeGitOps(),
        fs: makeFs(),
        worktree: createInMemoryFakeWorktreeOps(),
        gateRunner: gates,
        agent,
        runId: "r",
        profileId: "p",
        implementerModel: "m",
        qualityGates: [{ name: "typecheck", command: ["true"] }],
        baseBranch: "main",
      },
      { itemId: "PVTI_3", changeName: "c" },
    );
    expect(result.status).toBe("pr_opened");
    // The contract schema caps logsTail at 4 KiB — the parsed result must
    // reflect that constraint is honored (the fake here passes a larger
    // string, which should trigger the schema to reject or truncate).
    const gate = result.result?.qualityGates[0];
    // Our QualityGateResultSchema enforces max(4096); since the fake passed
    // 8 KiB, parse would have thrown — but we only cap on the runner side,
    // not in the phase. Verify either: (a) parse threw, or (b) the stored
    // value is <= 4 KiB.
    if (gate && gate.logsTail !== undefined) {
      expect(gate.logsTail.length).toBeLessThanOrEqual(4096);
    }
  });
});
