import path from 'node:path';
import { createActivityDependencies } from '../src/activities';
import type { AgentProgressEvent } from '../src/activity-deps';
import { createProviderAgentAdapter } from '../src/activity-deps';
import { DEFAULT_AGENT_MODEL_BY_PROVIDER } from '../src/agent-provider';
import { renderProviderItemTrace, summarizeProviderStreamActivity } from '../src/smoke-support';

const WORKTREE_PATH = path.resolve(__dirname, '..');

// Current main intentionally exposes `session.run()` plus `onEvent` instead of
// a separate `runStreamed()` API. This smoke validates the donor-equivalent
// streamed provider-item path through that stable seam without inventing a new
// runtime contract.

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY is not set');
    process.exit(1);
  }

  const model = process.env.SMOKE_MODEL ?? DEFAULT_AGENT_MODEL_BY_PROVIDER.claude;
  const session = createProviderAgentAdapter({ provider: 'claude', model }, createActivityDependencies()).createSession(WORKTREE_PATH);

  console.log(`===== Claude (${model}) =====`);
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
  const secondTurnStream = summarizeProviderStreamActivity(secondTurnEvents);
  for (const line of renderProviderItemTrace(secondTurnEvents)) {
    console.log(line);
  }
  console.log('[done]', JSON.stringify(secondTurn.finalResponse));
  console.log('[turn-completed] costMicroUsd:', secondTurn.costMicroUsd, 'usage:', secondTurn.usage, 'wallMs:', secondWallMs);
  console.log('providerItemTypes:', secondTurnStream.providerItemTypes);
  console.log('assistantMessageCount:', secondTurnStream.assistantMessageCount);
  console.log('resultMessageCount:', secondTurnStream.resultMessageCount);
  console.log('session.id (after resume):', session.id);

  if (secondTurnStream.totalProviderItems === 0
    || secondTurnStream.assistantMessageCount === 0
    || secondTurnStream.resultMessageCount === 0) {
    throw new Error('Claude smoke expected provider-item traces for assistant and result events via onEvent.');
  }
}

main().catch((error) => {
  console.error('smoke failed:', error);
  process.exit(1);
});