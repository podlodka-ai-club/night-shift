import { access, appendFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { Context } from '@temporalio/activity';
import { execa } from 'execa';

export const CODEX_COMMAND = 'codex';
export const CODEX_MODEL = 'gpt-5.3-codex';
export const CODEX_REASONING_EFFORT = 'low' as const;

export interface CommandOptions {
  cwd?: string;
  signal?: AbortSignal;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface AgentProgressEvent {
  type: string;
  payload: unknown;
}

export interface AgentTurnOptions {
  outputSchema?: unknown;
  signal?: AbortSignal;
  onEvent?: (event: AgentProgressEvent) => void;
}

export interface AgentTurnResult {
  finalResponse: string;
  events?: AgentProgressEvent[];
}

export interface AgentSession {
  readonly id: string | null;
  run: (prompt: string, options?: AgentTurnOptions) => Promise<AgentTurnResult>;
}

export interface AgentAdapter {
  createSession: (worktreePath: string) => AgentSession;
  resumeSession: (worktreePath: string, threadId: string) => AgentSession;
}

export interface GitHubClientDeps {
  fetch: typeof fetch;
  getGitHubToken: () => string;
}

export interface CommandDeps {
  execFile: (file: string, args: string[], options?: CommandOptions) => Promise<CommandResult>;
}

export interface FileSystemDeps {
  access: (targetPath: string) => Promise<void>;
  mkdir: typeof mkdir;
  readdir: typeof readdir;
  readFile: typeof readFile;
  appendFile: (targetPath: string, data: string, encoding: BufferEncoding) => Promise<void>;
  writeFile: (targetPath: string, data: string, encoding: BufferEncoding) => Promise<void>;
}

export interface ClockDeps {
  now: () => number;
}

export interface AgentThreadDeps {
  createCodexThread: (worktreePath: string) => AgentSession;
  resumeCodexThread: (worktreePath: string, threadId: string) => AgentSession;
  getCancellationSignal: () => AbortSignal | undefined;
}

export interface ActivityContextDeps {
  getHeartbeatDetails: () => unknown;
  heartbeat: (details: unknown) => void;
}

export type GitHubActivityDeps = GitHubClientDeps;

export interface WorktreeActivityDeps extends FileSystemDeps, CommandDeps, ClockDeps {}

export interface AgentActivityDeps extends FileSystemDeps, CommandDeps, AgentThreadDeps, ActivityContextDeps {}

export interface ActivityRuntimes {
  github: GitHubActivityDeps;
  worktree: WorktreeActivityDeps;
  agent: AgentActivityDeps;
}

export interface ActivityDependencies extends GitHubActivityDeps, WorktreeActivityDeps, AgentActivityDeps {}

type CodexSdkModule = typeof import('@openai/codex-sdk');

const dynamicImport = new Function('specifier', 'return import(specifier);') as (specifier: string) => Promise<unknown>;

export function createActivityDependencies(): ActivityDependencies {
  return {
    fetch: globalThis.fetch.bind(globalThis) as typeof fetch,
    getGitHubToken: () => getProcessGitHubToken(),
    access,
    mkdir,
    readdir,
    readFile,
    appendFile: (targetPath, data, encoding) => appendFile(targetPath, data, encoding),
    writeFile: (targetPath, data, encoding) => writeFile(targetPath, data, encoding),
    execFile: defaultExecFile,
    now: () => Date.now(),
    createCodexThread: (worktreePath) =>
      createLazyCodexSession('startThread', async () => {
        const { Codex } = await loadCodexSdk();
        return new Codex().startThread(buildCodexThreadOptions(worktreePath));
      }),
    resumeCodexThread: (worktreePath, threadId) =>
      createLazyCodexSession('resumeThread', async () => {
        const { Codex } = await loadCodexSdk();
        return new Codex().resumeThread(threadId, buildCodexThreadOptions(worktreePath));
      }),
    getHeartbeatDetails: () => getActivityHeartbeatDetails(),
    heartbeat: (details) => heartbeatActivity(details),
    getCancellationSignal: () => getActivityCancellationSignal(),
  };
}

export async function execCommand(
  deps: CommandDeps,
  file: string,
  args: string[],
  options: CommandOptions = {},
  allowedExitCodes: number[] = [0],
): Promise<CommandResult> {
  let result: CommandResult;

  try {
    result = await deps.execFile(file, args, options);
  } catch (error) {
    throw new Error(`${file} ${args.join(' ')} failed in ${options.cwd ?? process.cwd()}: ${toErrorMessage(error)}`);
  }

  if (!allowedExitCodes.includes(result.exitCode)) {
    const details = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
    throw new Error(`${file} ${args.join(' ')} failed in ${options.cwd ?? process.cwd()}: ${details}`);
  }

  return result;
}

export function git(
  deps: CommandDeps,
  cwd: string,
  args: string[],
  allowedExitCodes: number[] = [0],
): Promise<CommandResult> {
  return execCommand(deps, 'git', args, { cwd }, allowedExitCodes);
}

export async function pathExists(deps: FileSystemDeps, targetPath: string): Promise<boolean> {
  try {
    await deps.access(targetPath);
    return true;
  } catch (error) {
    if (isNotFoundError(error)) {
      return false;
    }
    throw error;
  }
}

export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function defaultExecFile(
  file: string,
  args: string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  const result = await execa(file, args, {
    cwd: options.cwd,
    reject: false,
    signal: options.signal,
    stdin: 'ignore',
  });

  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode ?? 1,
  };
}

function buildCodexThreadOptions(worktreePath: string) {
  return {
    approvalPolicy: 'never' as const,
    model: CODEX_MODEL,
    modelReasoningEffort: CODEX_REASONING_EFFORT,
    sandboxMode: 'workspace-write' as const,
    workingDirectory: worktreePath,
  };
}

export function createCodexAgentAdapter(deps: Pick<AgentThreadDeps, 'createCodexThread' | 'resumeCodexThread'>): AgentAdapter {
  return {
    createSession: (worktreePath) => deps.createCodexThread(worktreePath),
    resumeSession: (worktreePath, threadId) => deps.resumeCodexThread(worktreePath, threadId),
  };
}

export function createLazyCodexSession(factoryName: 'startThread' | 'resumeThread', factory: () => Promise<unknown>): AgentSession {
  let resolvedThread: { id: unknown; run: (prompt: string, options?: unknown) => Promise<unknown> } | undefined;
  let threadPromise: Promise<{ id: unknown; run: (prompt: string, options?: unknown) => Promise<unknown> }> | undefined;

  const getThread = async () => {
    if (!threadPromise) {
      threadPromise = factory()
        .then((thread) => {
          const validatedThread = assertCodexThread(thread, factoryName);
          resolvedThread = validatedThread;
          return validatedThread;
        })
        .catch((error) => {
          threadPromise = undefined;
          throw error;
        });
    }

    return threadPromise;
  };

  return {
    get id() {
      if (!resolvedThread) {
        return null;
      }

      return readCodexThreadId(resolvedThread, factoryName);
    },
    async run(prompt, options) {
      const thread = await getThread();
      const turn = await thread.run(prompt, options);
      const result = assertCodexTurnResult(turn, factoryName);
      for (const event of result.events ?? []) {
        options?.onEvent?.(event);
      }
      return result;
    },
  };
}

function assertCodexThread(
  value: unknown,
  factoryName: 'startThread' | 'resumeThread',
): { id: unknown; run: (prompt: string, options?: unknown) => Promise<unknown> } {
  if (!value || typeof value !== 'object' || typeof (value as { run?: unknown }).run !== 'function') {
    throw new Error(`Codex ${factoryName}() did not return a thread with a callable run() method.`);
  }

  return value as { id: unknown; run: (prompt: string, options?: unknown) => Promise<unknown> };
}

function readCodexThreadId(value: { id: unknown }, factoryName: 'startThread' | 'resumeThread'): string | null {
  if (value.id === undefined || value.id === null) {
    return null;
  }

  if (typeof value.id !== 'string') {
    throw new Error(`Codex ${factoryName}() returned a thread with a non-string id.`);
  }

  return value.id;
}

function assertCodexTurnResult(value: unknown, factoryName: 'startThread' | 'resumeThread'): AgentTurnResult {
  if (!value || typeof value !== 'object' || typeof (value as { finalResponse?: unknown }).finalResponse !== 'string') {
    throw new Error(`Codex ${factoryName}().run() did not return a finalResponse string.`);
  }

  const events: AgentProgressEvent[] = [];
  if (Array.isArray((value as { items?: unknown }).items)) {
    for (const item of (value as { items: unknown[] }).items) {
      events.push({ type: 'provider-item', payload: item });
    }
  }
  const usage = (value as { usage?: unknown }).usage;
  if (usage !== undefined && usage !== null) {
    events.push({ type: 'usage', payload: usage });
  }

  return {
    finalResponse: (value as { finalResponse: string }).finalResponse,
    ...(events.length > 0 ? { events } : {}),
  };
}

async function loadCodexSdk(): Promise<CodexSdkModule> {
  return (await dynamicImport('@openai/codex-sdk')) as CodexSdkModule;
}

function getProcessGitHubToken(): string {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!token) {
    throw new Error('Set GITHUB_TOKEN or GH_TOKEN on the worker process before running GitHub activities.');
  }
  return token;
}

function getActivityHeartbeatDetails(): unknown {
  const context = getCurrentActivityContextOrUndefined();
  return context?.info.heartbeatDetails;
}

function heartbeatActivity(details: unknown): void {
  const context = getCurrentActivityContextOrUndefined();
  if (!context) {
    return;
  }

  context.heartbeat(details);
}

function getActivityCancellationSignal(): AbortSignal | undefined {
  const context = getCurrentActivityContextOrUndefined();
  return context?.cancellationSignal;
}

function getCurrentActivityContextOrUndefined(): ReturnType<typeof Context.current> | undefined {
  try {
    return Context.current();
  } catch (error) {
    if (isMissingActivityContextError(error)) {
      return undefined;
    }

    throw error;
  }
}

function isMissingActivityContextError(error: unknown): boolean {
  return error instanceof Error && error.message === 'Activity context not initialized';
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}