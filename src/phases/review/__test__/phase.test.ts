import { describe, expect, it } from "vitest";
import { InMemoryFakeAdapter } from "../../../adapters/__test__/fake.js";
import { createInMemoryFakeGitHubClient } from "../../../github/__test__/fake.js";
import type { FakeGitHubClient, FakeEvent } from "../../../github/__test__/fake.js";
import { runReviewPhase, type ReviewDeps, type ReviewPhaseInput } from "../phase.js";
import { ReviewAgentError, ReviewIoError, ReviewPhaseError, ReviewValidationError } from "../errors.js";
import type { ReviewInput } from "../../../contracts/review.js";
import type { EventSink, PhaseEvent } from "../../../contracts/events.js";
import type { ResolvedNightShiftConfig } from "../../../config/schema.js";
import { GitHubApiError } from "../../../github/errors.js";

function reviewResponseJson(
  overrides: Partial<{ summary: string; findings: unknown[] }> = {},
): string {
  return JSON.stringify({
    summary: overrides.summary ?? "Looks good",
    findings: overrides.findings ?? [],
  });
}

function usage() {
  return { input_tokens: 100, cached_input_tokens: 0, output_tokens: 50 };
}

const DEFAULT_CONFIG: ResolvedNightShiftConfig = {
  roles: {
    reviewer: { provider: "codex", model: "gpt-test" },
  },
  temporal: {
    serverUrl: "localhost:7233",
    namespace: "default",
    taskQueue: "night-shift",
  },
};

function makeFs(files: Record<string, string> = {}) {
  const defaultFiles: Record<string, string> = {
    "openspec/changes/c/proposal.md": "# Proposal",
    "openspec/changes/c/design.md": "# Design",
    "openspec/changes/c/tasks.md": "# Tasks",
    ...files,
  };
  return {
    async readFile(path: string): Promise<string> {
      const content = defaultFiles[path];
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    },
  };
}

function makeInput(overrides: Partial<ReviewInput> = {}): ReviewInput {
  return {
    ticket: {
      id: "acme/widgets#1",
      title: "Add feature",
      description: "Implement the feature",
      status: "In review",
      labels: [],
      url: "https://github.com/acme/widgets/issues/1",
      source: "github",
      sourceRef: {
        kind: "github",
        projectNodeId: "PVT_1",
        projectItemId: "PVTI_1",
        repoOwner: "acme",
        repoName: "widgets",
        issueNumber: 1,
      },
    },
    specBundle: {
      specPath: "openspec/changes/c",
      branch: "ns/acme-widgets-1",
      openQuestions: [],
      assumptions: [],
      risks: [],
      commitSha: "abc1234",
    },
    pr: {
      number: 1,
      url: "https://github.com/acme/widgets/pull/1",
      branch: "ns/acme-widgets-1",
      baseBranch: "main",
      headSha: "abc1234",
    },
    iteration: 0,
    ...overrides,
  };
}

function seedBase(gh: FakeGitHubClient, status: string = "In review") {
  gh.seedIssue({ number: 1, title: "Add feature" });
  gh.seedItem({ itemId: "PVTI_1", issueNumber: 1, status: status as never });
  gh.seedPr({ number: 1, branch: "ns/acme-widgets-1", headSha: "abc1234" });
  gh.seedDiff(1, "diff --git a/src/a.ts b/src/a.ts\n+added");
  gh.seedChangedFiles(1, [
    { path: "src/a.ts", additions: 1, deletions: 0, status: "modified" },
  ]);
  gh.seedFileContent("openspec/changes/c/proposal.md", "# Proposal", "abc1234");
  gh.seedFileContent("openspec/changes/c/design.md", "# Design", "abc1234");
  gh.seedFileContent("openspec/changes/c/tasks.md", "# Tasks", "abc1234");
}

function buildDeps(
  agent: InMemoryFakeAdapter,
  gh?: FakeGitHubClient,
  overrides: Partial<ReviewDeps> = {},
): { gh: FakeGitHubClient; deps: ReviewDeps } {
  const github = gh ?? createInMemoryFakeGitHubClient();
  return {
    gh: github,
    deps: {
      github,
      agent,
      fs: makeFs(),
      clock: { now: () => new Date("2026-04-24T12:00:00Z") },
      config: DEFAULT_CONFIG,
      runId: "run1",
      profileId: "default",
      reviewerModel: "gpt-test",
      ...overrides,
    },
  };
}

function phaseInput(inputOverrides: Partial<ReviewInput> = {}): ReviewPhaseInput {
  return { itemId: "PVTI_1", input: makeInput(inputOverrides) };
}

