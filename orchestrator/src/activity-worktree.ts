import path from 'node:path';
import {
  DEFAULT_BRANCH_PREFIX,
  DEFAULT_FILE_PATH_PREFIX,
  type CleanupWorktreeInput,
  type CommitAndPushInput,
  type QualityGateResult,
  type CreateWorktreeForIssueIfNeededInput,
  type OpenSpecChangeFile,
  type ReadOpenSpecChangeFilesInput,
  type RunQualityGateInput,
  type SelectedProjectIssue,
  type ValidateOpenSpecChangeInput,
  type WriteRepositoryFilesInput,
  type WorktreeContext,
  type WriteOpenSpecChangeFilesInput,
} from './shared';
import type { WorktreeActivityDeps } from './activity-deps';
import { git, pathExists, toErrorMessage } from './activity-deps';

const LOCAL_REPOS_ROOT = '/tmp/orchestrator';
const LOCAL_WORKTREES_DIR = '.worktrees';
const LOCAL_WORKTREES_EXCLUDE_ENTRY = '.worktrees/';
const QUALITY_GATE_LOG_LIMIT = 4 * 1024;

interface LocalRepoPaths {
  repoRoot: string;
  worktreesRoot: string;
  worktreePath: string;
  remoteUrl: string;
}

export function buildBranchName(issueNumber: number, branchPrefix = DEFAULT_BRANCH_PREFIX): string {
  return `${branchPrefix}/issue-${issueNumber}`;
}

export function buildDummyFilePath(issueNumber: number, filePathPrefix = DEFAULT_FILE_PATH_PREFIX): string {
  return `${filePathPrefix}/issue-${issueNumber}.md`;
}

export function buildDummyChangeContent(
  issueNumber: number,
  issueTitle: string,
  generatedAt = new Date(Date.now()).toISOString(),
): string {
  return ['# Orchestrator Dummy Change', '', `- Issue: #${issueNumber}`, `- Title: ${issueTitle}`, `- Generated at: ${generatedAt}`].join('\n');
}

export function createWorktreeActivities(deps: WorktreeActivityDeps) {
  return {
    async createWorktreeForIssueIfNeeded(input: CreateWorktreeForIssueIfNeededInput): Promise<WorktreeContext> {
      const { issue, branchPrefix, filePathPrefix } = input;
      const { defaultBranch, issueNumber, repoName, repoOwner } = issue;
      const generatedAt = new Date(deps.now()).toISOString();
      const branchName = buildBranchName(issueNumber, branchPrefix);
      const filePath = buildDummyFilePath(issueNumber, filePathPrefix);
      const localRepoPaths = resolveLocalRepoPaths(repoOwner, repoName, branchName);
      const worktree = buildWorktreeContext(issue, branchName, filePath, generatedAt, localRepoPaths);

      if (await pathExists(deps, localRepoPaths.worktreePath)) {
        return worktree;
      }

      await ensureBaseClone(deps, localRepoPaths);
      await ensureWorktreesIgnored(deps, localRepoPaths);
      await refreshCloneToDefaultBranch(deps, localRepoPaths.repoRoot, defaultBranch);
      await ensureIssueWorktree(deps, localRepoPaths.repoRoot, localRepoPaths.worktreePath, branchName, defaultBranch);
      return worktree;
    },

    async commitAndPush(input: CommitAndPushInput): Promise<void> {
      const { worktree, commitMessage } = input;
      const { branchName, worktreePath } = worktree;
      await git(deps, worktreePath, ['add', '--all']);
      await commitWorktreeIfNeeded(deps, worktree, commitMessage);

      if (!(await hasCommitsToPush(deps, worktree))) {
        throw new Error(`Agent produced no changes to push for branch ${branchName}.`);
      }

      await git(deps, worktreePath, ['push', '-u', 'origin', branchName]);
    },

    async readOpenSpecChangeFiles(input: ReadOpenSpecChangeFilesInput): Promise<OpenSpecChangeFile[]> {
      const changeRoot = resolveOpenSpecChangeRoot(input.worktree, input.changeName);
      if (!(await pathExists(deps, changeRoot))) {
        return [];
      }
      return readOpenSpecFilesRecursively(deps, changeRoot, changeRoot);
    },

    async writeOpenSpecChangeFiles(input: WriteOpenSpecChangeFilesInput): Promise<void> {
      const changeRoot = resolveOpenSpecChangeRoot(input.worktree, input.changeName);
      for (const file of input.files) {
        const targetPath = path.join(changeRoot, file.path);
        await deps.mkdir(path.dirname(targetPath), { recursive: true });
        await deps.writeFile(targetPath, file.content, 'utf8');
      }
    },

    async validateOpenSpecChange(input: ValidateOpenSpecChangeInput): Promise<void> {
      await deps.execFile('openspec', ['validate', input.changeName, '--strict'], { cwd: input.worktree.worktreePath });
    },

    async writeRepositoryFiles(input: WriteRepositoryFilesInput): Promise<void> {
      for (const file of input.files) {
        const targetPath = path.join(input.worktree.worktreePath, file.path);
        await deps.mkdir(path.dirname(targetPath), { recursive: true });
        await deps.writeFile(targetPath, file.content, 'utf8');
      }
    },

    async runQualityGate(input: RunQualityGateInput): Promise<QualityGateResult> {
      const result = await deps.execFile('make', ['check'], { cwd: input.worktree.worktreePath });
      const combinedLogs = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
      return {
        passed: result.exitCode === 0,
        summary: result.exitCode === 0 ? 'make check passed' : 'make check failed',
        logs: truncateQualityGateLogs(combinedLogs),
      };
    },

    async cleanupWorktree(input: CleanupWorktreeInput): Promise<void> {
      const { worktree } = input;
      await cleanupLocalWorktree(deps, worktree.repoRoot, worktree.worktreePath, worktree.branchName);
    },
  };
}

