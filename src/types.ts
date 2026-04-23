import type { AgentProvider, AgentRole } from './config.js';

// All shared domain types for the orchestrator.

export const RUN_STAGES = [
  'claimed',
  'specified',
  'implemented',
  'validated',
  'pr_opened',
  'reviewed',
  'fixed',
  'completed',
  'blocked',
] as const;

export type RunStage = (typeof RUN_STAGES)[number];

export type BudgetStage = 'specify' | 'implement' | 'review';

export const TERMINAL_STAGES: ReadonlySet<RunStage> = new Set(['completed', 'blocked']);

export interface RunState {
  ticketId: string;           // GitHub Project item node ID
  issueNumber?: number;
  issueTitle?: string;
  issueBody?: string;
  issueUrl?: string;
  repoOwner: string;
  repoName: string;
  branch: string;
  stage: RunStage;
  blockedAtStage?: RunStage;   // stage where the run was blocked — used for resume
  blockedReason?: string;
  prNumber?: number;
  prUrl?: string;
  worktreeDir?: string;
  openspecChangeDir?: string; // path to generated OpenSpec artifacts
  createdAt: string;
  updatedAt: string;
}

export interface RunEvent {
  ts: string;
  stage: RunStage;
  type: 'stage_entered' | 'stage_completed' | 'blocked' | 'info' | 'error';
  message: string;
  data?: unknown;
}

export interface UsageRecord {
  step: string;
  role?: AgentRole;
  budgetStage?: BudgetStage;
  provider: AgentProvider | 'unknown';
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  estimatedCostUsd: number;
  elapsedMs: number;
  ts: string;
}

export interface ReviewFinding {
  severity: 'error' | 'warning' | 'info';
  summary: string;
  file?: string;
  line?: number;
  actionable: boolean;
}

export interface ValidationResult {
  passed: boolean;
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ProjectItem {
  id: string;
  issueNumber?: number;
  issueTitle?: string;
  issueBody?: string;
  issueUrl?: string;
}

export class BudgetExceededError extends Error {
  constructor(stage: string, limitUsd: number, usedUsd: number) {
    super(
      `Budget exceeded for stage "${stage}": limit $${limitUsd.toFixed(4)}, used $${usedUsd.toFixed(4)}`
    );
    this.name = 'BudgetExceededError';
  }
}

// ─── Structured output schemas ─────────────────────────────────────────────
// JSON Schema objects used by the role-dispatched Codex SDK `outputSchema`
// and Claude Agent SDK `outputFormat` integrations to enforce
// machine-parseable responses from every agent call.

/** Wraps a single markdown artifact to prevent prose leakage. */
export const ARTIFACT_SCHEMA = {
  type: 'object' as const,
  properties: {
    content: { type: 'string' as const, description: 'The full markdown content of the artifact.' },
  },
  required: ['content'] as const,
  additionalProperties: false as const,
};

/** Schema for review findings returned by the configured reviewer role. */
export const REVIEW_FINDINGS_SCHEMA = {
  type: 'object' as const,
  properties: {
    findings: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: {
          severity: { type: 'string' as const, enum: ['error', 'warning', 'info'] },
          summary: { type: 'string' as const },
          file: { type: ['string', 'null'] as const },
          line: { type: ['number', 'null'] as const },
          actionable: { type: 'boolean' as const },
        },
        required: ['severity', 'summary', 'file', 'line', 'actionable'] as const,
        additionalProperties: false as const,
      },
    },
  },
  required: ['findings'] as const,
  additionalProperties: false as const,
};

/** Schema for implementation output from the configured implementer role. */
export const IMPLEMENT_RESULT_SCHEMA = {
  type: 'object' as const,
  properties: {
    completed: {
      type: 'boolean' as const,
      description: 'True only when the implementation tasks were fully completed for this run.',
    },
    summary: { type: 'string' as const, description: 'Brief description of what was implemented.' },
    filesChanged: {
      type: 'array' as const,
      items: { type: 'string' as const },
      description: 'List of file paths that were created or modified.',
    },
    tasksCompleted: {
      type: 'array' as const,
      items: { type: 'string' as const },
      description: 'List of task IDs or descriptions that were completed.',
    },
  },
  required: ['completed', 'summary', 'filesChanged', 'tasksCompleted'] as const,
  additionalProperties: false as const,
};

/** Schema for bounded fix-pass output from the configured implementer role. */
export const FIX_RESULT_SCHEMA = {
  type: 'object' as const,
  properties: {
    summary: { type: 'string' as const, description: 'Brief description of fixes applied.' },
    fixesApplied: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: {
          finding: { type: 'string' as const, description: 'The review finding that was addressed.' },
          action: { type: 'string' as const, description: 'What was done to fix it.' },
          file: { type: 'string' as const },
        },
        required: ['finding', 'action'] as const,
        additionalProperties: false as const,
      },
    },
  },
  required: ['summary', 'fixesApplied'] as const,
  additionalProperties: false as const,
};

/** Typed result for structured implementation output. */
export interface ImplementResult {
  completed: boolean;
  summary: string;
  filesChanged: string[];
  tasksCompleted: string[];
}

function isPlaceholderImplementationEntry(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized.length === 0 || normalized === 'none' || normalized.startsWith('none ');
}

export function hasMeaningfulImplementationResult(result: ImplementResult): boolean {
  return (
    result.filesChanged.some((entry) => !isPlaceholderImplementationEntry(entry)) ||
    result.tasksCompleted.some((entry) => !isPlaceholderImplementationEntry(entry))
  );
}

export function parseImplementResult(value: unknown): ImplementResult | null {
  if (!value || typeof value !== 'object') return null;

  const candidate = value as {
    completed?: unknown;
    summary?: unknown;
    filesChanged?: unknown;
    tasksCompleted?: unknown;
  };

  if (typeof candidate.summary !== 'string') return null;
  if (!Array.isArray(candidate.filesChanged) || candidate.filesChanged.some((entry) => typeof entry !== 'string')) {
    return null;
  }
  if (!Array.isArray(candidate.tasksCompleted) || candidate.tasksCompleted.some((entry) => typeof entry !== 'string')) {
    return null;
  }

  const normalized = {
    summary: candidate.summary,
    filesChanged: candidate.filesChanged,
    tasksCompleted: candidate.tasksCompleted,
  } satisfies Omit<ImplementResult, 'completed'>;

  return {
    completed:
      typeof candidate.completed === 'boolean'
        ? candidate.completed
        : hasMeaningfulImplementationResult({ ...normalized, completed: true }),
    ...normalized,
  };
}

export function isSuccessfulImplementResult(result: ImplementResult): boolean {
  return result.completed && hasMeaningfulImplementationResult(result);
}

/** Typed result for structured fix output. */
export interface FixResult {
  summary: string;
  fixesApplied: Array<{ finding: string; action: string; file?: string }>;
}

export class StructuredOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StructuredOutputError';
  }
}

export class ValidationConfigMissingError extends Error {
  constructor(repoDir: string) {
    super(
      `feature-factory.config.json not found or has no validation.commands in ${repoDir}. ` +
      `Add the file to the repository to unblock this run.`
    );
    this.name = 'ValidationConfigMissingError';
  }
}
