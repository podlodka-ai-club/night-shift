import assert from 'assert';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'mocha';
import { loadProjectExtensionManifest } from '../project-extension';
import { createEmptyProjectExtensionManifest } from '../project-extension-manifest';

describe('project extension loader', () => {
  it('returns an empty manifest when the repo has no extension file', async () => {
    const worktreePath = await mkdtemp(path.join(os.tmpdir(), 'orchestrator-project-extension-missing-'));
    try {
      assert.deepStrictEqual(await loadProjectExtensionManifest(worktreePath), createEmptyProjectExtensionManifest());
    } finally { await rm(worktreePath, { recursive: true, force: true }); }
  });

  it('loads valid prompt and quality-gate registrations into a plain manifest', async () => {
    const worktreePath = await createExtensionWorktree('valid', [
      "export default defineProjectExtension((project) => {",
      "  project.prompt('specify').prepend('Follow repo spec rules.');",
      "  project.prompt('review').append('Double-check migrations.');",
      "  project.qualityGate('lint', { run: 'npm test' });",
      '});',
    ]);
    try {
      assert.deepStrictEqual(await loadProjectExtensionManifest(worktreePath), {
        prompts: {
          specify: { prepend: ['Follow repo spec rules.'], append: [] },
          implement: { prepend: [], append: [] },
          review: { prepend: [], append: ['Double-check migrations.'] },
        },
	        agentDefaults: {},
	        agents: {},
        qualityGates: [{ id: 'lint', run: 'npm test' }],
      });
    } finally { await rm(worktreePath, { recursive: true, force: true }); }
  });

	  it('loads project agent defaults and per-phase overrides into the manifest', async () => {
	    const worktreePath = await createExtensionWorktree('agents', [
	      'export default defineProjectExtension((project) => {',
	      "  project.agentDefaults({ provider: 'openai', config: { model: 'gpt-5.4', reasoningEffort: 'high' } });",
	      "  project.agent('implement', { config: { model: 'claude-haiku-4-5', temperature: 0.2 } });",
	      "  project.agent('review', { provider: 'anthropic' });",
	      '});',
	    ]);
	    try {
	      assert.deepStrictEqual(await loadProjectExtensionManifest(worktreePath), {
	        ...createEmptyProjectExtensionManifest(),
	        agentDefaults: { provider: 'codex', config: { model: 'gpt-5.4', reasoningEffort: 'high' } },
	        agents: {
	          implement: { config: { model: 'claude-haiku-4-5', temperature: 0.2 } },
	          review: { provider: 'claude' },
	        },
	      });
	    } finally { await rm(worktreePath, { recursive: true, force: true }); }
	  });

	  it('merges repeated agent registrations in order while keeping phase overrides separate from project defaults', async () => {
	    const worktreePath = await createExtensionWorktree('agent-merge', [
	      'export default defineProjectExtension((project) => {',
	      "  project.agent('implement', { config: { model: 'claude-haiku-4-5', temperature: 0.2 } });",
	      "  project.agentDefaults({ provider: 'anthropic', config: { model: 'claude-sonnet-4-6', maxTurns: 3 } });",
	      "  project.agentDefaults({ config: { maxTurns: 5 } });",
	      "  project.agent('implement', { provider: 'anthropic', config: { model: 'claude-opus-4-1' } });",
	      '});',
	    ]);
	    try {
	      assert.deepStrictEqual(await loadProjectExtensionManifest(worktreePath), {
	        ...createEmptyProjectExtensionManifest(),
	        agentDefaults: {
	          provider: 'claude',
	          config: { model: 'claude-sonnet-4-6', maxTurns: 5 },
	        },
	        agents: {
	          implement: {
	            provider: 'claude',
	            config: { model: 'claude-opus-4-1', temperature: 0.2 },
	          },
	        },
	      });
	    } finally { await rm(worktreePath, { recursive: true, force: true }); }
	  });

  it('fails when the extension uses an unsupported prompt phase', async () => {
    const worktreePath = await createExtensionWorktree('invalid-phase', [
      "export default defineProjectExtension((project) => {",
      "  project.prompt('deploy').append('nope');",
      '});',
    ]);
    try {
      await assert.rejects(() => loadProjectExtensionManifest(worktreePath), /Unsupported project prompt phase: deploy/);
    } finally { await rm(worktreePath, { recursive: true, force: true }); }
  });

  it('fails when the extension module throws during evaluation', async () => {
    const worktreePath = await createExtensionWorktree('module-error', ["throw new Error('boom');"]);
    try {
      await assert.rejects(() => loadProjectExtensionManifest(worktreePath), /boom/);
    } finally { await rm(worktreePath, { recursive: true, force: true }); }
  });

  it('fails when the extension registers duplicate quality gate ids', async () => {
    const worktreePath = await createExtensionWorktree('duplicate-quality-gate', [
      'export default defineProjectExtension((project) => {',
      "  project.qualityGate('lint', { run: 'npm test' });",
      "  project.qualityGate('lint', { run: 'npm run lint' });",
      '});',
    ]);
    try {
      await assert.rejects(() => loadProjectExtensionManifest(worktreePath), /Duplicate quality gate id: lint/);
    } finally { await rm(worktreePath, { recursive: true, force: true }); }
  });

	  it('fails when agent registrations use an invalid provider id', async () => {
	    const worktreePath = await createExtensionWorktree('invalid-agent-provider', [
	      'export default defineProjectExtension((project) => {',
	      "  project.agentDefaults({ provider: 'unknown-provider' });",
	      '});',
	    ]);
	    try {
	      await assert.rejects(() => loadProjectExtensionManifest(worktreePath), /project\.agentDefaults.*unsupported provider/i);
	    } finally { await rm(worktreePath, { recursive: true, force: true }); }
	  });

  it('does not leak module state between loads', async () => {
    const worktreePath = await createExtensionWorktree('no-cache', [
      'let loadCount = 0;',
      'export default defineProjectExtension((project) => {',
      '  loadCount += 1;',
      "  project.prompt('implement').append(`load:${loadCount}`);",
      '});',
    ]);
    try {
      const first = await loadProjectExtensionManifest(worktreePath);
      const second = await loadProjectExtensionManifest(worktreePath);
      assert.deepStrictEqual(first.prompts.implement.append, ['load:1']);
      assert.deepStrictEqual(second.prompts.implement.append, ['load:1']);
    } finally { await rm(worktreePath, { recursive: true, force: true }); }
  });
});

async function createExtensionWorktree(name: string, lines: string[]) {
  const worktreePath = await mkdtemp(path.join(os.tmpdir(), `orchestrator-project-extension-${name}-`));
  const extensionDir = path.join(worktreePath, '.orchestrator');
  await mkdir(extensionDir, { recursive: true });
  await writeFile(path.join(extensionDir, 'project.extension.ts'), lines.join('\n'), 'utf8');
  return worktreePath;
}
