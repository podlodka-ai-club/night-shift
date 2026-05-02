import { AGENT_OUTPUT_KEYS, type AgentOutputKey, type AgentSequenceResult, type AgentStep } from './shared';

const MAX_CHECKPOINT_FINAL_RESPONSE_BYTES = 256 * 1024;
const CHECKPOINT_TRUNCATION_SUFFIX = '\n...[truncated for Temporal heartbeat checkpoint]';

export interface AgentCheckpoint {
  threadId?: string;
  completedStepIds?: string[];
  outputs?: AgentSequenceResult['outputs'];
  finalResponse?: string;
  pendingStep?: PendingStepCompletion;
}

export interface PendingStepCompletion {
  stepId: string;
  finalResponse: string;
  output?: { resultKey: AgentOutputKey; parsedOutput: unknown };
}

export function readAgentCheckpoint(heartbeatDetails: unknown): AgentCheckpoint {
  if (!heartbeatDetails || typeof heartbeatDetails !== 'object') {
    return {};
  }

  const checkpoint = heartbeatDetails as AgentCheckpoint & { pendingStructuredStep?: unknown };
  return {
    threadId: typeof checkpoint.threadId === 'string' ? checkpoint.threadId : undefined,
    completedStepIds: parseCompletedStepIds(checkpoint.completedStepIds),
    outputs: checkpoint.outputs && typeof checkpoint.outputs === 'object' ? cloneAgentOutputs(checkpoint.outputs) : {},
    finalResponse: typeof checkpoint.finalResponse === 'string' ? checkpoint.finalResponse : undefined,
    pendingStep:
      parsePendingStepCompletion(checkpoint.pendingStep) ??
      parseLegacyPendingStructuredStepCompletion(checkpoint.pendingStructuredStep),
  };
}

export function createCheckpointSnapshot(checkpoint: AgentCheckpoint): AgentCheckpoint {
  const snapshot: AgentCheckpoint = {
    completedStepIds: [...(checkpoint.completedStepIds ?? [])],
    outputs: cloneAgentOutputs(checkpoint.outputs ?? {}),
  };

  if (checkpoint.threadId) {
    snapshot.threadId = checkpoint.threadId;
  }
  if (checkpoint.finalResponse !== undefined) {
    snapshot.finalResponse = truncateCheckpointFinalResponse(checkpoint.finalResponse);
  }
  if (checkpoint.pendingStep) {
    snapshot.pendingStep = clonePendingStepCompletion(checkpoint.pendingStep);
  }

  return snapshot;
}

export function buildPendingStructuredStepCompletion(
  step: Extract<AgentStep, { kind: 'structured' }>,
  finalResponse: string,
  parsedOutput: unknown,
): PendingStepCompletion {
  return {
    stepId: step.id,
    finalResponse,
    output: { resultKey: step.resultKey, parsedOutput: structuredClone(parsedOutput) },
  };
}

export function buildPendingPromptStepCompletion(
  step: Extract<AgentStep, { kind: 'prompt' }>,
  finalResponse: string,
): PendingStepCompletion {
  return { stepId: step.id, finalResponse };
}

export function applyPendingStepCompletion(
  pendingStep: PendingStepCompletion,
  completedStepIds: string[],
  outputs: AgentSequenceResult['outputs'],
  fallbackFinalResponse: string | undefined,
): { finalResponse: string } {
  if (pendingStep.output) {
    outputs[pendingStep.output.resultKey] = structuredClone(pendingStep.output.parsedOutput);
  }

  if (!completedStepIds.includes(pendingStep.stepId)) {
    completedStepIds.push(pendingStep.stepId);
  }

  return { finalResponse: pendingStep.finalResponse ?? fallbackFinalResponse ?? '' };
}

