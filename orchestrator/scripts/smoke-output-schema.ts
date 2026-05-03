import path from 'node:path';
import { DEFAULT_AGENT_MODEL_BY_PROVIDER, type AgentProvider } from '../src/agent-provider';
import { createDefaultLiveTurnRunner } from '../src/eval/live-common';
import { validateOutputSchemaSmokeText, validateOutputSchemaSmokeValue } from '../src/smoke-support';

const WORKTREE_PATH = path.resolve(__dirname, '..');
const RUNNER = createDefaultLiveTurnRunner();
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['answer', 'letters', 'count'],
  properties: {
    answer: { type: 'string' },
    letters: { type: 'array', items: { type: 'string' } },
    count: { type: 'integer' },
  },
} as const;
const PROMPT = "Return JSON with answer='pong', letters as the array ['p','o','n','g'], and count=4.";

async function runOne(provider: AgentProvider, model: string): Promise<void> {
  const result = await RUNNER({
    worktreePath: WORKTREE_PATH,
    prompt: PROMPT,
    outputSchema: SCHEMA,
    parseOutput: (value) => {
      const verdict = validateOutputSchemaSmokeValue(value);
      if (!verdict.ok) {
        throw new Error(verdict.reason);
      }
      return verdict.payload;
    },
    provider,
    model,
  });
  const verdict = validateOutputSchemaSmokeText(result.finalText);
  const expectedLetters = ['p', 'o', 'n', 'g'];
  const payloadMatches = verdict.ok
    && verdict.payload.answer.toLowerCase() === 'pong'
    && verdict.payload.count === 4
    && verdict.payload.letters.length === expectedLetters.length
    && verdict.payload.letters.every((value, index) => value.toLowerCase() === expectedLetters[index]);

  console.log(`\n===== ${provider} (${model}) =====`);
  console.log('finalText:', result.finalText);
  console.log('usage:', result.usage);
  console.log('costMicroUsd:', result.costMicroUsd);
  console.log('VERDICT:', verdict.ok && payloadMatches ? 'ok' : verdict.ok ? 'mismatch (schema valid, payload wrong)' : `validation failed: ${verdict.reason}`);
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