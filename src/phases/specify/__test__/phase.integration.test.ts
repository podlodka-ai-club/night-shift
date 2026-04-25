import { cp, mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { InMemoryFakeAdapter } from "../../../adapters/__test__/fake.js";
import { createInMemoryFakeGitHubClient } from "../../../github/__test__/fake.js";
import { createInMemoryFakeGitOps } from "../../../git/__test__/fake.js";
import { worktreePathSegmentsForTicket } from "../../../worktree/index.js";
import { createOpenSpecCli } from "../openspec-cli.js";
import { runSpecifyPhase, type SpecifyFs } from "../phase.js";

/** Check whether the `openspec` CLI is reachable via `npx openspec --help`. */
async function hasOpenspecCli(): Promise<boolean> {
  const { spawn } = await import("node:child_process");
  return await new Promise<boolean>((resolve) => {
    const child = spawn("npx", ["openspec", "--help"], { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
    setTimeout(() => resolve(false), 10_000);
  });
}

const available = await hasOpenspecCli();

describe.skipIf(!available)("runSpecifyPhase (integration with real openspec CLI)", () => {
  async function setupRepo(): Promise<{ repoRoot: string; cleanup: () => Promise<void> }> {
    const repoRoot = await mkdtemp(path.join(tmpdir(), "night-shift-specify-"));
    // Minimal openspec scaffolding.
    await mkdir(path.join(repoRoot, "openspec", "specs"), { recursive: true });
    await mkdir(path.join(repoRoot, "openspec", "changes"), { recursive: true });
    // openspec project.md — some versions of the CLI require it.
    await writeFile(
      path.join(repoRoot, "openspec", "project.md"),
      "# Project\n\nIntegration test scaffold.\n",
    );
    return {
      repoRoot,
      cleanup: () => rm(repoRoot, { recursive: true, force: true }),
    };
  }

  function makeFs(repoRoot: string): SpecifyFs {
    return {
      async readPriorDraft(scopedRepoRoot, changeDir) {
        try {
          const base = path.join(scopedRepoRoot, changeDir);
          const out: Array<{ path: string; content: string }> = [];
          const { readdirSync, statSync } = await import("node:fs");
          const walk = (dir: string, rel: string) => {
            for (const entry of readdirSync(dir)) {
              const full = path.join(dir, entry);
              const r = path.posix.join(rel, entry);
              if (statSync(full).isDirectory()) walk(full, r);
              else out.push({ path: r, content: "" });
            }
          };
          walk(base, "");
          // Fill content lazily.
          for (const f of out) {
            f.content = await readFile(path.join(base, f.path), "utf8");
          }
          return out;
        } catch {
          return [];
        }
      },
    };
  }

  function makeWorktree(repoRoot: string) {
    return {
      async create({ ticketId, branch }: { ticketId: string; branch: string }) {
        const worktreePath = path.join(
          repoRoot,
          ".worktrees",
          ...worktreePathSegmentsForTicket(ticketId),
        );
        await rm(worktreePath, { recursive: true, force: true });
        await mkdir(path.dirname(worktreePath), { recursive: true });
        await cp(path.join(repoRoot, "openspec"), path.join(worktreePath, "openspec"), {
          recursive: true,
        });
        return { path: worktreePath, branch };
      },
      async remove(worktreePath: string) {
        await rm(worktreePath, { recursive: true, force: true });
      },
    };
  }

  function makeScopedGitFactory(git: ReturnType<typeof createInMemoryFakeGitOps>) {
    return (scopedRepoRoot: string) => ({
      async checkoutBranch(branch: string, opts?: { startPoint?: string; preferRemote?: boolean }) {
        await git.checkoutBranch(branch, opts);
      },
      async pushBranch(branch: string) {
        await git.pushBranch(branch);
      },
      async remoteHeadSha(branch: string) {
        return await git.remoteHeadSha(branch);
      },
      async writeTree(files: Array<{ path: string; content: string }>, msg: string) {
        for (const f of files) {
          const full = path.join(scopedRepoRoot, f.path);
          await mkdir(path.dirname(full), { recursive: true });
          await writeFile(full, f.content, "utf8");
        }
        return await git.writeTree(files, msg);
      },
      async currentHeadSha() {
        return await git.currentHeadSha();
      },
      async diffAgainstBase(baseBranch: string) {
        return await git.diffAgainstBase(baseBranch);
      },
    });
  }

  function goodResponse(changeName: string): string {
    return JSON.stringify({
      files: [
        {
          path: "proposal.md",
          content: `## Why\nIntegration scaffold.\n\n## What Changes\n- Add ${changeName}\n\n## Impact\n- Affected specs: demo\n- Affected code: n/a\n`,
        },
        { path: "tasks.md", content: "## 1. Work\n- [ ] 1.1 Scaffold\n" },
        {
          path: "specs/demo/spec.md",
          content:
            "## ADDED Requirements\n### Requirement: The system SHALL demo\n\nThe system SHALL expose a demo capability that integration tests can exercise.\n\n#### Scenario: basic\n- **WHEN** invoked\n- **THEN** succeeds\n",
        },
      ],
      openQuestions: [],
      assumptions: [],
      risks: [],
    });
  }

  it("accepts a well-formed specifier output", async () => {
    const { repoRoot, cleanup } = await setupRepo();
    try {
      const gh = createInMemoryFakeGitHubClient();
      gh.seedIssue({ number: 1, title: "integration" });
      gh.seedItem({ itemId: "PVTI_I", issueNumber: 1, status: "Backlog" });
      const git = createInMemoryFakeGitOps();
      const agent = new InMemoryFakeAdapter({
        script: [
          {
            events: [],
            finalText: goodResponse("integ-ok"),
            usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
          },
        ],
      });
      const cli = createOpenSpecCli();
      const result = await runSpecifyPhase(
        {
          github: gh,
          worktree: makeWorktree(repoRoot),
          gitForRepo: makeScopedGitFactory(git),
          fs: makeFs(repoRoot),
          agent,
          openspecCli: cli,
          runId: "r",
          profileId: "p",
          model: "m",
        },
        { itemId: "PVTI_I", changeName: "integ-ok" },
      );
      expect(result.status).toBe("refined");
    } finally {
      await cleanup();
    }
  }, 30_000);

  it("retries once when first output is invalid and second is valid", async () => {
    const { repoRoot, cleanup } = await setupRepo();
    try {
      const gh = createInMemoryFakeGitHubClient();
      gh.seedIssue({ number: 2, title: "retry" });
      gh.seedItem({ itemId: "PVTI_R", issueNumber: 2, status: "Backlog" });
      const git = createInMemoryFakeGitOps();
      const badResponse = JSON.stringify({
        files: [
          { path: "proposal.md", content: "(missing required sections)\n" },
          { path: "tasks.md", content: "## 1. Work\n- [ ] 1.1 x\n" },
          {
            path: "specs/demo/spec.md",
            content: "## ADDED Requirements\n(empty)\n",
          },
        ],
        openQuestions: [],
        assumptions: [],
        risks: [],
      });
      const agent = new InMemoryFakeAdapter({
        script: [
          {
            events: [],
            finalText: badResponse,
            usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
          },
          {
            events: [],
            finalText: goodResponse("retry-ok"),
            usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
          },
        ],
      });
      const cli = createOpenSpecCli();
      const result = await runSpecifyPhase(
        {
          github: gh,
          worktree: makeWorktree(repoRoot),
          gitForRepo: makeScopedGitFactory(git),
          fs: makeFs(repoRoot),
          agent,
          openspecCli: cli,
          runId: "r",
          profileId: "p",
          model: "m",
        },
        { itemId: "PVTI_R", changeName: "retry-ok" },
      );
      expect(result.status).toBe("refined");
    } finally {
      await cleanup();
    }
  }, 30_000);

  it("produces needs_input when both attempts fail validation", async () => {
    const { repoRoot, cleanup } = await setupRepo();
    try {
      const gh = createInMemoryFakeGitHubClient();
      gh.seedIssue({ number: 3, title: "bad" });
      gh.seedItem({ itemId: "PVTI_B2", issueNumber: 3, status: "Backlog" });
      const git = createInMemoryFakeGitOps();
      const badResponse = JSON.stringify({
        files: [
          { path: "proposal.md", content: "(invalid)\n" },
          { path: "tasks.md", content: "## 1. Work\n- [ ] 1.1 x\n" },
          { path: "specs/demo/spec.md", content: "## ADDED Requirements\n(empty)\n" },
        ],
        openQuestions: [],
        assumptions: [],
        risks: [],
      });
      const agent = new InMemoryFakeAdapter({
        script: [
          {
            events: [],
            finalText: badResponse,
            usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
          },
          {
            events: [],
            finalText: badResponse,
            usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
          },
        ],
      });
      const cli = createOpenSpecCli();
      const result = await runSpecifyPhase(
        {
          github: gh,
          worktree: makeWorktree(repoRoot),
          gitForRepo: makeScopedGitFactory(git),
          fs: makeFs(repoRoot),
          agent,
          openspecCli: cli,
          runId: "r",
          profileId: "p",
          model: "m",
        },
        { itemId: "PVTI_B2", changeName: "bad-change" },
      );
      expect(result.status).toBe("needs_input");
    } finally {
      await cleanup();
    }
  }, 30_000);
});
