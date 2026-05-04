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
        qualityGates: [{ id: 'lint', run: 'npm test' }],
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
