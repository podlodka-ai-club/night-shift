import { ApplicationFailure } from '@temporalio/common';
import {
  applyPendingStepCompletion,
  assertCheckpointMatchesStepSequence,
  buildPendingPromptStepCompletion,
  buildPendingStructuredStepCompletion,
  cloneAgentOutputs,
  createCheckpointSnapshot,
  readAgentCheckpoint,
  type PendingStepCompletion,
} from './activity-agent-checkpoint';
import { AgentContractError, runAgentTurnWithHeartbeat, runStructuredAgentTurn } from './activity-agent-turn';
import { buildTaskImplementationPrompt } from './agent-prompts';
import { getAgentSchema } from './agent-schema-registry';
import { type AgentProfileName, type AgentSequenceResult, type AgentStep, type RunAgentLegacyInput, type RunAgentSequenceInput, type WorktreeContext } from './shared';
import {
  CODEX_COMMAND,
  createCodexAgentAdapter,
  execCommand,
  type AgentActivityDeps,
  type AgentProgressEvent,
  type AgentSession,
  type AgentTurnOptions,
} from './activity-deps';

export function createAgentActivities(deps: AgentActivityDeps) {
  return {
    async runAgentLegacy(input: RunAgentLegacyInput): Promise<void> {
      const { worktree, agentProfile } = input;
      await codex(deps, worktree.worktreePath, buildTaskImplementationPrompt(worktree.taskDescription), agentProfile);
    },

    async runAgentSequence(input: RunAgentSequenceInput): Promise<AgentSequenceResult> {
      if (input.steps.length === 0) {
        throw new Error('Agent step sequences must not be empty.');
      }

      try {
        return await runAgentSequenceSteps(deps, input.worktree, input.steps, input.agentProfile);
      } catch (error) {
        if (error instanceof AgentContractError) {
          throw ApplicationFailure.fromError(error, { nonRetryable: true });
        }
        throw error;
      }
    },
  };
}

