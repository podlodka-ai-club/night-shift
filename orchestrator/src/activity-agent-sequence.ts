import path from 'node:path';
import {
  applyPendingStepCompletion,
  assertCheckpointMatchesStepSequence,
  buildPendingPromptStepCompletion,
  buildPendingStructuredStepCompletion,
  cloneAgentOutputs,
  createCheckpointSnapshot,
  readAgentCheckpoint,
  type AgentCheckpoint,
  type PendingStepCompletion,
} from './activity-agent-checkpoint';
import { buildTaskImplementationPrompt } from './agent-prompts';
import { getAgentSchema } from './agent-schema-registry';
import { type AgentSequenceResult, type AgentStep, type RunAgentLegacyInput, type RunAgentSequenceInput, type WorktreeContext } from './shared';
import { buildDummyChangeContent } from './activity-worktree';
import { CODEX_COMMAND, CODEX_MODEL, CODEX_REASONING_EFFORT, execCommand, type AgentActivityDeps, type AgentThread, type AgentTurnResult, toErrorMessage } from './activity-deps';

const AGENT_TURN_HEARTBEAT_INTERVAL_MS = 10_000;

export function createAgentActivities(deps: AgentActivityDeps) {
  return {
    async runAgentLegacy(input: RunAgentLegacyInput): Promise<void> {
      const { worktree } = input;
      await codex(deps, worktree.worktreePath, buildTaskImplementationPrompt(worktree.taskDescription));
    },

    async runAgentSequence(input: RunAgentSequenceInput): Promise<AgentSequenceResult> {
      if (input.steps.length === 0) {
        throw new Error('Agent step sequences must not be empty.');
      }

      return runAgentSequenceSteps(deps, input.worktree, input.steps);
    },

    async runDummyAgent(input: { worktree: WorktreeContext }): Promise<void> {
      const { worktree } = input;
      await writeDummyFile(
        deps,
        worktree.worktreePath,
        worktree.filePath,
        buildDummyChangeContent(worktree.issueNumber, worktree.issueTitle, worktree.generatedAt),
      );
    },
  };
}

async function runAgentSequenceSteps(
  deps: AgentActivityDeps,
  worktree: WorktreeContext,
  steps: AgentStep[],
): Promise<AgentSequenceResult> {
  assertUniqueStepIds(steps);
  const checkpoint = readAgentCheckpoint(deps.getHeartbeatDetails());
  assertCheckpointMatchesStepSequence(checkpoint, steps);
  const completedStepIds = [...(checkpoint.completedStepIds ?? [])];
  const outputs = cloneAgentOutputs(checkpoint.outputs ?? {});
  let finalResponse = checkpoint.finalResponse;
  let threadId = checkpoint.threadId;

  if (checkpoint.pendingStep) {
    const resumedState = applyPendingStepCompletion(checkpoint.pendingStep, completedStepIds, outputs, finalResponse);
    finalResponse = resumedState.finalResponse;

    if (!threadId) {
      throw new Error(`Codex thread id was unavailable while finalizing step ${checkpoint.pendingStep.stepId}.`);
    }

    deps.heartbeat(createCheckpointSnapshot({ threadId, completedStepIds, outputs, finalResponse }));
  }

  let thread: AgentThread | undefined;

  function getThread(): AgentThread {
    thread ??= threadId
      ? assertActivityThread(deps.resumeCodexThread(worktree.worktreePath, threadId), 'resumeCodexThread')
      : assertActivityThread(deps.createCodexThread(worktree.worktreePath), 'createCodexThread');
    return thread;
  }

  for (const step of steps) {
    if (completedStepIds.includes(step.id)) {
      continue;
    }

    const currentThread = getThread();
    let pendingStep: PendingStepCompletion;

    if (step.kind === 'prompt') {
      const turn = await runThreadTurnWithHeartbeat(deps, currentThread, step.prompt, buildAgentTurnOptions(deps), () => ({
        threadId: currentThread.id ?? threadId,
        completedStepIds,
        outputs,
        finalResponse,
      }));
      finalResponse = turn.finalResponse;
      pendingStep = buildPendingPromptStepCompletion(step, turn.finalResponse);
    } else {
      const { finalResponse: structuredResponse, parsedOutput } = await runStructuredStep(deps, currentThread, step, () => ({
        threadId: currentThread.id ?? threadId,
        completedStepIds,
        outputs,
        finalResponse,
      }));
      finalResponse = structuredResponse;
      pendingStep = buildPendingStructuredStepCompletion(step, structuredResponse, parsedOutput);
    }

    threadId = currentThread.id ?? threadId;
    if (!threadId) {
      throw new Error(`Codex thread id was unavailable after completing step ${step.id}.`);
    }

    deps.heartbeat(createCheckpointSnapshot({ threadId, completedStepIds, outputs, finalResponse, pendingStep }));
    finalResponse = applyPendingStepCompletion(pendingStep, completedStepIds, outputs, finalResponse).finalResponse;
    deps.heartbeat(createCheckpointSnapshot({ threadId, completedStepIds, outputs, finalResponse }));
  }

  if (!threadId) {
    throw new Error('Codex thread id was not available after running the agent sequence.');
  }

  return { threadId, completedStepIds: [...completedStepIds], outputs: { ...outputs }, finalResponse };
}

