import path from 'node:path';
import { createActivityDependencies } from '../src/activities';
import type { AgentProgressEvent } from '../src/activity-deps';
import { createProviderAgentAdapter } from '../src/activity-deps';
import { DEFAULT_AGENT_MODEL_BY_PROVIDER } from '../src/agent-provider';
import { renderProviderItemTrace } from '../src/smoke-support';

const WORKTREE_PATH = path.resolve(__dirname, '..');

async function main(): Promise<void> {
  if (!process.env.OPENAI_API_KEY) {
    console.error('OPENAI_API_KEY is not set');
    process.exit(1);
  }

  const model = process.env.SMOKE_MODEL ?? DEFAULT_AGENT_MODEL_BY_PROVIDER.codex;
  const session = createProviderAgentAdapter({ provider: 'codex', config: { model } }, createActivityDependencies()).createSession(WORKTREE_PATH);

  console.log(`===== Codex (${model}) =====`);
  console.log('worktree:', WORKTREE_PATH);
  console.log('session.id (before first turn):', session.id);

  console.log('>>> run() one-shot');
  const firstStartedAt = Date.now();
  const firstTurn = await session.run('Reply with exactly: pong', {
    systemPrompt: 'You are a terse smoke-test assistant. Answer in 5 words or fewer.',
  });
  const firstWallMs = Date.now() - firstStartedAt;
  console.log('finalText:', JSON.stringify(firstTurn.finalResponse));
  console.log('usage:', firstTurn.usage);
  console.log('costMicroUsd:', firstTurn.costMicroUsd);
  console.log('wallMs:', firstWallMs);
  console.log('session.id:', session.id);

  const secondTurnEvents: AgentProgressEvent[] = [];
  console.log('\n>>> run() resume with provider-item trace');
  const secondStartedAt = Date.now();
  const secondTurn = await session.run('Now reply with exactly: ack', {
    systemPrompt: 'You are a terse smoke-test assistant. Answer in 5 words or fewer.',
    onEvent: (event) => secondTurnEvents.push(event),
  });
  const secondWallMs = Date.now() - secondStartedAt;
  const traceLines = renderProviderItemTrace(secondTurnEvents);
  for (const line of traceLines) {
    console.log(line);
  }
  console.log('[done]', JSON.stringify(secondTurn.finalResponse));
  console.log('[turn-completed] costMicroUsd:', secondTurn.costMicroUsd, 'usage:', secondTurn.usage, 'wallMs:', secondWallMs);
  console.log('session.id (after resume):', session.id);

  if (traceLines.length === 0) {
    throw new Error('Codex smoke expected provider-item trace output on the resume turn.');
  }
}

main().catch((error) => {
  console.error('smoke failed:', error);
  process.exit(1);
});