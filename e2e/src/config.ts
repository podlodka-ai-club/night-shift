export type E2EAgentMode = 'real' | 'fake';
export type E2EIntakeMode = 'manual' | 'pickup';

export interface E2EConfig {
  targetRepo: {
    owner: string;
    name: string;
  };
  projectOwner: string;
  projectNumber: number;
  agentMode: E2EAgentMode;
  intakeMode: E2EIntakeMode;
  cleanup: boolean;
  preserveOnFailure: boolean;
  githubToken: string;
}

export function parseE2EConfig(env: NodeJS.ProcessEnv): E2EConfig {
  return {
    targetRepo: parseRepo(readRequired(env, 'E2E_TARGET_REPO')),
    projectOwner: readRequired(env, 'E2E_PROJECT_OWNER'),
    projectNumber: parsePositiveInteger(readRequired(env, 'E2E_PROJECT_NUMBER'), 'E2E_PROJECT_NUMBER'),
    agentMode: parseAgentMode(readRequired(env, 'E2E_AGENT_MODE')),
    intakeMode: parseIntakeMode(env.E2E_INTAKE_MODE ?? 'manual'),
    cleanup: parseBooleanFlag(env.E2E_CLEANUP ?? 'true', 'E2E_CLEANUP'),
    preserveOnFailure: parseBooleanFlag(env.E2E_PRESERVE_ON_FAILURE ?? 'true', 'E2E_PRESERVE_ON_FAILURE'),
    githubToken: readGitHubToken(env),
  };
}

function readRequired(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) {
    throw new Error(`${key} is required.`);
  }
  return value;
}

function readGitHubToken(env: NodeJS.ProcessEnv): string {
  const token = env.GITHUB_TOKEN?.trim() || env.GH_TOKEN?.trim();
  if (!token) {
    throw new Error('Set GITHUB_TOKEN or GH_TOKEN before running e2e.');
  }
  return token;
}

function parseRepo(rawRepo: string): { owner: string; name: string } {
  const [owner, name, extra] = rawRepo.split('/');
  if (!owner || !name || extra) {
    throw new Error('E2E_TARGET_REPO must be in the form owner/name.');
  }
  return { owner, name };
}

function parsePositiveInteger(rawValue: string, key: string): number {
  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${key} must be a positive integer.`);
  }
  return parsed;
}

function parseAgentMode(rawValue: string): E2EAgentMode {
  if (rawValue === 'real' || rawValue === 'fake') {
    return rawValue;
  }
  throw new Error('E2E_AGENT_MODE must be "real" or "fake".');
}

function parseIntakeMode(rawValue: string): E2EIntakeMode {
  if (rawValue === 'manual' || rawValue === 'pickup') {
    return rawValue;
  }
  throw new Error('E2E_INTAKE_MODE must be "manual" or "pickup".');
}

function parseBooleanFlag(rawValue: string, key: string): boolean {
  if (rawValue === 'true') return true;
  if (rawValue === 'false') return false;
  throw new Error(`${key} must be "true" or "false".`);
}