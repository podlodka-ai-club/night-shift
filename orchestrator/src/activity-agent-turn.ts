import { createCheckpointSnapshot, type AgentCheckpoint } from './activity-agent-checkpoint';
import { type AgentActivityDeps, type AgentProgressEvent, type AgentSession, type AgentTurnOptions, type AgentTurnResult, toErrorMessage } from './activity-deps';

const AGENT_TURN_HEARTBEAT_INTERVAL_MS = 10_000;
const MAX_REPAIR_PROMPT_ORIGINAL_PROMPT_BYTES = 8 * 1024;
const MAX_REPAIR_PROMPT_INVALID_OUTPUT_BYTES = 16 * 1024;
const REPAIR_PROMPT_ORIGINAL_PROMPT_TRUNCATION_SUFFIX = '\n...[truncated original prompt for repair prompt]';
const REPAIR_PROMPT_TRUNCATION_SUFFIX = '\n...[truncated invalid response for repair prompt]';

export interface StructuredTurnContract<TParsedOutput> {
  jsonSchema?: unknown;
  parse: (value: unknown) => TParsedOutput;
}

export interface RunStructuredAgentTurnInput<TParsedOutput> {
  stepId: string;
  prompt: string;
  contract: StructuredTurnContract<TParsedOutput>;
  getCheckpointDetails: () => AgentCheckpoint;
  onEvent?: (event: AgentProgressEvent) => void;
}

export class AgentContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentContractError';
  }
}

export async function runAgentTurnWithHeartbeat(
  deps: Pick<AgentActivityDeps, 'heartbeat'>,
  session: AgentSession,
  prompt: string,
  options: AgentTurnOptions | undefined,
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
    const turn = await session.run(prompt, options);
    if (intervalError) {
      throw intervalError;
    }

    forwardFallbackTurnEvents(turn, options);

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

function forwardFallbackTurnEvents(turn: AgentTurnResult, options: AgentTurnOptions | undefined): void {
  if (!options?.onEvent || Array.isArray(turn.events)) {
    return;
  }

  const rawTurn = turn as AgentTurnResult & { items?: unknown; usage?: unknown };
  if (Array.isArray(rawTurn.items)) {
    for (const item of rawTurn.items) {
      options.onEvent({ type: 'provider-item', payload: item });
    }
  }

  if (rawTurn.usage !== undefined && rawTurn.usage !== null) {
    options.onEvent({ type: 'usage', payload: rawTurn.usage });
  }
}

export async function runStructuredAgentTurn<TParsedOutput>(
  deps: Pick<AgentActivityDeps, 'heartbeat' | 'getCancellationSignal'>,
  session: AgentSession,
  input: RunStructuredAgentTurnInput<TParsedOutput>,
): Promise<{ finalResponse: string; parsedOutput: TParsedOutput }> {
  const turnOptions = buildTurnOptions(deps, {
    outputSchema: input.contract.jsonSchema,
    onEvent: input.onEvent,
  });

  const firstTurn = await runAgentTurnWithHeartbeat(
    deps,
    session,
    input.prompt,
    turnOptions,
    input.getCheckpointDetails,
  );
  const firstParsed = parseStructuredOutput(firstTurn.finalResponse, input.contract.parse);
  if (firstParsed.success) {
    return { finalResponse: firstTurn.finalResponse, parsedOutput: firstParsed.parsedOutput };
  }

  const repairTurn = await runAgentTurnWithHeartbeat(
    deps,
    session,
    buildStructuredOutputRepairPrompt(input.prompt, firstTurn.finalResponse, firstParsed.errorMessage),
    turnOptions,
    input.getCheckpointDetails,
  );
  const repairParsed = parseStructuredOutput(repairTurn.finalResponse, input.contract.parse);
  if (!repairParsed.success) {
    throw new AgentContractError(
      [
        `Structured output step ${input.stepId} did not satisfy schema.`,
        `Initial parse failed: ${firstParsed.errorMessage}`,
        `Repair parse failed: ${repairParsed.errorMessage}`,
      ].join(' '),
    );
  }

  return { finalResponse: repairTurn.finalResponse, parsedOutput: repairParsed.parsedOutput };
}

function buildTurnOptions(
  deps: Pick<AgentActivityDeps, 'getCancellationSignal'>,
  options: { outputSchema?: unknown; onEvent?: (event: AgentProgressEvent) => void },
): AgentTurnOptions {
  const signal = deps.getCancellationSignal();
  return {
    ...options,
    ...(signal ? { signal } : {}),
  };
}

function parseStructuredOutput<TParsedOutput>(
  finalResponse: string,
  parse: (value: unknown) => TParsedOutput,
): { success: true; parsedOutput: TParsedOutput } | { success: false; errorMessage: string } {
  let parsedJson: unknown;

  try {
    parsedJson = JSON.parse(finalResponse);
  } catch (error) {
    return { success: false, errorMessage: `Response was not valid JSON: ${toErrorMessage(error)}` };
  }

  try {
    return { success: true, parsedOutput: parse(parsedJson) };
  } catch (error) {
    return { success: false, errorMessage: `Response did not match the expected schema: ${toErrorMessage(error)}` };
  }
}

function buildStructuredOutputRepairPrompt(prompt: string, invalidOutput: string, parseError: string): string {
  return [
    truncateRepairPromptOriginalPrompt(prompt),
    '',
    'The previous response did not satisfy the required structured output schema.',
    parseError,
    'Reply again using only data that conforms to the required schema.',
    '',
    'Previous invalid response:',
    truncateRepairPromptInvalidOutput(invalidOutput),
  ].join('\n');
}

function truncateRepairPromptOriginalPrompt(value: string): string {
  return truncateRepairPromptSection(value, MAX_REPAIR_PROMPT_ORIGINAL_PROMPT_BYTES, REPAIR_PROMPT_ORIGINAL_PROMPT_TRUNCATION_SUFFIX);
}

function truncateRepairPromptInvalidOutput(value: string): string {
  return truncateRepairPromptSection(value, MAX_REPAIR_PROMPT_INVALID_OUTPUT_BYTES, REPAIR_PROMPT_TRUNCATION_SUFFIX);
}

function truncateRepairPromptSection(value: string, maxBytes: number, suffix: string): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) {
    return value;
  }

  const suffixBytes = Buffer.byteLength(suffix, 'utf8');
  const contentBudget = maxBytes - suffixBytes;
  if (contentBudget <= 0) {
    return suffix;
  }

  let low = 0;
  let high = value.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, mid), 'utf8') <= contentBudget) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  return `${value.slice(0, low)}${suffix}`;
}