function buildWorktreeContext(
  issue: SelectedProjectIssue,
  branchName: string,
  filePath: string,
  generatedAt: string,
  localRepoPaths: Pick<LocalRepoPaths, 'repoRoot' | 'worktreePath'>,
): WorktreeContext {
  const { defaultBranch, issueNumber, issueTitle, taskDescription, issueUrl, repoName, repoOwner } = issue;
  return {
    issueNumber,
    issueTitle,
    taskDescription,
    issueUrl,
    repoOwner,
    repoName,
    defaultBranch,
    branchName,
    filePath,
    generatedAt,
    repoRoot: localRepoPaths.repoRoot,
    worktreePath: localRepoPaths.worktreePath,
  };
}

function resolveLocalRepoPaths(repoOwner: string, repoName: string, branchName: string): LocalRepoPaths {
  const repoRoot = path.join(LOCAL_REPOS_ROOT, repoOwner, repoName);
  const worktreesRoot = path.join(repoRoot, LOCAL_WORKTREES_DIR);
  return {
    repoRoot,
    worktreesRoot,
    worktreePath: path.join(worktreesRoot, branchName),
    remoteUrl: `https://github.com/${repoOwner}/${repoName}.git`,
  };
}

async function ensureBaseClone(deps: WorktreeActivityDeps, paths: LocalRepoPaths): Promise<void> {
  if (!(await pathExists(deps, paths.repoRoot))) {
    await deps.mkdir(path.dirname(paths.repoRoot), { recursive: true });
    await git(deps, path.dirname(paths.repoRoot), ['clone', paths.remoteUrl, paths.repoRoot]);
    return;
  }

  await git(deps, paths.repoRoot, ['fetch', '--prune', 'origin']);
}

async function ensureWorktreesIgnored(deps: WorktreeActivityDeps, paths: LocalRepoPaths): Promise<void> {
  const result = await git(deps, paths.repoRoot, ['check-ignore', LOCAL_WORKTREES_DIR], [0, 1]);
  if (result.exitCode !== 0) {
    const gitInfoPath = path.join(paths.repoRoot, '.git', 'info');
    await deps.mkdir(gitInfoPath, { recursive: true });
    await deps.appendFile(path.join(gitInfoPath, 'exclude'), `${LOCAL_WORKTREES_EXCLUDE_ENTRY}\n`, 'utf8');
  }

  await deps.mkdir(paths.worktreesRoot, { recursive: true });
}

function refreshCloneToDefaultBranch(deps: WorktreeActivityDeps, repoRoot: string, defaultBranch: string): Promise<unknown> {
  return git(deps, repoRoot, ['checkout', '-B', defaultBranch, `origin/${defaultBranch}`]);
}

async function hasRemoteBranch(deps: WorktreeActivityDeps, repoRoot: string, branchName: string): Promise<boolean> {
  const result = await git(deps, repoRoot, ['ls-remote', '--exit-code', '--heads', 'origin', branchName], [0, 2]);
  return result.exitCode === 0;
}

