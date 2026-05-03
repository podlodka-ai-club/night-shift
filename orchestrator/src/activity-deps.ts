import { access, appendFile, mkdir, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { Context } from '@temporalio/activity';
import { WorkflowNotFoundError } from '@temporalio/common';
import { execa } from 'execa';
import { type AgentProfileName } from './shared';
import { computeModelCostMicroUsd } from './agent-pricing';
import {
  DEFAULT_AGENT_MODEL_BY_PROVIDER,
  resolveAgentProviderSelection,
  type RequestedAgentProviderSelection,
} from './agent-provider';

export const CODEX_COMMAND = 'codex';
export const CODEX_MODEL = DEFAULT_AGENT_MODEL_BY_PROVIDER.codex;
export const CLAUDE_MODEL = DEFAULT_AGENT_MODEL_BY_PROVIDER.claude;
export const CODEX_REASONING_EFFORT = 'low' as const;
export const ESCALATION_CODEX_MODEL = 'gpt-5.4';
export const ESCALATION_CODEX_REASONING_EFFORT = 'high' as const;

export type AgentReasoningEffort = 'low' | 'medium' | 'high';

export interface AgentProfile {
  model: string;
  reasoningEffort: AgentReasoningEffort;
}

export type AgentProfiles = Record<AgentProfileName, AgentProfile>;
type CodexAgentSelection = AgentProfileName | string;

const DEFAULT_AGENT_PROFILES: AgentProfiles = {
  default: {
    model: CODEX_MODEL,
    reasoningEffort: CODEX_REASONING_EFFORT,
  },
  escalation: {
    model: ESCALATION_CODEX_MODEL,
    reasoningEffort: ESCALATION_CODEX_REASONING_EFFORT,
  },
};

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
  systemPrompt?: string;
  signal?: AbortSignal;
  onEvent?: (event: AgentProgressEvent) => void;
}

export interface AgentUsage {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
}

export interface AgentTurnResult {
  finalResponse: string;
  events?: AgentProgressEvent[];
  usage?: AgentUsage | null;
  costMicroUsd?: number;
}

export interface AgentSession {
  readonly id: string | null;
  run: (prompt: string, options?: AgentTurnOptions) => Promise<AgentTurnResult>;
}

export interface AgentAdapter {
  createSession: (worktreePath: string, agentProfile?: AgentProfileName) => AgentSession;
  resumeSession: (worktreePath: string, threadId: string, agentProfile?: AgentProfileName) => AgentSession;
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
  realpath: typeof realpath;
  rm: typeof rm;
  appendFile: (targetPath: string, data: string, encoding: BufferEncoding) => Promise<void>;
  writeFile: (targetPath: string, data: string, encoding: BufferEncoding) => Promise<void>;
}

export interface ClockDeps {
  now: () => number;
}

export interface AgentThreadDeps {
  createCodexThread: (worktreePath: string, selection?: CodexAgentSelection) => AgentSession;
  resumeCodexThread: (worktreePath: string, threadId: string, selection?: CodexAgentSelection) => AgentSession;
  createClaudeSession: (worktreePath: string, model?: string) => AgentSession;
  resumeClaudeSession: (worktreePath: string, threadId: string, model?: string) => AgentSession;
  getAgentProfile: (agentProfile?: AgentProfileName) => AgentProfile;
  getCancellationSignal: () => AbortSignal | undefined;
}