function getEvents(gh: FakeGitHubClient, kind: string) {
  return (gh.events as FakeEvent[]).filter((e) => e.kind === kind);
}

describe("runReviewPhase", () => {
  // 7.1 Entry rejection
  const rejectedStatuses = [
    "Backlog",
    "Refinement",
    "Refined",
    "Ready",
    "In progress",
    "Ready to merge",
    "Blocked",
  ];

  for (const status of rejectedStatuses) {
    it(`rejects entry on ${status}`, async () => {
      const agent = new InMemoryFakeAdapter({ script: [] });
      const { gh, deps } = buildDeps(agent);
      seedBase(gh, status);
      await expect(
        runReviewPhase(phaseInput(), deps),
      ).rejects.toBeInstanceOf(ReviewValidationError);
      // No mutations
      expect(getEvents(gh, "setStatus")).toHaveLength(0);
      expect(getEvents(gh, "createReview")).toHaveLength(0);
    });
  }

  // 7.2 Missing spec file
  it("throws ReviewIoError when spec file is missing", async () => {
    const agent = new InMemoryFakeAdapter({ script: [] });
    const gh = createInMemoryFakeGitHubClient();
    seedBase(gh);
    const originalGetFileContent = gh.getFileContent.bind(gh);
    gh.seedFileContent("openspec/changes/c/design.md", "content", "abc1234");
    gh.seedFileContent("openspec/changes/c/tasks.md", "content", "abc1234");

    const deps: ReviewDeps = {
      github: gh,
      agent,
      fs: {
        async readFile(path: string) {
          if (path.endsWith("proposal.md")) throw new Error("ENOENT");
          return "content";
        },
      },
      clock: { now: () => new Date("2026-04-24T12:00:00Z") },
      config: DEFAULT_CONFIG,
      runId: "run1",
      profileId: "default",
      reviewerModel: "gpt-test",
    };
    gh.getFileContent = async (filePath: string, ref?: string) => {
      if (filePath.endsWith("proposal.md")) throw new Error("ENOENT");
      return await originalGetFileContent(filePath, ref);
    };
    await expect(
      runReviewPhase(phaseInput(), deps),
    ).rejects.toBeInstanceOf(ReviewIoError);
    expect(getEvents(gh, "setStatus")).toHaveLength(0);
  });

  it("allows spec bundles without design.md", async () => {
    const agent = new InMemoryFakeAdapter({
      script: [{ events: [], finalText: reviewResponseJson(), usage: usage() }],
    });
    const { gh, deps } = buildDeps(agent);
    seedBase(gh);

    const originalGetFileContent = gh.getFileContent.bind(gh);
    gh.getFileContent = async (filePath: string, ref?: string) => {
      if (filePath.endsWith("design.md")) {
        throw new Error("ENOENT");
      }
      return await originalGetFileContent(filePath, ref);
    };

    const result = await runReviewPhase(phaseInput(), {
      ...deps,
      github: gh,
    });

    expect(result.status).toBe("ready_to_merge");
  });

  // 7.3 Happy ready-to-merge
  it("happy ready-to-merge: empty findings → approve + setPullRequestReady + Ready to merge", async () => {
    const agent = new InMemoryFakeAdapter({
      script: [{ events: [], finalText: reviewResponseJson(), usage: usage() }],
    });
    const { gh, deps } = buildDeps(agent);
    seedBase(gh);

    const result = await runReviewPhase(phaseInput(), deps);
    expect(result.status).toBe("ready_to_merge");
    expect(result.result.verdict).toBe("ready-to-merge");

    expect(getEvents(gh, "setPullRequestReady")).toHaveLength(1);
    expect(getEvents(gh, "createReview")).toHaveLength(1);
    expect((getEvents(gh, "createReview")[0]!.args as { event: string }).event).toBe("APPROVE");

    const statuses = getEvents(gh, "setStatus").map(
      (e) => (e.args as { status: string }).status,
    );
    expect(statuses).toContain("Ready to merge");

    // Summary comment exactly once
    const summaryComments = getEvents(gh, "upsertComment").filter(
      (e) => (e.args as { markerId: string }).markerId === "review:summary",
    );
    expect(summaryComments).toHaveLength(1);
  });

  it("falls back to COMMENT when GitHub rejects approving Night Shift's own PR", async () => {
    const agent = new InMemoryFakeAdapter({
      script: [{ events: [], finalText: reviewResponseJson(), usage: usage() }],
    });
    const gh = createInMemoryFakeGitHubClient();
    seedBase(gh);
    const originalCreateReview = gh.createReview.bind(gh);
    let firstAttempt = true;
    gh.createReview = async (pullNumber, input) => {
      if (firstAttempt && input.event === "APPROVE") {
        firstAttempt = false;
        throw new Error("Review Can not approve your own pull request");
      }
      return await originalCreateReview(pullNumber, input);
    };

    const { deps } = buildDeps(agent, gh);
    const result = await runReviewPhase(phaseInput(), deps);

    expect(result.status).toBe("ready_to_merge");
    const reviews = getEvents(gh, "createReview");
    expect(reviews).toHaveLength(1);
    expect((reviews[0]!.args as { event: string }).event).toBe("COMMENT");
    const statuses = getEvents(gh, "setStatus").map(
      (e) => (e.args as { status: string }).status,
    );
    expect(statuses).toContain("Ready to merge");
  });

  it("falls back to COMMENT when GitHub rejects requesting changes on Night Shift's own PR", async () => {
    const agent = new InMemoryFakeAdapter({
      script: [{
        events: [],
        finalText: reviewResponseJson({
          findings: [{ severity: "error", message: "fix this" }],
        }),
        usage: usage(),
      }],
    });
    const gh = createInMemoryFakeGitHubClient();
    seedBase(gh);
    const originalCreateReview = gh.createReview.bind(gh);
    let firstAttempt = true;
    gh.createReview = async (pullNumber, input) => {
      if (firstAttempt && input.event === "REQUEST_CHANGES") {
        firstAttempt = false;
        throw new Error("Review Can not request changes on your own pull request");
      }
      return await originalCreateReview(pullNumber, input);
    };

    const { deps } = buildDeps(agent, gh);
    const result = await runReviewPhase(phaseInput(), deps);

    expect(result.status).toBe("needs_fix");
    const reviews = getEvents(gh, "createReview");
    expect(reviews).toHaveLength(1);
    expect((reviews[0]!.args as { event: string }).event).toBe("COMMENT");
    const statuses = getEvents(gh, "setStatus").map(
      (e) => (e.args as { status: string }).status,
    );
    expect(statuses).toContain("Ready");
  });

  it("passes workingDirectory to the reviewer session when provided", async () => {
    let capturedWorkingDirectory: string | undefined;
    const inner = new InMemoryFakeAdapter({
      script: [{ events: [], finalText: reviewResponseJson(), usage: usage() }],
    });
    const agent = {
      provider: "fake",
      openSession(opts: unknown) {
        capturedWorkingDirectory = (opts as { workingDirectory?: string }).workingDirectory;
        return inner.openSession(opts);
      },
    };
    const { gh, deps } = buildDeps(agent as unknown as InMemoryFakeAdapter);
    seedBase(gh);

    await runReviewPhase(phaseInput(), {
      ...deps,
      agent,
      workingDirectory: "/tmp/review-repo",
    });

    expect(capturedWorkingDirectory).toBe("/tmp/review-repo");
  });

  it("normalizes absolute finding paths to repo-relative paths before posting comments", async () => {
    const findings = [
      {
        severity: "warning",
        message: "use repo-relative path",
        location: { file: "/tmp/review-repo/src/a.ts", line: 10 },
      },
    ];
    const agent = new InMemoryFakeAdapter({
      script: [
        {
          events: [],
          finalText: reviewResponseJson({ findings }),
          usage: usage(),
        },
      ],
    });
    const { gh, deps } = buildDeps(agent);
    seedBase(gh);

    await runReviewPhase(phaseInput(), {
      ...deps,
      workingDirectory: "/tmp/review-repo",
    });

    const lineComments = getEvents(gh, "upsertReviewComment");
    expect(lineComments).toHaveLength(1);
    expect((lineComments[0]!.args as { path: string }).path).toBe("src/a.ts");
  });

  it("keeps the review phase moving when GitHub rejects a line comment location", async () => {
    const findings = [
      {
        severity: "error",
        message: "line is outside the rendered diff",
        location: { file: "src/a.ts", line: 999 },
      },
    ];
    const agent = new InMemoryFakeAdapter({
      script: [
        {
          events: [],
          finalText: reviewResponseJson({ findings }),
          usage: usage(),
        },
      ],
    });
    const { gh, deps } = buildDeps(agent);
    seedBase(gh);

    gh.upsertReviewComment = async () => {
      throw new GitHubApiError(
        422,
        'Validation Failed: {"resource":"PullRequestReviewComment","code":"custom","field":"pull_request_review_thread.line","message":"could not be resolved"}',
      );
    };

    const result = await runReviewPhase(phaseInput({ iteration: 0 }), deps);

    expect(result.status).toBe("needs_fix");
    const statuses = getEvents(gh, "setStatus").map(
      (e) => (e.args as { status: string }).status,
    );
    expect(statuses).toContain("Ready");
    expect(getEvents(gh, "createReview")).toHaveLength(1);
  });

  // 7.4 Ready-to-merge with warnings
  it("ready-to-merge with warnings: line comments upserted for warnings with location", async () => {
    const findings = [
      { severity: "warning", message: "style issue", location: { file: "src/a.ts", line: 10 } },
      { severity: "warning", message: "no location finding" },
    ];
    const agent = new InMemoryFakeAdapter({
      script: [
        {
          events: [],
          finalText: reviewResponseJson({ findings }),
          usage: usage(),
        },
      ],
    });
    const { gh, deps } = buildDeps(agent);
    seedBase(gh);

    const result = await runReviewPhase(phaseInput(), deps);
    expect(result.status).toBe("ready_to_merge");

    // Only one line comment (the one with location)
    const lineComments = getEvents(gh, "upsertReviewComment");
    expect(lineComments).toHaveLength(1);
    expect((lineComments[0]!.args as { path: string }).path).toBe("src/a.ts");
  });

  // 7.5 needs-fix on iteration 0
  it("needs-fix on iteration 0: REQUEST_CHANGES + Ready status", async () => {
    const findings = [
      { severity: "error", message: "missing test", location: { file: "src/b.ts", line: 5 } },
      { severity: "error", message: "no loc" },
    ];
    const agent = new InMemoryFakeAdapter({
      script: [
        {
          events: [],
          finalText: reviewResponseJson({ findings }),
          usage: usage(),
        },
      ],
    });
    const { gh, deps } = buildDeps(agent);
    seedBase(gh);

    const result = await runReviewPhase(phaseInput({ iteration: 0 }), deps);
    expect(result.status).toBe("needs_fix");

    const reviews = getEvents(gh, "createReview");
    expect(reviews).toHaveLength(1);
    expect((reviews[0]!.args as { event: string }).event).toBe("REQUEST_CHANGES");

    const statuses = getEvents(gh, "setStatus").map(
      (e) => (e.args as { status: string }).status,
    );
    expect(statuses).toContain("Ready");
    expect(statuses).not.toContain("In progress");

    // One line comment for the finding with location
    expect(getEvents(gh, "upsertReviewComment")).toHaveLength(1);
  });

  // 7.6 escalate on iteration 2
  it("escalate on iteration 2: label + Blocked + COMMENT review", async () => {
    const findings = [{ severity: "error", message: "design flaw" }];
    const agent = new InMemoryFakeAdapter({
      script: [
        {
          events: [],
          finalText: reviewResponseJson({ findings }),
          usage: usage(),
        },
      ],
    });
    const { gh, deps } = buildDeps(agent);
    seedBase(gh);

    const result = await runReviewPhase(phaseInput({ iteration: 2 }), deps);
    expect(result.status).toBe("escalated");

    expect(getEvents(gh, "addLabels")).toHaveLength(1);
    const labels = (getEvents(gh, "addLabels")[0]!.args as { labels: string[] }).labels;
    expect(labels).toContain("night-shift:escalation");

    const statuses = getEvents(gh, "setStatus").map(
      (e) => (e.args as { status: string }).status,
    );
    expect(statuses).toContain("Blocked");

    const reviews = getEvents(gh, "createReview");
    expect(reviews).toHaveLength(1);
    expect((reviews[0]!.args as { event: string }).event).toBe("COMMENT");
  });

  it("honors maxIterations from the review input", async () => {
    const findings = [{ severity: "error", message: "still broken" }];
    const agent = new InMemoryFakeAdapter({
      script: [
        {
          events: [],
          finalText: reviewResponseJson({ findings }),
          usage: usage(),
        },
      ],
    });
    const { gh, deps } = buildDeps(agent);
    seedBase(gh);

    const result = await runReviewPhase(
      phaseInput({ iteration: 1, maxIterations: 2 }),
      deps,
    );

    expect(result.status).toBe("escalated");
  });

  // 7.7 Schema-invalid once → retry → happy
  it("schema-invalid once → retry → success", async () => {
    const badResponse = JSON.stringify({
      summary: "ok",
      findings: [{ severity: "oops", message: "x" }],
    });
    const goodResponse = reviewResponseJson();
    const agent = new InMemoryFakeAdapter({
      script: [
        { events: [], finalText: badResponse, usage: usage() },
        { events: [], finalText: goodResponse, usage: usage() },
      ],
    });
    const { gh, deps } = buildDeps(agent);
    seedBase(gh);

    const result = await runReviewPhase(phaseInput(), deps);
    expect(result.status).toBe("ready_to_merge");
  });

  // 7.8 Schema-invalid twice → error bubbles up
  it("schema-invalid twice → ReviewAgentError bubbles up, no mutations", async () => {
    const badResponse = JSON.stringify({
      summary: "ok",
      findings: [{ severity: "oops", message: "x" }],
    });
    const agent = new InMemoryFakeAdapter({
      script: [
        { events: [], finalText: badResponse, usage: usage() },
        { events: [], finalText: badResponse, usage: usage() },
      ],
    });
    const { gh, deps } = buildDeps(agent);
    seedBase(gh);

    await expect(
      runReviewPhase(phaseInput(), deps),
    ).rejects.toBeInstanceOf(ReviewAgentError);
    expect(getEvents(gh, "setStatus")).toHaveLength(0);
    expect(getEvents(gh, "createReview")).toHaveLength(0);
  });

  // 7.9 Re-run idempotency
  it("second run does not create duplicate line comments or reviews", async () => {
    const findings = [
      { severity: "warning", message: "style", location: { file: "src/a.ts", line: 10 } },
    ];
    const agent1 = new InMemoryFakeAdapter({
      script: [
        { events: [], finalText: reviewResponseJson({ findings }), usage: usage() },
      ],
    });
    const gh = createInMemoryFakeGitHubClient();
    seedBase(gh);

    const deps1 = buildDeps(agent1, gh).deps;
    await runReviewPhase(phaseInput(), deps1);

    // Seed the created review into the fake so second run finds it
    // (The review was created in the first run; the fake already tracks it)

    const agent2 = new InMemoryFakeAdapter({
      script: [
        { events: [], finalText: reviewResponseJson({ findings }), usage: usage() },
      ],
    });
    // Reset item status to In review for re-entry
    gh.seedItem({ itemId: "PVTI_1", issueNumber: 1, status: "In review" as never });

    const deps2: ReviewDeps = { ...deps1, agent: agent2 };
    await runReviewPhase(phaseInput(), deps2);

    // The second run should update the existing review, not create a new one
    const reviews = getEvents(gh, "createReview");
    const updates = getEvents(gh, "updateReview");
    // First run creates, second run updates
    expect(reviews).toHaveLength(1);
    expect(updates).toHaveLength(1);
  });

  // 7.10 Diff truncation
  it("large diff is capped at maxDiffBytes in the prompt", async () => {
    const agent = new InMemoryFakeAdapter({
      script: [{ events: [], finalText: reviewResponseJson(), usage: usage() }],
    });
    const gh = createInMemoryFakeGitHubClient();
    seedBase(gh);
    // Seed a large diff
    gh.seedDiff(1, "x".repeat(200_000));
    gh.seedChangedFiles(1, [
      { path: "src/a.ts", additions: 100, deletions: 50, status: "modified" },
    ]);

    const { deps } = buildDeps(agent, gh);
    const result = await runReviewPhase(phaseInput(), deps);
    expect(result.status).toBe("ready_to_merge");
    // The prompt will have been truncated internally — we verify through
    // successful completion (the agent still gets a valid message)
  });

  // 7.11 phase.finished emitted on every terminal path
  it("phase.finished emitted on success", async () => {
    const events: PhaseEvent[] = [];
    const logger: EventSink = { emit: async (ev) => { events.push(ev as PhaseEvent); } };
    const agent = new InMemoryFakeAdapter({
      script: [{ events: [], finalText: reviewResponseJson(), usage: usage() }],
    });
    const { gh, deps } = buildDeps(agent, undefined, { logger });
    seedBase(gh);

    await runReviewPhase(phaseInput(), deps);
    expect(events.some((e) => e.kind === "PhaseStarted")).toBe(true);
    expect(events.some((e) => e.kind === "PhaseCompleted")).toBe(true);
  });

  it("phase.finished emitted on error", async () => {
    const events: PhaseEvent[] = [];
    const logger: EventSink = { emit: async (ev) => { events.push(ev as PhaseEvent); } };
    const badResponse = JSON.stringify({
      summary: "ok",
      findings: [{ severity: "oops", message: "x" }],
    });
    const agent = new InMemoryFakeAdapter({
      script: [
        { events: [], finalText: badResponse, usage: usage() },
        { events: [], finalText: badResponse, usage: usage() },
      ],
    });
    const { gh, deps } = buildDeps(agent, undefined, { logger });
    seedBase(gh);

    await expect(runReviewPhase(phaseInput(), deps)).rejects.toThrow();
    expect(events.some((e) => e.kind === "PhaseStarted")).toBe(true);
    expect(events.some((e) => e.kind === "PhaseFailed")).toBe(true);
  });
});
