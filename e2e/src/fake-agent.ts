import path from 'node:path';
import type { AgentActivityDeps, AgentSession, AgentTurnOptions, AgentTurnResult } from '../../orchestrator/lib/activity-deps';

export const FAKE_AGENT_FILE_PATH = 'e2e/fake-agent-output.md';

export function buildFakeAgentFileText(runMarker: string): string {
  return ['# Fake E2E Change', '', `Run marker: ${runMarker}`].join('\n');
}

export function buildFakeAgentImplementResponse(runMarker: string) {
  return {
    filesWritten: [{ path: FAKE_AGENT_FILE_PATH, content: buildFakeAgentFileText(runMarker) }],
    commitMessage: `test: fake e2e change for ${runMarker}`,
    summary: `Deterministic fake e2e change for ${runMarker}.`,
    followUps: [`Run marker: ${runMarker}`],
  };
}

export function buildFakeAgentReviewResponse(runMarker: string) {
  return {
    summary: `Review looks good for ${runMarker}.`,
    findings: [
      {
        severity: 'warning',
        message: `Run marker ${runMarker} is embedded in the fake E2E artifact for traceability.`,
        location: { file: FAKE_AGENT_FILE_PATH, line: 3 },
      },
    ],
  };
}

export function buildFakeAgentSpecifyResponse() {
  return {
    files: [
      { path: 'proposal.md', content: '# Proposal\n\n## Why\n- Support deterministic phases in the live fake-agent harness.' },
      { path: 'tasks.md', content: '# Tasks\n\n- [ ] Review and approve the proposed spec.' },
      { path: 'specs/e2e/spec.md', content: '## ADDED Requirements\n### Requirement: Fake agent e2e validation\nThe fake-agent e2e path MUST prove the implement phase can execute from an approved spec bundle.' },
    ],
    openQuestions: [],
    assumptions: [],
    risks: [],
  };
}

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

function createThread(baseDeps: AgentActivityDeps, state: FakeAgentThreadState): AgentSession {
  return {
    id: state.id,
    run: async (prompt, options) => runFakeTurn(baseDeps, state, prompt, options),
  };
}

async function runFakeTurn(
  baseDeps: AgentActivityDeps,
  state: FakeAgentThreadState,
  prompt: string,
  options?: AgentTurnOptions,
): Promise<AgentTurnResult> {
  state.turnCount += 1;
  const promptMarker = extractRunMarker(prompt);
  if (promptMarker) {
    state.runMarker = promptMarker;
  }

  if (state.turnCount === 1) {
    if (options?.outputSchema && prompt.includes('OpenSpec proposal')) {
      return {
        finalResponse: JSON.stringify(buildFakeAgentSpecifyResponse()),
      };
    }

    if (options?.outputSchema && prompt.includes('## PR Diff')) {
      return {
        finalResponse: JSON.stringify(buildFakeAgentReviewResponse(state.runMarker)),
      };
    }

    if (options?.outputSchema) {
      return {
        finalResponse: JSON.stringify(buildFakeAgentImplementResponse(state.runMarker)),
      };
    }

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
  await baseDeps.writeFile(absoluteFilePath, buildFakeAgentFileText(runMarker), 'utf8');
}

function extractRunMarker(prompt: string): string | undefined {
  const match = prompt.match(/E2E_RUN_MARKER:\s*([^\n\r]+)/);
  return match?.[1]?.trim();
}