export interface ActivityContextDeps {
  getHeartbeatDetails: () => unknown;
  heartbeat: (details: unknown) => void;
  signalProgress: (message: string) => Promise<void>;
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
type ClaudeQuery = (params: { prompt: string; options?: Record<string, unknown> }) => AsyncIterable<unknown>;

const dynamicImport = new Function('specifier', 'return import(specifier);') as (specifier: string) => Promise<unknown>;

export interface CreateActivityDependenciesOptions {
  signalWorkflowProgress?: (workflowId: string, message: string) => Promise<void>;
  agentProfiles?: Partial<AgentProfiles>;
}

export function createActivityDependencies(options: CreateActivityDependenciesOptions = {}): ActivityDependencies {
  const agentProfiles = resolveAgentProfiles(options.agentProfiles);

  return {
    fetch: globalThis.fetch.bind(globalThis) as typeof fetch,
    getGitHubToken: () => getProcessGitHubToken(),
    access,
    mkdir,
    readdir,
    readFile,
    realpath,
    rm,
    appendFile: (targetPath, data, encoding) => appendFile(targetPath, data, encoding),
    writeFile: (targetPath, data, encoding) => writeFile(targetPath, data, encoding),
    execFile: defaultExecFile,
    now: () => Date.now(),
    createCodexThread: (worktreePath, selection = 'default') => {
      const profile = resolveCodexAgentProfile(agentProfiles, selection);
      return createLazyCodexSession('startThread', async () => {
        const { Codex } = await loadCodexSdk();
        return new Codex().startThread(buildCodexThreadOptions(worktreePath, profile));
      }, profile.model);
    },
    resumeCodexThread: (worktreePath, threadId, selection = 'default') => {
      const profile = resolveCodexAgentProfile(agentProfiles, selection);
      return createLazyCodexSession('resumeThread', async () => {
        const { Codex } = await loadCodexSdk();
        return new Codex().resumeThread(threadId, buildCodexThreadOptions(worktreePath, profile));
      }, profile.model);
    },
    createClaudeSession: (worktreePath, model = CLAUDE_MODEL) =>
      createLazyClaudeSession({
        model,
        worktreePath,
        queryFactory: async (params) => (await loadClaudeQuery())(params),
      }),
    resumeClaudeSession: (worktreePath, threadId, model = CLAUDE_MODEL) =>
      createLazyClaudeSession({
        model,
        worktreePath,
        initialSessionId: threadId,
        queryFactory: async (params) => (await loadClaudeQuery())(params),
      }),
    getAgentProfile: (agentProfile = 'default') => agentProfiles[agentProfile],
    getHeartbeatDetails: () => getActivityHeartbeatDetails(),
    heartbeat: (details) => heartbeatActivity(details),
    signalProgress: async (message) => signalActivityProgress(options, message),
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

function buildCodexThreadOptions(worktreePath: string, agentProfile: AgentProfile) {
  return {
    approvalPolicy: 'never' as const,
    model: agentProfile.model,
    modelReasoningEffort: agentProfile.reasoningEffort,
    sandboxMode: 'workspace-write' as const,
    workingDirectory: worktreePath,
  };
}

export function createCodexAgentAdapter(
  deps: Pick<AgentThreadDeps, 'createCodexThread' | 'resumeCodexThread'>,
  model: string = CODEX_MODEL,
): AgentAdapter {
  return {
    createSession: (worktreePath, agentProfile) => deps.createCodexThread(worktreePath, agentProfile ?? model),
    resumeSession: (worktreePath, threadId, agentProfile) => deps.resumeCodexThread(worktreePath, threadId, agentProfile ?? model),
  };
}

export function resolveAgentProfiles(overrides: Partial<AgentProfiles> | undefined): AgentProfiles {
  return {
    default: {
      ...DEFAULT_AGENT_PROFILES.default,
      ...overrides?.default,
    },
    escalation: {
      ...DEFAULT_AGENT_PROFILES.escalation,
      ...overrides?.escalation,
    },
  };
}

function resolveCodexAgentProfile(agentProfiles: AgentProfiles, selection: CodexAgentSelection | undefined): AgentProfile {
  if (selection === undefined || selection === 'default' || selection === 'escalation') {
    return agentProfiles[selection ?? 'default'];
  }

  return {
    model: selection,
    reasoningEffort: CODEX_REASONING_EFFORT,
  };
}

export function createClaudeAgentAdapter(
  deps: Pick<AgentThreadDeps, 'createClaudeSession' | 'resumeClaudeSession'>,
  model: string = CLAUDE_MODEL,
): AgentAdapter {
  return {
    createSession: (worktreePath) => deps.createClaudeSession(worktreePath, model),
    resumeSession: (worktreePath, threadId) => deps.resumeClaudeSession(worktreePath, threadId, model),
  };
}

export function createProviderAgentAdapter(
  selection: RequestedAgentProviderSelection,
  deps: Pick<
    AgentThreadDeps,
    'createCodexThread' | 'resumeCodexThread' | 'createClaudeSession' | 'resumeClaudeSession'
  >,
): AgentAdapter {
  const resolved = resolveAgentProviderSelection(selection);
  switch (resolved.provider) {
    case 'claude':
      return createClaudeAgentAdapter(deps, resolved.model);
    case 'codex':
      return createCodexAgentAdapter(deps, resolved.model);
    default:
      return assertNever(resolved.provider);
  }
}

export function createLazyCodexSession(
  factoryName: 'startThread' | 'resumeThread',
  factory: () => Promise<unknown>,
  model: string = CODEX_MODEL,
): AgentSession {
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
      const result = assertCodexTurnResult(turn, factoryName, model);
      for (const event of result.events ?? []) {
        options?.onEvent?.(event);
      }
      return result;
    },
  };
}

interface CreateLazyClaudeSessionOptions {
  model: string;
  worktreePath: string;
  initialSessionId?: string;
  queryFactory: (params: { prompt: string; options?: Record<string, unknown> }) => AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>;
  onQuery?: (params: { prompt: string; options?: Record<string, unknown> }) => void;
}

export function createLazyClaudeSession(options: CreateLazyClaudeSessionOptions): AgentSession {
  let sessionId = options.initialSessionId ?? null;

  return {
    get id() {
      return sessionId;
    },
    async run(prompt, turnOptions) {
      const queryParams = {
        prompt,
        options: buildClaudeQueryOptions(options.worktreePath, options.model, sessionId, turnOptions),
      };
      options.onQuery?.(queryParams);
      const query = await Promise.resolve(options.queryFactory(queryParams));
      const events: AgentProgressEvent[] = [];
      let resultMessage: Record<string, unknown> | undefined;
      let lastAssistantText = '';

      for await (const item of query) {
        events.push({ type: 'provider-item', payload: item });
        if (isRecord(item) && typeof item.session_id === 'string') {
          sessionId = item.session_id;
        }
        if (isRecord(item) && item.type === 'assistant') {
          const assistantText = extractClaudeAssistantText(item);
          if (assistantText) {
            lastAssistantText = assistantText;
          }
        }
        if (isRecord(item) && item.type === 'result') {
          resultMessage = item;
        }
      }

      if (!resultMessage) {
        throw new Error('Claude query stream ended without a result message.');
      }
      if (resultMessage.subtype !== 'success') {
        const errors = Array.isArray(resultMessage.errors)
          ? resultMessage.errors.filter((entry): entry is string => typeof entry === 'string')
          : [];
        throw new Error(`Claude turn failed (${String(resultMessage.subtype)}): ${errors.join('; ') || 'unknown error'}`);
      }

      const usage = parseClaudeUsage(resultMessage.usage);
      if (usage) {
        events.push({ type: 'usage', payload: usage });
      }
      const costMicroUsd = usage ? computeModelCostMicroUsd(options.model, usage) : undefined;
      const result: AgentTurnResult = {
        finalResponse: readClaudeFinalResponse(resultMessage, lastAssistantText),
        ...(events.length > 0 ? { events } : {}),
        ...(usage ? { usage } : {}),
        ...(typeof costMicroUsd === 'number' ? { costMicroUsd } : {}),
      };
      for (const event of events) {
        turnOptions?.onEvent?.(event);
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

function assertCodexTurnResult(value: unknown, factoryName: 'startThread' | 'resumeThread', model: string): AgentTurnResult {
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
  const parsedUsage = parseAgentUsage(usage);
  if (parsedUsage) {
    events.push({ type: 'usage', payload: parsedUsage });
  }
  const rawCostMicroUsd = parseCostMicroUsd((value as { costMicroUsd?: unknown; cost?: unknown }).costMicroUsd ?? (value as { cost?: unknown }).cost);
  const costMicroUsd = rawCostMicroUsd ?? (parsedUsage ? computeModelCostMicroUsd(model, parsedUsage) : undefined);

  return {
    finalResponse: (value as { finalResponse: string }).finalResponse,
    ...(events.length > 0 ? { events } : {}),
    ...(parsedUsage ? { usage: parsedUsage } : {}),
    ...(costMicroUsd === undefined ? {} : { costMicroUsd }),
  };
}

function parseAgentUsage(value: unknown): AgentUsage | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const usage = value as Record<string, unknown>;
  const inputTokens = usage.input_tokens ?? usage.inputTokens;
  const cachedInputTokens = usage.cached_input_tokens ?? usage.cachedInputTokens ?? 0;
  const outputTokens = usage.output_tokens ?? usage.outputTokens;
  if (![inputTokens, cachedInputTokens, outputTokens].every(isNonNegativeFiniteNumber)) {
    return undefined;
  }

  return {
    input_tokens: inputTokens,
    cached_input_tokens: cachedInputTokens,
    output_tokens: outputTokens,
  } as AgentUsage;
}

function parseClaudeUsage(value: unknown): AgentUsage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const uncachedInputTokens = value.input_tokens;
  const cacheReadInputTokens = value.cache_read_input_tokens ?? 0;
  const cacheCreationInputTokens = value.cache_creation_input_tokens ?? 0;
  const outputTokens = value.output_tokens;
  if (![uncachedInputTokens, cacheReadInputTokens, cacheCreationInputTokens, outputTokens].every(isNonNegativeFiniteNumber)) {
    return undefined;
  }

  // Claude exposes cache-creation writes separately. Task 7 keeps the donor's
  // pricing metadata shape, so we currently fold those writes into full-price
  // input usage instead of introducing a third cache-creation rate field.
  return {
    input_tokens: uncachedInputTokens + cacheReadInputTokens + cacheCreationInputTokens,
    cached_input_tokens: cacheReadInputTokens,
    output_tokens: outputTokens,
  };
}

function parseCostMicroUsd(value: unknown): number | undefined {
  return isNonNegativeFiniteNumber(value) ? Math.round(value) : undefined;
}

function buildClaudeQueryOptions(
  worktreePath: string,
  model: string,
  sessionId: string | null,
  turnOptions: AgentTurnOptions | undefined,
): Record<string, unknown> {
  const options: Record<string, unknown> = {
    model,
    cwd: worktreePath,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
  };
  if (turnOptions?.systemPrompt !== undefined) {
    options.systemPrompt = turnOptions.systemPrompt;
  }
  if (turnOptions?.outputSchema !== undefined) {
    options.outputFormat = {
      type: 'json_schema',
      schema: turnOptions.outputSchema as Record<string, unknown>,
    };
  }
  if (sessionId) {
    options.resume = sessionId;
  }
  if (turnOptions?.signal) {
    const abortController = new AbortController();
    if (turnOptions.signal.aborted) {
      abortController.abort();
    } else {
      turnOptions.signal.addEventListener('abort', () => abortController.abort(), { once: true });
    }
    options.abortController = abortController;
  }
  return options;
}

function extractClaudeAssistantText(message: Record<string, unknown>): string {
  const blocks = isRecord(message.message) && Array.isArray(message.message.content)
    ? message.message.content
    : [];
  let text = '';
  for (const block of blocks) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') {
      text += block.text;
    }
  }
  return text;
}

function readClaudeFinalResponse(message: Record<string, unknown>, lastAssistantText: string): string {
  if (message.structured_output !== undefined) {
    return JSON.stringify(message.structured_output);
  }
  if (typeof message.result === 'string' && message.result.length > 0) {
    return message.result;
  }
  return lastAssistantText;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null;
}

function assertNever(value: never): never {
  throw new Error(`Unsupported provider: ${String(value)}`);
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

async function loadClaudeQuery(): Promise<ClaudeQuery> {
  const module = await dynamicImport('@anthropic-ai/claude-agent-sdk') as { query?: unknown };
  if (typeof module.query !== 'function') {
    throw new Error('@anthropic-ai/claude-agent-sdk did not expose a callable query() function.');
  }
  return module.query as ClaudeQuery;
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

async function signalActivityProgress(options: CreateActivityDependenciesOptions, message: string): Promise<void> {
  if (!options.signalWorkflowProgress) {
    return;
  }

  const workflowId = getCurrentActivityWorkflowId();
  if (!workflowId) {
    return;
  }

  try {
    await options.signalWorkflowProgress(workflowId, message);
  } catch (error) {
    if (error instanceof WorkflowNotFoundError) {
      return;
    }
    throw error;
  }
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

function getCurrentActivityWorkflowId(): string | undefined {
  const context = getCurrentActivityContextOrUndefined();
  return context?.info.workflowExecution.workflowId;
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