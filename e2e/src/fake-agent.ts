import path from 'node:path';
import type { AgentActivityDeps, AgentThread, AgentTurnResult } from '../../orchestrator/lib/activity-deps';

export const FAKE_AGENT_FILE_PATH = 'e2e/fake-agent-output.md';

interface FakeAgentThreadState {
  id: string;
  worktreePath: string;
  runMarker: string;
  turnCount: number;
}

export function createFakeAgentDeps(baseDeps: AgentActivityDeps): AgentActivityDeps {
  const threads = new Map<string, FakeAgentThreadState>();
  let nextThreadId = 1;

  return {
    ...baseDeps,
    createCodexThread: (worktreePath) => {
      const state = createThreadState(`fake-thread-${nextThreadId++}`, worktreePath);
      threads.set(state.id, state);
      return createThread(baseDeps, state);
    },
    resumeCodexThread: (worktreePath, threadId) => {
      const state = threads.get(threadId) ?? createThreadState(threadId, worktreePath);
      threads.set(state.id, state);
      return createThread(baseDeps, state);
    },
  };
}

function createThreadState(id: string, worktreePath: string): FakeAgentThreadState {
  return { id, worktreePath, runMarker: 'unknown', turnCount: 0 };
}

function createThread(baseDeps: AgentActivityDeps, state: FakeAgentThreadState): AgentThread {
  return {
    id: state.id,
    run: async (prompt, options) => runFakeTurn(baseDeps, state, prompt, options),
  };
}

async function runFakeTurn(
  baseDeps: AgentActivityDeps,
  state: FakeAgentThreadState,
  prompt: string,
  options?: { outputSchema?: unknown; signal?: AbortSignal },
): Promise<AgentTurnResult> {
  state.turnCount += 1;
  const promptMarker = extractRunMarker(prompt);
  if (promptMarker) {
    state.runMarker = promptMarker;
  }

  if (state.turnCount === 1) {
    await writeDeterministicChange(baseDeps, state.worktreePath, state.runMarker);
    return {
      finalResponse: `Fake agent applied deterministic repository change for ${state.runMarker}.`,
    };
  }

  if (options?.outputSchema) {
    return {
      finalResponse: JSON.stringify({
        commitMessage: `test: fake e2e change for ${state.runMarker}`,
        pullRequestTitle: `test: fake e2e PR for ${state.runMarker}`,
        pullRequestBody: `## Summary\n- create the deterministic fake e2e change\n- run marker: ${state.runMarker}`,
      }),
    };
  }

  return {
    finalResponse: `Fake agent completed prompt step for ${state.runMarker}.`,
  };
}

async function writeDeterministicChange(
  baseDeps: AgentActivityDeps,
  worktreePath: string,
  runMarker: string,
): Promise<void> {
  const absoluteFilePath = path.join(worktreePath, FAKE_AGENT_FILE_PATH);
  await baseDeps.mkdir(path.dirname(absoluteFilePath), { recursive: true });
  await baseDeps.writeFile(
    absoluteFilePath,
    ['# Fake E2E Change', '', `Run marker: ${runMarker}`].join('\n'),
    'utf8',
  );
}

function extractRunMarker(prompt: string): string | undefined {
  const match = prompt.match(/E2E_RUN_MARKER:\s*([^\n\r]+)/);
  return match?.[1]?.trim();
}