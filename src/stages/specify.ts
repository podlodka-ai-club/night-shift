import { OpenSpecService } from '../workspace/OpenSpecService.js';
import { ARTIFACT_SCHEMA } from '../types.js';
import type { StageContext } from './StageContext.js';

/** Fields required by the specify stage. */
type SpecifyCtx = Pick<
  StageContext,
  'config' | 'store' | 'runner' | 'ticketId' | 'issueTitle' | 'issueBody' | 'repoOwner' | 'repoName'
>;

/**
 * Specification stage: uses the configured planner role to generate OpenSpec artifacts
 * (proposal, design, specs, tasks) from the GitHub Project item.
 * All agent outputs use structured output (ARTIFACT_SCHEMA) to guarantee
 * machine-parseable JSON with no prose leakage.
 * The resulting tasks.md becomes the definition of done for the implement stage.
 */
export async function runSpecifyStage(ctx: SpecifyCtx): Promise<string> {
  const { ticketId, issueTitle, issueBody, repoOwner, repoName } = ctx;
  const runDir = ctx.store.runDir(ticketId);
  const changeId = `ticket-${ticketId.slice(-8)}`;
  const svc = new OpenSpecService(runDir, changeId);
  svc.scaffold();

  const context = `Repository: ${repoOwner}/${repoName}\nTitle: ${issueTitle}\n\n${issueBody ?? ''}`;

  /** Parse structured `{ content: string }` response from the configured planner. */
  function extractContent(raw: string): string {
    const parsed = JSON.parse(raw) as { content: string };
    if (typeof parsed.content !== 'string' || !parsed.content.trim()) {
      throw new Error('Structured output missing "content" field');
    }
    return parsed.content;
  }

  // ── Proposal ──────────────────────────────────────────────────────────────
  const proposalRaw = await ctx.runner.runRole(
    'planner',
    `You are an expert software architect generating a concise OpenSpec artifact.\n` +
    `Return your output as structured JSON with a single "content" field containing the full markdown.\n\n` +
    `Generate a concise proposal.md for this GitHub issue.\n\nContext:\n${context}\n\n` +
    `Template:\n## Why\n<!-- motivation -->\n\n## What Changes\n<!-- bullet list -->\n\n## Impact\n<!-- affected systems -->\n`,
    'specify-proposal',
    'specify',
    { structuredOutputSchema: ARTIFACT_SCHEMA as unknown as Record<string, unknown> },
  );
  const proposalContent = extractContent(proposalRaw);
  svc.write('proposal.md', proposalContent);

  // ── Design ────────────────────────────────────────────────────────────────
  const designRaw = await ctx.runner.runRole(
    'planner',
    `You are an expert software architect generating a concise OpenSpec artifact.\n` +
    `Return your output as structured JSON with a single "content" field containing the full markdown.\n\n` +
    `Generate a concise design.md for this GitHub issue.\n\nContext:\n${context}\n\n` +
    `Proposal:\n${proposalContent}\n\n` +
    `Template:\n## Context\n<!-- background -->\n\n## Decisions\n<!-- key technical choices -->\n\n## Risks\n<!-- known risks -->\n`,
    'specify-design',
    'specify',
    { structuredOutputSchema: ARTIFACT_SCHEMA as unknown as Record<string, unknown> },
  );
  const designContent = extractContent(designRaw);
  svc.write('design.md', designContent);

  // ── Spec ──────────────────────────────────────────────────────────────────
  const specRaw = await ctx.runner.runRole(
    'planner',
    `You are an expert software architect generating a concise OpenSpec artifact.\n` +
    `Return your output as structured JSON with a single "content" field containing the full markdown.\n\n` +
    `Generate a spec.md with ADDED Requirements for this GitHub issue.\n\nContext:\n${context}\n\n` +
    `Each requirement must use "### Requirement: <name>" and "#### Scenario: <name>" with WHEN/THEN.\n` +
    `Template:\n## ADDED Requirements\n\n### Requirement: <!-- name -->\n<!-- SHALL statement -->\n\n` +
    `#### Scenario: <!-- name -->\n- **WHEN** <!-- condition -->\n- **THEN** <!-- outcome -->\n`,
    'specify-spec',
    'specify',
    { structuredOutputSchema: ARTIFACT_SCHEMA as unknown as Record<string, unknown> },
  );
  const specContent = extractContent(specRaw);
  svc.write('specs/main/spec.md', specContent);

  // ── Tasks ─────────────────────────────────────────────────────────────────
  const tasksRaw = await ctx.runner.runRole(
    'planner',
    `You are an expert software architect generating a concise OpenSpec artifact.\n` +
    `Return your output as structured JSON with a single "content" field containing the full markdown.\n\n` +
    `Generate a tasks.md implementation checklist for this GitHub issue.\n\nContext:\n${context}\n\n` +
    `Design:\n${designContent}\n\n` +
    `Rules:\n- Group under ## numbered headings\n- Each task: "- [ ] X.Y description"\n` +
    `- Order by dependency\n- Each task completable in one session\n`,
    'specify-tasks',
    'specify',
    { structuredOutputSchema: ARTIFACT_SCHEMA as unknown as Record<string, unknown> },
  );
  const tasksContent = extractContent(tasksRaw);
  svc.write('tasks.md', tasksContent);

  if (!svc.isComplete()) {
    throw new Error('OpenSpec artifact generation incomplete after all steps');
  }

  await ctx.store.appendEvent(ticketId, {
    ts: new Date().toISOString(),
    stage: 'specified',
    type: 'stage_completed',
    message: `OpenSpec artifacts generated at ${svc.changeDir}`,
  });

  return svc.changeDir;
}
