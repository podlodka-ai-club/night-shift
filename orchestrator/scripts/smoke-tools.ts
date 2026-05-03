import path from 'node:path';
import { createActivityDependencies } from '../src/activities';
import { createProviderAgentAdapter, type AgentProgressEvent } from '../src/activity-deps';
import { DEFAULT_AGENT_MODEL_BY_PROVIDER, type AgentProvider } from '../src/agent-provider';
import { renderProviderItemTrace, summarizeToolActivity } from '../src/smoke-support';

const WORKTREE_PATH = path.resolve(__dirname, '..');
const PROMPT = 'Use a shell or read tool to count exactly how many .ts files exist in the scripts/ directory of the current working directory. Then respond with that number, nothing else.';

async function runOne(provider: AgentProvider, model: string): Promise<void> {
  const session = createProviderAgentAdapter({ provider, model }, createActivityDependencies()).createSession(WORKTREE_PATH);
  const events: AgentProgressEvent[] = [];
  const startedAt = Date.now();
  const result = await session.run(PROMPT, {
    onEvent: (event) => events.push(event),
  });
  const wallMs = Date.now() - startedAt;
  const summary = summarizeToolActivity(events);
  const verdict = summary.toolUseCount > 0 && summary.toolResultCount > 0
    ? 'ok (tool path exercised)'
    : summary.toolUseCount > 0
      ? 'partial (tool activity seen without an explicit tool result item)'
      : 'no tools observed';

  console.log(`\n===== ${provider} (${model}) =====`);
  for (const line of renderProviderItemTrace(events)) {
    console.log(line);
  }
  console.log('finalResponse:', JSON.stringify(result.finalResponse));
  console.log('providerItemTypes:', summary.providerItemTypes);
  console.log('toolUseCount:', summary.toolUseCount);
  console.log('toolResultCount:', summary.toolResultCount);
  console.log('usage:', result.usage);
  console.log('costMicroUsd:', result.costMicroUsd);
  console.log('wallMs:', wallMs);
  console.log('VERDICT:', verdict);
}

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY is not set');
    process.exit(1);
  }
  if (!process.env.OPENAI_API_KEY) {
    console.error('OPENAI_API_KEY is not set');
    process.exit(1);
  }

  await runOne('claude', process.env.SMOKE_CLAUDE_MODEL ?? DEFAULT_AGENT_MODEL_BY_PROVIDER.claude);
  await runOne('codex', process.env.SMOKE_CODEX_MODEL ?? DEFAULT_AGENT_MODEL_BY_PROVIDER.codex);
}

main().catch((error) => {
  console.error('smoke failed:', error);
  process.exit(1);
});