async function runStructuredStep(
  deps: AgentActivityDeps,
  thread: AgentThread,
  step: Extract<AgentStep, { kind: 'structured' }>,
  getCheckpointDetails: () => AgentCheckpoint,
): Promise<{ finalResponse: string; parsedOutput?: unknown }> {
  const schemaDefinition = getAgentSchema(step.schemaId);
  const firstTurn = await runThreadTurnWithHeartbeat(
    deps,
    thread,
    step.prompt,
    { ...buildAgentTurnOptions(deps), outputSchema: schemaDefinition.jsonSchema },
    getCheckpointDetails,
  );
  const firstParsed = parseStructuredOutput(firstTurn.finalResponse, schemaDefinition.schema);
  if (firstParsed.success) {
    return { finalResponse: firstTurn.finalResponse, parsedOutput: firstParsed.parsedOutput };
  }

  const repairTurn = await runThreadTurnWithHeartbeat(
    deps,
    thread,
    buildStructuredOutputRepairPrompt(step, firstTurn.finalResponse, firstParsed.errorMessage),
    { ...buildAgentTurnOptions(deps), outputSchema: schemaDefinition.jsonSchema },
    getCheckpointDetails,
  );
  const repairParsed = parseStructuredOutput(repairTurn.finalResponse, schemaDefinition.schema);
  if (!repairParsed.success) {
    throw new Error(
      [
        `Structured output step ${step.id} did not satisfy schema ${step.schemaId}.`,
        `Initial parse failed: ${firstParsed.errorMessage}`,
        `Repair parse failed: ${repairParsed.errorMessage}`,
      ].join(' '),
    );
  }

  return { finalResponse: repairTurn.finalResponse, parsedOutput: repairParsed.parsedOutput };
}

async function runThreadTurnWithHeartbeat(
  deps: AgentActivityDeps,
  thread: AgentThread,
  prompt: string,
  options: { outputSchema?: unknown; signal?: AbortSignal } | undefined,
  getCheckpointDetails: () => AgentCheckpoint,
): Promise<AgentTurnResult> {
  let intervalError: unknown;
  deps.heartbeat(createCheckpointSnapshot(getCheckpointDetails()));
  const interval = setInterval(() => {
    try {
      deps.heartbeat(createCheckpointSnapshot(getCheckpointDetails()));
    } catch (error) {
      intervalError = error;
      clearInterval(interval);
    }
  }, AGENT_TURN_HEARTBEAT_INTERVAL_MS);

  interval.unref?.();

  try {
    const turn = await thread.run(prompt, options);
    if (intervalError) {
      throw intervalError;
    }

    return turn;
  } catch (runError) {
    if (intervalError) {
      throw intervalError;
    }

    deps.heartbeat(createCheckpointSnapshot(getCheckpointDetails()));
    throw runError;
  } finally {
    clearInterval(interval);
  }
}

function parseStructuredOutput(
  finalResponse: string,
  schema: { parse: (value: unknown) => unknown },
): { success: true; parsedOutput: unknown } | { success: false; errorMessage: string } {
  let parsedJson: unknown;

  try {
    parsedJson = JSON.parse(finalResponse);
  } catch (error) {
    return { success: false, errorMessage: `Response was not valid JSON: ${toErrorMessage(error)}` };
  }

  try {
    return { success: true, parsedOutput: schema.parse(parsedJson) };
  } catch (error) {
    return { success: false, errorMessage: `Response did not match the expected schema: ${toErrorMessage(error)}` };
  }
}

function buildStructuredOutputRepairPrompt(
  step: Extract<AgentStep, { kind: 'structured' }>,
  invalidOutput: string,
  parseError: string,
): string {
  return [
    step.prompt,
    '',
    'The previous response did not satisfy the required structured output schema.',
    parseError,
    'Reply again using only data that conforms to the required schema.',
    '',
    'Previous invalid response:',
    invalidOutput,
  ].join('\n');
}

function assertUniqueStepIds(steps: AgentStep[]): void {
  const seen = new Set<string>();
  for (const step of steps) {
    if (seen.has(step.id)) {
      throw new Error(`Agent step sequences must use unique step ids. Duplicate id: ${step.id}`);
    }
    seen.add(step.id);
  }
}

function assertActivityThread(value: unknown, methodName: 'createCodexThread' | 'resumeCodexThread'): AgentThread {
  if (!value || typeof value !== 'object' || typeof (value as { run?: unknown }).run !== 'function') {
    throw new Error(`Activity runtime ${methodName}() did not return an agent thread with a callable run() method.`);
  }

  const threadId = (value as { id?: unknown }).id;
  if (!(threadId === undefined || threadId === null || typeof threadId === 'string')) {
    throw new Error(`Activity runtime ${methodName}() returned an agent thread with a non-string id.`);
  }

  return value as AgentThread;
}

function buildCodexArgs(prompt: string): string[] {
  return ['exec', '--full-auto', '--model', CODEX_MODEL, '--config', `model_reasoning_effort="${CODEX_REASONING_EFFORT}"`, prompt];
}

function codex(deps: AgentActivityDeps, cwd: string, prompt: string): Promise<unknown> {
  return execCommand(deps, CODEX_COMMAND, buildCodexArgs(prompt), { cwd, ...buildAgentTurnOptions(deps) });
}

function buildAgentTurnOptions(deps: AgentActivityDeps): { signal?: AbortSignal } {
  const signal = deps.getCancellationSignal();
  return signal ? { signal } : {};
}

async function writeDummyFile(
  deps: AgentActivityDeps,
  worktreePath: string,
  relativeFilePath: string,
  content: string,
): Promise<void> {
  const absoluteFilePath = path.join(worktreePath, relativeFilePath);
  await deps.mkdir(path.dirname(absoluteFilePath), { recursive: true });
  await deps.writeFile(absoluteFilePath, content, 'utf8');
}