import type { AgentProgressEvent } from './activity-deps';

export interface ToolActivitySummary {
  totalProviderItems: number;
  providerItemTypes: string[];
  toolUseCount: number;
  toolResultCount: number;
}

export interface ProviderStreamActivitySummary {
  totalProviderItems: number;
  providerItemTypes: string[];
  assistantMessageCount: number;
  resultMessageCount: number;
  assistantTextSnapshots: string[];
}

export interface OutputSchemaSmokePayload {
  answer: string;
  letters: string[];
  count: number;
}

export function summarizeToolActivity(events: readonly AgentProgressEvent[]): ToolActivitySummary {
  const providerItemTypes: string[] = [];
  let totalProviderItems = 0;
  let toolUseCount = 0;
  let toolResultCount = 0;

  for (const event of events) {
    if (event.type !== 'provider-item') {
      continue;
    }

    totalProviderItems += 1;
    const itemType = readProviderItemType(event.payload);
    if (itemType && !providerItemTypes.includes(itemType)) {
      providerItemTypes.push(itemType);
    }

    const marker = classifyToolProviderItem(event.payload);
    toolUseCount += marker.toolUseCount;
    toolResultCount += marker.toolResultCount;
  }

  return { totalProviderItems, providerItemTypes, toolUseCount, toolResultCount };
}

export function summarizeProviderStreamActivity(events: readonly AgentProgressEvent[]): ProviderStreamActivitySummary {
  const providerItemTypes: string[] = [];
  const assistantTextSnapshots: string[] = [];
  let totalProviderItems = 0;
  let assistantMessageCount = 0;
  let resultMessageCount = 0;

  for (const event of events) {
    if (event.type !== 'provider-item') {
      continue;
    }

    totalProviderItems += 1;
    const itemType = readProviderItemType(event.payload);
    if (itemType && !providerItemTypes.includes(itemType)) {
      providerItemTypes.push(itemType);
    }
    if (!isRecord(event.payload)) {
      continue;
    }
    if (itemType === 'assistant') {
      assistantMessageCount += 1;
      const snapshot = extractAssistantTextSnapshot(event.payload);
      if (snapshot) {
        assistantTextSnapshots.push(snapshot);
      }
    }
    if (itemType === 'result') {
      resultMessageCount += 1;
    }
  }

  return {
    totalProviderItems,
    providerItemTypes,
    assistantMessageCount,
    resultMessageCount,
    assistantTextSnapshots,
  };
}

export function validateOutputSchemaSmokeText(
  raw: string,
): { ok: true; payload: OutputSchemaSmokePayload } | { ok: false; reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { ok: false, reason: `not valid JSON: ${(error as Error).message}` };
  }
  return validateOutputSchemaSmokeValue(parsed);
}

export function validateOutputSchemaSmokeValue(
  parsed: unknown,
): { ok: true; payload: OutputSchemaSmokePayload } | { ok: false; reason: string } {
  if (!isRecord(parsed)) {
    return { ok: false, reason: 'top-level is not an object' };
  }
  if (typeof parsed.answer !== 'string') {
    return { ok: false, reason: 'missing/invalid answer' };
  }
  if (!Array.isArray(parsed.letters) || !parsed.letters.every((value) => typeof value === 'string')) {
    return { ok: false, reason: 'missing/invalid letters' };
  }
  if (!Number.isInteger(parsed.count)) {
    return { ok: false, reason: 'missing/invalid count' };
  }
  return {
    ok: true,
    payload: {
      answer: parsed.answer,
      letters: parsed.letters,
      count: parsed.count,
    },
  };
}

function classifyToolProviderItem(value: unknown): { toolUseCount: number; toolResultCount: number } {
  if (!isRecord(value)) {
    return { toolUseCount: 0, toolResultCount: 0 };
  }

  const type = readProviderItemType(value);
  if (!type) {
    return { toolUseCount: 0, toolResultCount: 0 };
  }
  if (type === 'mcp_tool_call') {
    const status = typeof value.status === 'string' ? value.status : undefined;
    return {
      toolUseCount: 1,
      toolResultCount: status === 'completed' || status === 'failed' || value.result !== undefined || value.error !== undefined ? 1 : 0,
    };
  }
  if (type === 'tool_progress') {
    return { toolUseCount: 1, toolResultCount: 0 };
  }
  if (type === 'tool_use_summary' || type === 'tool_result') {
    return { toolUseCount: 0, toolResultCount: 1 };
  }
  if (type === 'user' && value.tool_use_result !== undefined) {
    return { toolUseCount: 0, toolResultCount: 1 };
  }
  if (!type.includes('tool')) {
    return { toolUseCount: 0, toolResultCount: 0 };
  }
  return {
    toolUseCount: 1,
    toolResultCount: type.includes('result') || type.includes('summary') ? 1 : 0,
  };
}

function readProviderItemType(value: unknown): string | undefined {
  return isRecord(value) && typeof value.type === 'string' ? value.type : undefined;
}

function extractAssistantTextSnapshot(value: Record<string, any>): string {
  const blocks = isRecord(value.message) && Array.isArray(value.message.content)
    ? value.message.content
    : [];
  let text = '';
  for (const block of blocks) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') {
      text += block.text;
    }
  }
  return text;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null;
}