export function assertCheckpointMatchesStepSequence(checkpoint: AgentCheckpoint, steps: AgentStep[]): void {
  const validStepIds = new Set(steps.map((step) => step.id));
  const staleCompletedStepIds = (checkpoint.completedStepIds ?? []).filter((stepId) => !validStepIds.has(stepId));
  if (staleCompletedStepIds.length > 0) {
    throw new Error(
      `Heartbeat checkpoint contains stale completed step ids that do not exist in the current agent sequence: ${staleCompletedStepIds.join(', ')}`,
    );
  }

  if (checkpoint.pendingStep && !validStepIds.has(checkpoint.pendingStep.stepId)) {
    throw new Error(
      `Heartbeat checkpoint contains a stale pending step id that does not exist in the current agent sequence: ${checkpoint.pendingStep.stepId}`,
    );
  }
}

export function cloneAgentOutputs(outputs: AgentSequenceResult['outputs']): AgentSequenceResult['outputs'] {
  return structuredClone(outputs);
}

function parsePendingStepCompletion(value: unknown): PendingStepCompletion | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const pendingStep = value as Partial<PendingStepCompletion>;
  if (typeof pendingStep.stepId !== 'string' || typeof pendingStep.finalResponse !== 'string') {
    return undefined;
  }

  const output = parsePendingStepOutput(pendingStep.output);
  if (pendingStep.output && !output) {
    return undefined;
  }

  return clonePendingStepCompletion({ stepId: pendingStep.stepId, finalResponse: pendingStep.finalResponse, output });
}

function parseLegacyPendingStructuredStepCompletion(value: unknown): PendingStepCompletion | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const pendingStructuredStep = value as { stepId?: unknown; resultKey?: unknown; parsedOutput?: unknown; finalResponse?: unknown };
  if (
    typeof pendingStructuredStep.stepId !== 'string' ||
    !isAgentOutputKey(pendingStructuredStep.resultKey) ||
    typeof pendingStructuredStep.finalResponse !== 'string'
  ) {
    return undefined;
  }

  return {
    stepId: pendingStructuredStep.stepId,
    finalResponse: pendingStructuredStep.finalResponse,
    output: {
      resultKey: pendingStructuredStep.resultKey,
      parsedOutput: structuredClone(pendingStructuredStep.parsedOutput),
    },
  };
}

function parsePendingStepOutput(value: unknown): PendingStepCompletion['output'] | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const output = value as { resultKey?: unknown; parsedOutput?: unknown };
  if (!isAgentOutputKey(output.resultKey)) {
    return undefined;
  }

  return { resultKey: output.resultKey, parsedOutput: structuredClone(output.parsedOutput) };
}

function clonePendingStepCompletion(pendingStep: PendingStepCompletion): PendingStepCompletion {
  return {
    stepId: pendingStep.stepId,
    finalResponse: truncateCheckpointFinalResponse(pendingStep.finalResponse),
    ...(pendingStep.output
      ? {
          output: {
            resultKey: pendingStep.output.resultKey,
            parsedOutput: structuredClone(pendingStep.output.parsedOutput),
          },
        }
      : {}),
  };
}

function parseCompletedStepIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((stepId): stepId is string => typeof stepId === 'string');
}

function truncateCheckpointFinalResponse(finalResponse: string): string {
  if (Buffer.byteLength(finalResponse, 'utf8') <= MAX_CHECKPOINT_FINAL_RESPONSE_BYTES) {
    return finalResponse;
  }

  const suffixBytes = Buffer.byteLength(CHECKPOINT_TRUNCATION_SUFFIX, 'utf8');
  const contentBudget = MAX_CHECKPOINT_FINAL_RESPONSE_BYTES - suffixBytes;
  if (contentBudget <= 0) {
    return CHECKPOINT_TRUNCATION_SUFFIX;
  }

  let low = 0;
  let high = finalResponse.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(finalResponse.slice(0, mid), 'utf8') <= contentBudget) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  return `${finalResponse.slice(0, low)}${CHECKPOINT_TRUNCATION_SUFFIX}`;
}

function isAgentOutputKey(value: unknown): value is AgentOutputKey {
  return typeof value === 'string' && (AGENT_OUTPUT_KEYS as readonly string[]).includes(value);
}