async function runAgentSequenceSteps(
  deps: AgentActivityDeps,
  worktree: WorktreeContext,
  steps: AgentStep[],
  agentProfile: AgentProfileName | undefined,
): Promise<AgentSequenceResult> {
  assertUniqueStepIds(steps);
  const checkpoint = readAgentCheckpoint(deps.getHeartbeatDetails());
  assertCheckpointMatchesStepSequence(checkpoint, steps);
  const stepsById = new Map(steps.map((step) => [step.id, step]));
  const completedStepIds = [...(checkpoint.completedStepIds ?? [])];
  const outputs = cloneAgentOutputs(checkpoint.outputs ?? {});
  let finalResponse = checkpoint.finalResponse;
  let threadId = checkpoint.threadId;
  const adapter = createCodexAgentAdapter(deps);
  let lastProgressMessage: string | undefined;

  if (checkpoint.pendingStep) {
    const validatedPendingStep = validatePendingStepCompletion(checkpoint.pendingStep, stepsById);
    const resumedState = applyPendingStepCompletion(validatedPendingStep, completedStepIds, outputs, finalResponse);
    finalResponse = resumedState.finalResponse;

    if (!threadId) {
      throw new Error(`Codex thread id was unavailable while finalizing step ${validatedPendingStep.stepId}.`);
    }

    deps.heartbeat(createCheckpointSnapshot({ threadId, completedStepIds, outputs, finalResponse }));
  }

  let session: AgentSession | undefined;

  function getSession(): AgentSession {
    session ??= threadId
      ? assertActivitySession(adapter.resumeSession(worktree.worktreePath, threadId, agentProfile), 'resumeCodexThread')
      : assertActivitySession(adapter.createSession(worktree.worktreePath, agentProfile), 'createCodexThread');
    return session;
  }

  const reportProgress = (message: string): void => {
    const normalizedMessage = message.trim();
    if (!normalizedMessage || normalizedMessage === lastProgressMessage) {
      return;
    }
    lastProgressMessage = normalizedMessage;
    void deps.signalProgress(normalizedMessage).catch(() => undefined);
  };

  const handleProgressEvent = (event: AgentProgressEvent): void => {
    const message = extractAssistantProgressMessage(event);
    if (message) {
      reportProgress(message);
    }
  };

  for (const step of steps) {
    if (completedStepIds.includes(step.id)) {
      continue;
    }

    const currentSession = getSession();
    let pendingStep: PendingStepCompletion;

    if (step.kind === 'prompt') {
      const turn = await runAgentTurnWithHeartbeat(deps, currentSession, step.prompt, buildAgentTurnOptions(deps, handleProgressEvent, step.systemPrompt), () => ({
        threadId: currentSession.id ?? threadId,
        completedStepIds,
        outputs,
        finalResponse,
      }));
      finalResponse = turn.finalResponse;
      pendingStep = buildPendingPromptStepCompletion(step, turn.finalResponse);
    } else {
      const schemaDefinition = getAgentSchema(step.schemaId);
      const { finalResponse: structuredResponse, parsedOutput } = await runStructuredAgentTurn(deps, currentSession, {
        stepId: step.id,
        prompt: step.prompt,
        systemPrompt: step.systemPrompt,
        contract: {
          jsonSchema: schemaDefinition.jsonSchema,
          parse: (value) => schemaDefinition.schema.parse(value),
        },
        getCheckpointDetails: () => ({
          threadId: currentSession.id ?? threadId,
          completedStepIds,
          outputs,
          finalResponse,
        }),
        onEvent: handleProgressEvent,
      });
      finalResponse = structuredResponse;
      pendingStep = buildPendingStructuredStepCompletion(step, structuredResponse, parsedOutput);
    }

    threadId = currentSession.id ?? threadId;
    if (!threadId) {
      throw new Error(`Codex thread id was unavailable after completing step ${step.id}.`);
    }

    deps.heartbeat(createCheckpointSnapshot({ threadId, completedStepIds, outputs, finalResponse, pendingStep }));
    // Keep the pending-step heartbeat separate from the finalized heartbeat so a crash between
    // the two can resume by finalizing the already-completed step instead of re-running Codex.
    finalResponse = applyPendingStepCompletion(pendingStep, completedStepIds, outputs, finalResponse).finalResponse;
    deps.heartbeat(createCheckpointSnapshot({ threadId, completedStepIds, outputs, finalResponse }));
  }

  if (!threadId) {
    throw new Error('Codex thread id was not available after running the agent sequence.');
  }

  return { threadId, completedStepIds: [...completedStepIds], outputs: { ...outputs }, finalResponse };
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

function validatePendingStepCompletion(
  pendingStep: PendingStepCompletion,
  stepsById: ReadonlyMap<string, AgentStep>,
): PendingStepCompletion {
  const step = stepsById.get(pendingStep.stepId);
  if (!step) {
    return pendingStep;
  }

  if (step.kind === 'prompt') {
    return pendingStep;
  }

  if (!pendingStep.output) {
    throw new Error(`Heartbeat checkpoint contains invalid ${step.resultKey} output for pending step ${step.id}.`);
  }

  const schemaDefinition = getAgentSchema(step.schemaId);
  try {
    return {
      ...pendingStep,
      output: {
        resultKey: step.resultKey,
        parsedOutput: schemaDefinition.schema.parse(pendingStep.output.parsedOutput),
      },
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Heartbeat checkpoint contains invalid ${step.resultKey} output for pending step ${step.id}: ${detail}`);
  }
}

function assertActivitySession(value: unknown, methodName: 'createCodexThread' | 'resumeCodexThread'): AgentSession {
  if (!value || typeof value !== 'object' || typeof (value as { run?: unknown }).run !== 'function') {
    throw new Error(`Activity runtime ${methodName}() did not return an agent thread with a callable run() method.`);
  }

  const threadId = (value as { id?: unknown }).id;
  if (!(threadId === undefined || threadId === null || typeof threadId === 'string')) {
    throw new Error(`Activity runtime ${methodName}() returned an agent thread with a non-string id.`);
  }

  // Keep this assertion even though the real Codex adapter validates sessions already: tests inject
  // raw mocked sessions directly through the activity deps and should still fail with a clear error.
  return value as AgentSession;
}

function buildCodexArgs(deps: Pick<AgentActivityDeps, 'getAgentProfile'>, prompt: string, agentProfile: AgentProfileName | undefined): string[] {
  const profile = deps.getAgentProfile(agentProfile);
  return ['exec', '--full-auto', '--model', profile.model, '--config', `model_reasoning_effort="${profile.reasoningEffort}"`, prompt];
}

function codex(deps: AgentActivityDeps, cwd: string, prompt: string, agentProfile: AgentProfileName | undefined): Promise<unknown> {
  return execCommand(deps, CODEX_COMMAND, buildCodexArgs(deps, prompt, agentProfile), { cwd, ...buildAgentTurnOptions(deps) });
}

function buildAgentTurnOptions(
  deps: Pick<AgentActivityDeps, 'getCancellationSignal'>,
  onEvent?: (event: AgentProgressEvent) => void,
  systemPrompt?: string,
): AgentTurnOptions {
  const signal = deps.getCancellationSignal();
  return {
    ...(systemPrompt ? { systemPrompt } : {}),
    ...(signal ? { signal } : {}),
    ...(onEvent ? { onEvent } : {}),
  };
}

function extractAssistantProgressMessage(event: AgentProgressEvent): string | undefined {
  if (event.type !== 'provider-item') {
    return undefined;
  }

  return extractAssistantTextFromProviderItem(event.payload);
}

function extractAssistantTextFromProviderItem(item: unknown): string | undefined {
  if (!item || typeof item !== 'object') {
    return undefined;
  }

  const providerItem = item as {
    type?: unknown;
    text?: unknown;
    role?: unknown;
    content?: unknown;
  };

  if (providerItem.type === 'message.delta' && typeof providerItem.text === 'string') {
    return providerItem.text;
  }

  if (providerItem.type === 'message' && providerItem.role === 'assistant' && Array.isArray(providerItem.content)) {
    for (const entry of providerItem.content) {
      if (!entry || typeof entry !== 'object') {
        continue;
      }

      const contentEntry = entry as { type?: unknown; text?: unknown };
      if (contentEntry.type === 'output_text' && typeof contentEntry.text === 'string') {
        return contentEntry.text;
      }
    }
  }

  return undefined;
}