async function hasStagedChanges(deps: WorktreeActivityDeps, worktreePath: string): Promise<boolean> {
  const result = await git(deps, worktreePath, ['diff', '--cached', '--quiet', '--exit-code'], [0, 1]);
  return result.exitCode === 1;
}

async function commitWorktreeIfNeeded(deps: WorktreeActivityDeps, worktree: WorktreeContext, commitMessage?: string): Promise<void> {
  if (!(await hasStagedChanges(deps, worktree.worktreePath))) {
    return;
  }

  await git(deps, worktree.worktreePath, ['commit', '-m', buildCommitMessage(worktree, commitMessage)]);
}

async function hasCommitsToPush(deps: WorktreeActivityDeps, worktree: WorktreeContext): Promise<boolean> {
  const baseRef = (await hasRemoteBranch(deps, worktree.repoRoot, worktree.branchName))
    ? `origin/${worktree.branchName}`
    : `origin/${worktree.defaultBranch}`;
  return hasAheadCommits(deps, worktree.worktreePath, baseRef);
}

async function hasAheadCommits(deps: WorktreeActivityDeps, worktreePath: string, baseRef: string): Promise<boolean> {
  const result = await git(deps, worktreePath, ['rev-list', '--count', `${baseRef}..HEAD`]);
  const commitCount = Number.parseInt(result.stdout.trim(), 10);
  if (Number.isNaN(commitCount)) {
    throw new Error(`Could not determine whether HEAD is ahead of ${baseRef}.`);
  }
  return commitCount > 0;
}

function buildCommitMessage(worktree: WorktreeContext, commitMessage?: string): string {
  return commitMessage?.trim() || `Add dummy change for issue #${worktree.issueNumber}`;
}

function resolveOpenSpecChangeRoot(worktree: WorktreeContext, changeName: string): string {
  return path.join(worktree.worktreePath, 'openspec', 'changes', changeName);
}

function truncateQualityGateLogs(logs: string): string {
  if (logs.length <= QUALITY_GATE_LOG_LIMIT) {
    return logs;
  }
  return `${logs.slice(0, QUALITY_GATE_LOG_LIMIT)}\n...[truncated]`;
}

async function readOpenSpecFilesRecursively(
  deps: WorktreeActivityDeps,
  rootPath: string,
  currentPath: string,
): Promise<OpenSpecChangeFile[]> {
  const entries = await deps.readdir(currentPath, { withFileTypes: true });
  const files: OpenSpecChangeFile[] = [];

  for (const entry of entries) {
    const entryPath = path.join(currentPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...await readOpenSpecFilesRecursively(deps, rootPath, entryPath));
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    files.push({
      path: path.relative(rootPath, entryPath),
      content: await deps.readFile(entryPath, 'utf8'),
    });
  }

  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function ensureIssueWorktree(
  deps: WorktreeActivityDeps,
  repoRoot: string,
  worktreePath: string,
  branchName: string,
  defaultBranch: string,
): Promise<void> {
  if (await hasRemoteBranch(deps, repoRoot, branchName)) {
    await createWorktreeFromRemoteBranch(deps, repoRoot, worktreePath, branchName);
    return;
  }

  await createBranchWorktree(deps, repoRoot, worktreePath, branchName, defaultBranch);
}

function createBranchWorktree(
  deps: WorktreeActivityDeps,
  repoRoot: string,
  worktreePath: string,
  branchName: string,
  defaultBranch: string,
): Promise<unknown> {
  return git(deps, repoRoot, ['worktree', 'add', '-b', branchName, worktreePath, `origin/${defaultBranch}`]);
}

function createWorktreeFromRemoteBranch(
  deps: WorktreeActivityDeps,
  repoRoot: string,
  worktreePath: string,
  branchName: string,
): Promise<unknown> {
  return git(deps, repoRoot, ['worktree', 'add', '-B', branchName, worktreePath, `origin/${branchName}`]);
}

async function cleanupLocalWorktree(
  deps: WorktreeActivityDeps,
  repoRoot: string,
  worktreePath: string,
  branchName: string,
): Promise<void> {
  const cleanupFailures: string[] = [];

  try {
    await git(deps, repoRoot, ['worktree', 'remove', '--force', worktreePath]);
  } catch (error) {
    cleanupFailures.push(toErrorMessage(error));
  }

  try {
    await git(deps, repoRoot, ['branch', '-D', branchName]);
  } catch (error) {
    cleanupFailures.push(toErrorMessage(error));
  }

  if (cleanupFailures.length > 0) {
    throw new Error(`Failed to clean up worktree ${worktreePath}: ${cleanupFailures.join('; ')}`);
  }
}