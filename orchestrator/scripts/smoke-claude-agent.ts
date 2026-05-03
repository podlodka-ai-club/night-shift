import path from 'node:path';
import { createActivityDependencies } from '../src/activities';
import { createProviderAgentAdapter } from '../src/activity-deps';
import { DEFAULT_AGENT_MODEL_BY_PROVIDER } from '../src/agent-provider';

const WORKTREE_PATH = path.resolve(__dirname, '..');

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

  const firstTurn = await session.run('Reply with exactly: pong', {
    systemPrompt: 'You are a terse smoke-test assistant. Answer in 5 words or fewer.',
  });
  console.log('first.finalResponse:', JSON.stringify(firstTurn.finalResponse));
  console.log('first.usage:', firstTurn.usage);
  console.log('first.costMicroUsd:', firstTurn.costMicroUsd);
  console.log('session.id (after first turn):', session.id);

  const secondTurn = await session.run('Now reply with exactly: ack', {
    systemPrompt: 'You are a terse smoke-test assistant. Answer in 5 words or fewer.',
  });
  console.log('second.finalResponse:', JSON.stringify(secondTurn.finalResponse));
  console.log('second.usage:', secondTurn.usage);
  console.log('second.costMicroUsd:', secondTurn.costMicroUsd);
  console.log('session.id (after resume):', session.id);
}

main().catch((error) => {
  console.error('smoke failed:', error);
  process.exit(1);
});