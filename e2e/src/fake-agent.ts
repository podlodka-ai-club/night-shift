import path from 'node:path';
import type { AgentActivityDeps, AgentSession, AgentTurnOptions, AgentTurnResult } from '../../orchestrator/lib/activity-deps';

export const FAKE_AGENT_FILE_PATH = 'e2e/fake-agent-output.md';
const FAKE_AGENT_REVIEW_STATE_PATH = '.orchestrator-fake-agent-review-attempt';

type FakeEscalationOriginPhase = 'specify' | 'implement' | 'review';

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

export function buildFakeAgentReviewResponse(runMarker: string, attempt = 1) {
  if (attempt === 1) {
    return {
      summary: `Review requires one deterministic rerun for ${runMarker}.`,
      findings: [
        {
          severity: 'error',
          message: `Run marker ${runMarker} intentionally triggers one review rerun before ready-to-merge.`,
          location: { file: FAKE_AGENT_FILE_PATH, line: 3 },
        },
      ],
    };
  }

  return {
    summary: `Review looks good for ${runMarker} after one rerun.`,
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

export function buildFakeAgentSpecifyEscalationResponse(runMarker: string) {
  return {
    outcome: 'resolved',
    originPhase: 'specify',
    confidence: 'high',
    rootCause: {
      category: 'missing_spec_context',
      summary: `Escalation restored the deterministic spec bundle for ${runMarker}.`,
      evidence: [`Run marker ${runMarker} requested deterministic spec recovery.`],
    },
    resolution: {
      summary: `Rewrite the spec bundle for ${runMarker} and rerun Specify.`,
      files: buildFakeAgentSpecifyResponse().files,
      commitMessage: `test: fake escalation spec recovery for ${runMarker}`,
      validationPlan: ['Run openspec validation'],
      resumeStatus: 'Backlog',
    },
    issueComment: `Escalation Manager restored the deterministic spec bundle for ${runMarker}.`,
  };
}

export function buildFakeAgentImplementEscalationResponse(runMarker: string) {
  return {
    outcome: 'resolved',
    originPhase: 'implement',
    confidence: 'high',
    rootCause: {
      category: 'quality_gate_failure',
      summary: `Escalation repaired the deterministic implement output for ${runMarker}.`,
      evidence: [`Run marker ${runMarker} requested deterministic implement recovery.`],
    },
    resolution: {
      summary: `Rewrite the deterministic repository change for ${runMarker} and rerun Implement.`,
      files: [{ path: FAKE_AGENT_FILE_PATH, content: buildFakeAgentFileText(`${runMarker} (escalation)`) }],
      commitMessage: `test: fake escalation recovery for ${runMarker}`,
      validationPlan: ['Run make check'],
      resumeStatus: 'Ready',
    },
    issueComment: `Escalation Manager repaired the deterministic implementation output for ${runMarker}.`,
  };
}

export function buildFakeAgentReviewOnlyEscalationResponse(runMarker: string) {
  return {
    outcome: 'resolved',
    originPhase: 'review',
    confidence: 'medium',
    rootCause: {
      category: 'review_findings',
      summary: `Escalation resolved stale review context for ${runMarker}.`,
      evidence: [`Run marker ${runMarker} requested a review-only recovery.`],
    },
    resolution: {
      summary: `Refresh review context for ${runMarker} without changing repository files.`,
      files: [],
      validationPlan: ['Refresh PR metadata'],
      resumeStatus: 'In review',
    },
    issueComment: `Escalation Manager resolved stale review context for ${runMarker}.`,
  };
}

export function buildFakeAgentHumanEscalationResponse(runMarker: string, originPhase: FakeEscalationOriginPhase = 'implement') {
  const recommendedStatusAfterAnswer = originPhase === 'specify' ? 'Backlog' : originPhase === 'review' ? 'In review' : 'Ready';
  return {
    outcome: 'needs_human',
    originPhase,
    confidence: 'low',
    rootCause: {
      category: 'ambiguous_requirement',
      summary: `Escalation requires human input for ${runMarker}.`,
      evidence: [`Run marker ${runMarker} explicitly requested a human fallback.`],
    },
    resolution: {
      summary: 'No safe automated repair was applied.',
      files: [],
      validationPlan: [],
      resumeStatus: recommendedStatusAfterAnswer,
    },
    humanRequest: {
      question: `A human must decide how ${runMarker} should proceed.`,
      recommendedStatusAfterAnswer,
    },
    issueComment: `Escalation Manager needs human input for ${runMarker}.`,
  };
}

function buildFakeAgentProgressEvents(...messages: string[]): AgentTurnResult['events'] {
  return messages.map((message) => ({
    type: 'provider-item',
    payload: { type: 'message.delta', text: message },
  }));
}

function buildFakeAgentTurnResult(finalResponse: string, ...messages: string[]): AgentTurnResult {
  return {
    events: buildFakeAgentProgressEvents(...messages),
    finalResponse,
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
    createClaudeSession: (worktreePath) => {
      const state = createThreadState(`fake-thread-${nextThreadId++}`, worktreePath);
      threads.set(state.id, state);
      return createThread(baseDeps, state);
    },
    resumeClaudeSession: (worktreePath, threadId) => {
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
    run: async (prompt, options) => {
      const result = await runFakeTurn(baseDeps, state, prompt, options);
      for (const event of result.events ?? []) {
        options?.onEvent?.(event);
      }
      return result;
    },
  };
}

async function runFakeTurn(
  baseDeps: AgentActivityDeps,
  state: FakeAgentThreadState,
  prompt: string,
  options?: AgentTurnOptions,
): Promise<AgentTurnResult> {
  state.turnCount += 1;
  const isStructuredTurn = options?.outputSchema !== undefined;
  const promptMarker = extractRunMarker(prompt);
  if (promptMarker) {
    state.runMarker = promptMarker;
  }

  if (state.turnCount === 1) {
    if (isStructuredTurn && prompt.includes('You are the Escalation Manager')) {
      const originPhase = extractEscalationOriginPhase(prompt);
      const escalationResponse = buildFakeEscalationResponse(state.runMarker, originPhase);
      return buildFakeAgentTurnResult(
        JSON.stringify(escalationResponse),
        `Triaging the escalation context for ${state.runMarker}.`,
        originPhase === 'review'
          ? 'Preparing deterministic fake review-only escalation output.'
          : escalationResponse.outcome === 'needs_human'
            ? 'Preparing deterministic fake human-fallback escalation output.'
            : 'Preparing deterministic fake escalation recovery output.',
      );
    }

    if (isStructuredTurn && prompt.includes('OpenSpec proposal')) {
      return buildFakeAgentTurnResult(
        JSON.stringify(buildFakeAgentSpecifyResponse()),
        'Reviewing issue context and drafting the OpenSpec bundle.',
        'Preparing deterministic fake Specify output.',
      );
    }

    if (isStructuredTurn && prompt.includes('## PR Diff')) {
      const reviewAttempt = await nextFakeReviewAttempt(baseDeps, state.worktreePath);
      return buildFakeAgentTurnResult(
        JSON.stringify(buildFakeAgentReviewResponse(state.runMarker, reviewAttempt)),
        `Inspecting the pull request diff for ${state.runMarker}.`,
        'Preparing deterministic fake review verdict.',
      );
    }

    if (isStructuredTurn) {
      return buildFakeAgentTurnResult(
        JSON.stringify(buildFakeAgentImplementResponse(state.runMarker)),
        `Inspecting the approved spec bundle for ${state.runMarker}.`,
        'Preparing deterministic fake implementation output.',
      );
    }

    await writeDeterministicChange(baseDeps, state.worktreePath, state.runMarker);
    return buildFakeAgentTurnResult(
      `Fake agent applied deterministic repository change for ${state.runMarker}.`,
      `Applying deterministic repository change for ${state.runMarker}.`,
    );
  }

  if (isStructuredTurn) {
    return buildFakeAgentTurnResult(
      JSON.stringify({
        commitMessage: `test: fake e2e change for ${state.runMarker}`,
        pullRequestTitle: `test: fake e2e PR for ${state.runMarker}`,
        pullRequestBody: `## Summary\n- create the deterministic fake e2e change\n- run marker: ${state.runMarker}`,
      }),
      `Revisiting deterministic fake implementation output for ${state.runMarker}.`,
      'Preparing follow-up metadata for the fake pull request.',
    );
  }

  return buildFakeAgentTurnResult(
    `Fake agent completed prompt step for ${state.runMarker}.`,
    `Completing deterministic prompt step for ${state.runMarker}.`,
  );
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

async function nextFakeReviewAttempt(baseDeps: AgentActivityDeps, worktreePath: string): Promise<number> {
  const statePath = path.join(worktreePath, FAKE_AGENT_REVIEW_STATE_PATH);
  const currentAttempt = await readFakeReviewAttempt(baseDeps, statePath);
  const nextAttempt = currentAttempt + 1;
  await baseDeps.writeFile(statePath, String(nextAttempt), 'utf8');
  return nextAttempt;
}

async function readFakeReviewAttempt(baseDeps: AgentActivityDeps, statePath: string): Promise<number> {
  try {
    const rawValue = await baseDeps.readFile(statePath, 'utf8');
    const parsedValue = Number.parseInt(rawValue, 10);
    return Number.isFinite(parsedValue) ? parsedValue : 0;
  } catch {
    return 0;
  }
}

function buildFakeEscalationResponse(runMarker: string, originPhase: FakeEscalationOriginPhase): ReturnType<typeof buildFakeAgentImplementEscalationResponse> | ReturnType<typeof buildFakeAgentReviewOnlyEscalationResponse> | ReturnType<typeof buildFakeAgentHumanEscalationResponse> | ReturnType<typeof buildFakeAgentSpecifyEscalationResponse> {
  if (runMarker.toLowerCase().includes('needs-human')) {
    return buildFakeAgentHumanEscalationResponse(runMarker, originPhase);
  }

  if (originPhase === 'review') {
    return buildFakeAgentReviewOnlyEscalationResponse(runMarker);
  }

  if (originPhase === 'specify') {
    return buildFakeAgentSpecifyEscalationResponse(runMarker);
  }

  return buildFakeAgentImplementEscalationResponse(runMarker);
}

function extractEscalationOriginPhase(prompt: string): FakeEscalationOriginPhase {
  const match = prompt.match(/Origin phase:\s*(specify|implement|review)/i);
  const value = match?.[1]?.toLowerCase();
  if (value === 'specify' || value === 'review') {
    return value;
  }
  return 'implement';
}