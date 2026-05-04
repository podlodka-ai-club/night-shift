import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import ts from 'typescript';
import type { ProjectExtensionManifest, ProjectExtensionPromptPhase, WorktreeContext } from './shared';
import { createEmptyProjectExtensionManifest } from './project-extension-manifest';

const EXTENSION_RELATIVE_PATH = path.join('.orchestrator', 'project.extension.ts');
const PROMPT_PHASES = ['specify', 'implement', 'review'] as const satisfies readonly ProjectExtensionPromptPhase[];

type ProjectExtensionRegistration = (project: ReturnType<typeof createProjectApi>) => void;

export function defineProjectExtension<T extends ProjectExtensionRegistration>(registration: T): T {
  return registration;
}

export async function loadProjectExtensionManifest(worktreePath: string): Promise<ProjectExtensionManifest> {
  const extensionPath = path.join(worktreePath, EXTENSION_RELATIVE_PATH);
  if (!existsSync(extensionPath)) {
    return createEmptyProjectExtensionManifest();
  }

  const source = await readFile(extensionPath, 'utf8');
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: extensionPath,
  });

  const runtimeRequire = createRequire(extensionPath);
  const isolatedRequire = (specifier: string) => {
    const resolved = runtimeRequire.resolve(specifier);
    delete runtimeRequire.cache[resolved];
    try {
      return runtimeRequire(specifier);
    } finally {
      delete runtimeRequire.cache[resolved];
    }
  };
  const module = { exports: {} as { default?: unknown } | unknown };

  try {
    const run = new Function('exports', 'module', 'require', '__filename', '__dirname', 'defineProjectExtension', transpiled.outputText);
    run(module.exports, module, isolatedRequire, extensionPath, path.dirname(extensionPath), defineProjectExtension);
    const loaded = typeof module.exports === 'object' && module.exports !== null && 'default' in module.exports
      ? module.exports.default
      : module.exports;
    if (typeof loaded !== 'function') {
      throw new Error('Project extension must export default defineProjectExtension((project) => { ... }).');
    }
    const manifest = createEmptyProjectExtensionManifest();
    loaded(createProjectApi(manifest));
    return manifest;
  } catch (error) {
    throw new Error(`Failed to load project extension from ${extensionPath}: ${toErrorMessage(error)}`);
  }
}

export function createProjectExtensionActivities() {
  return {
    async loadProjectExtensionManifest(input: { worktree: WorktreeContext }) {
      return loadProjectExtensionManifest(input.worktree.worktreePath);
    },
  };
}

function createProjectApi(manifest: ProjectExtensionManifest) {
  return {
    prompt(phase: ProjectExtensionPromptPhase) {
      assertPromptPhase(phase);
      return {
        prepend(text: string) {
          assertText(text, `prompt(${phase}).prepend`);
          manifest.prompts[phase].prepend.push(text);
        },
        append(text: string) {
          assertText(text, `prompt(${phase}).append`);
          manifest.prompts[phase].append.push(text);
        },
      };
    },
    qualityGate(id: string, options: { run: string }) {
      assertText(id, 'qualityGate id');
      assertText(options?.run, `qualityGate(${id}).run`);
      if (manifest.qualityGates.some((gate) => gate.id === id)) {
        throw new Error(`Duplicate quality gate id: ${id}`);
      }
      manifest.qualityGates.push({ id, run: options.run });
    },
  };
}

function assertPromptPhase(value: string): asserts value is ProjectExtensionPromptPhase {
  if (!PROMPT_PHASES.includes(value as ProjectExtensionPromptPhase)) {
    throw new Error(`Unsupported project prompt phase: ${value}`);
  }
}

function assertText(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string.`);
  }
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
