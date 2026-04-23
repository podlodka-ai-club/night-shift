import * as fs from 'fs';
import * as path from 'path';
import {
  IMPLEMENT_RESULT_SCHEMA,
  parseImplementResult,
  isSuccessfulImplementResult,
} from '../types.js';
import type { StageContext } from './StageContext.js';

/** Fields required by the implement stage. */
type ImplementCtx = Pick<
  StageContext,
  'config' | 'store' | 'runner' | 'ticketId' | 'openspecChangeDir' | 'worktreeDir' | 'issueTitle'
>;

/**
 * Implementation stage: uses the configured implementer role
 * implements every task from tasks.md using built-in tools (Read, Edit, Bash, Glob, Grep).
 * Uses structured output (IMPLEMENT_RESULT_SCHEMA) to guarantee a machine-parseable
 * summary with filesChanged and tasksCompleted.
 */
export async function runImplementStage(ctx: ImplementCtx): Promise<void> {
  const { ticketId, openspecChangeDir, worktreeDir, issueTitle } = ctx;

  const tasksPath = path.join(openspecChangeDir, 'tasks.md');
  if (!fs.existsSync(tasksPath)) {
    throw new Error(`tasks.md not found at ${tasksPath}`);
  }
  const tasksContent = fs.readFileSync(tasksPath, 'utf-8');

  const designPath = path.join(openspecChangeDir, 'design.md');
  const designContent = fs.existsSync(designPath)
    ? fs.readFileSync(designPath, 'utf-8')
    : '';

  const prompt = [
    `Repository task: "${issueTitle}"`,
    '',
    'You are an expert software engineer implementing coding tasks in a repository.',
    'Work through each task in the checklist completely before moving on.',
    'Make minimal, correct changes. Use the tools available to read, edit, and test code.',
    'When finished, return structured output with `completed=true` only if the requested implementation is fully done for this run.',
    'If you cannot finish, refuse, or need the task split further, return `completed=false` and leave `filesChanged` / `tasksCompleted` empty unless you actually changed files in this run.',
    '',
    '## Implementation Tasks',
    tasksContent,
    '',
    '## Design Context',
    designContent,
    '',
    'Implement all tasks above. Read existing code before making changes.',
  ].join('\n');

  const rawOutput = await ctx.runner.runRole(
    'implementer',
    prompt,
    'implement',
    'implement',
    {
      workingDirectory: worktreeDir,
      structuredOutputSchema: IMPLEMENT_RESULT_SCHEMA as unknown as Record<string, unknown>,
    },
  );

  // Save the structured output and parsed result to the run directory for auditing.
  const runDir = ctx.store.runDir(ticketId);
  fs.writeFileSync(path.join(runDir, 'implement-output.json'), rawOutput);

  try {
    const result = parseImplementResult(JSON.parse(rawOutput));
    if (!result) {
      throw new Error('Structured output did not match IMPLEMENT_RESULT_SCHEMA');
    }
    if (!isSuccessfulImplementResult(result)) {
      throw new Error(
        result.completed
          ? 'Implementer reported no changed files or completed tasks. Refusing to treat the run as implemented.'
          : 'Implementer marked the task as not completed. Refusing to treat the run as implemented.'
      );
    }
    fs.writeFileSync(
      path.join(runDir, 'implement-summary.json'),
      JSON.stringify(result, null, 2),
    );
  } catch (err) {
    // Structured output parse failure — wrap in JSON error envelope.
    fs.writeFileSync(
      path.join(runDir, 'implement-error.json'),
      JSON.stringify(
        {
          error: true,
          message: err instanceof Error ? err.message : 'Failed to parse structured output',
          raw: rawOutput,
        },
        null,
        2,
      ),
    );
    throw err;
  }
}
