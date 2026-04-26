import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../config/loader.js";
import { NightShiftConfigSchema } from "../config/schema.js";
import { CodexAdapter, ClaudeAgentAdapter } from "../adapters/index.js";
import type { AgentAdapter } from "../adapters/events.js";
import { createGitHubClient } from "../github/factory.js";
import { createAutomationWriteContext, withAutomationWriteContext } from "../github/provenance.js";
import { runReviewPhase, type ReviewFs } from "../phases/review/phase.js";
import { ReviewPhaseError } from "../phases/review/errors.js";
import type { ReviewInput } from "../contracts/review.js";

const USAGE = `night-shift review

Usage:
  night-shift review <projectItemId> [--iteration <n>]
                     [--config <path>]
                     [--run-id <id>] [--profile <id>]

Runs the Review phase against a PR in "In review" status. Produces a
verdict and posts review comments to the PR.

Exit codes:
  0  ready_to_merge
  1  needs_fix
  2  error
  3  escalated
  64 usage error
`;

function makeFs(repoRoot: string): ReviewFs {
  return {
    async readFile(filePath: string): Promise<string> {
      const resolved = path.isAbsolute(filePath) ? filePath : path.join(repoRoot, filePath);
      return readFile(resolved, "utf8");
    },
  };
}

export async function main(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  let args;
  try {
    args = parseArgs({
      args: argv,
      options: {
        iteration: { type: "string" },
        config: { type: "string" },
        "run-id": { type: "string" },
        profile: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n\n${USAGE}`);
    return 64;
  }
  if (args.values.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const itemId = args.positionals[0];
  if (!itemId) {
    process.stderr.write(`missing <projectItemId>\n\n${USAGE}`);
    return 64;
  }

  let iteration: number | undefined;
  if (args.values.iteration !== undefined) {
    const n = Number(args.values.iteration);
    if (!Number.isInteger(n) || n < 0) {
      process.stderr.write(
        `--iteration must be a non-negative integer\n\n${USAGE}`,
      );
      return 64;
    }
    iteration = n;
  }

  const runId = args.values["run-id"] ?? `review-${Date.now()}`;
  const profileId = args.values.profile ?? "default";

  try {
    const config = await loadConfig({
      ...(args.values.config !== undefined
        ? { explicitPath: args.values.config }
        : {}),
    });
    const resolved = NightShiftConfigSchema.parse(config);
    const repoRoot = path.resolve(resolved.repoRoot ?? process.cwd());
    const githubInput = resolved.github ?? {
      appId: env.GITHUB_APP_ID,
      installationId: env.GITHUB_INSTALLATION_ID,
      privateKey: env.GITHUB_PRIVATE_KEY,
      privateKeyPath: env.GITHUB_PRIVATE_KEY_PATH,
      owner: env.GITHUB_OWNER,
      repo: env.GITHUB_REPO,
      projectNodeId: env.GITHUB_PROJECT_NODE_ID,
    };
    const github = withAutomationWriteContext(
      await createGitHubClient(githubInput),
      createAutomationWriteContext("review-cli", "review", runId, profileId),
    );

    const reviewRole = resolved.roles.reviewer;
    if (!reviewRole) {
      process.stderr.write("config.roles.reviewer must be defined\n");
      return 2;
    }
    const makeAdapter = (provider: string): AgentAdapter =>
      provider === "claude-agent"
        ? new ClaudeAgentAdapter()
        : new CodexAdapter();
    const adapter = makeAdapter(reviewRole.provider);

    // Resolve iteration if not provided
    if (iteration === undefined) {
      // Get the item to find the PR number
      const item = await github.getItem(itemId);
      if (item.issueNumber) {
        // Derive from existing Night-Shift reviews
        // This is a best-effort heuristic for CLI usage
        iteration = 0;
      } else {
        iteration = 0;
      }
    }

    // We need the PR and ticket info - for CLI, derive from the item
    const item = await github.getItem(itemId);
    if (!item.issueNumber) {
      process.stderr.write("project item has no linked issue\n");
      return 2;
    }
    const issue = await github.getIssue(item.issueNumber);

    // Build minimal ReviewInput - the CLI needs to gather the context
    const reviewInput: ReviewInput = {
      ticket: {
        id: `${github.owner}/${github.repo}#${issue.number}`,
        title: issue.title,
        description: issue.body ?? "",
        status: "In review",
        labels: issue.labels,
        url: issue.htmlUrl,
        source: "github",
        sourceRef: {
          kind: "github",
          projectNodeId: github.projectNodeId,
          projectItemId: itemId,
          repoOwner: github.owner,
          repoName: github.repo,
          issueNumber: issue.number,
        },
      },
      specBundle: {
        specPath: `openspec/changes/${itemId}`,
        branch: `ns/${github.owner}-${github.repo}-${issue.number}`,
        openQuestions: [],
        assumptions: [],
        risks: [],
        commitSha: "0000000",
      },
      pr: {
        number: issue.number, // simplified: in real usage this comes from the orchestrator
        url: `https://github.com/${github.owner}/${github.repo}/pull/${issue.number}`,
        branch: `ns/${github.owner}-${github.repo}-${issue.number}`,
        baseBranch: "main",
        headSha: "0000000",
      },
      iteration,
    };

    const result = await runReviewPhase(
      { itemId, input: reviewInput },
      {
        github,
        agent: adapter,
        fs: makeFs(repoRoot),
        clock: { now: () => new Date() },
        config: resolved,
        runId,
        profileId,
        reviewerModel: reviewRole.model,
        workingDirectory: repoRoot,
      },
    );

    switch (result.status) {
      case "ready_to_merge":
        process.stdout.write(
          `Review verdict: ready_to_merge\nPR: ${reviewInput.pr.url}\n`,
        );
        return 0;
      case "needs_fix":
        process.stdout.write(
          `Review verdict: needs_fix\nPR: ${reviewInput.pr.url}\n`,
        );
        return 1;
      case "escalated":
        process.stdout.write(
          `Review verdict: escalated\nPR: ${reviewInput.pr.url}\n`,
        );
        return 3;
    }
  } catch (err) {
    const isPhase = err instanceof ReviewPhaseError;
    process.stderr.write(
      `${isPhase ? `ReviewPhaseError (${(err as ReviewPhaseError).code}): ` : "Error: "}` +
        `${(err as Error).message}\n`,
    );
    return 2;
  }
}

const entry = process.argv[1] ?? "";
const isMain = /review\.(ts|js)$/.test(entry);
if (isMain) {
  void main(process.argv.slice(2)).then((code) => {
    process.exit(code);
  });
}
