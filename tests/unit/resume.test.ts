import { describe, expect, it } from 'vitest';
import { deriveResumeStage, projectStatusForStage } from '../../src/resume';

describe('deriveResumeStage', () => {
  it('advances a blocked specified run to implemented when durable implementation evidence exists', () => {
    expect(
      deriveResumeStage({
        blockedAtStage: 'specified',
        specComplete: true,
        workspaceRecoverable: true,
        implementAttemptFailed: false,
        hasImplementationArtifacts: true,
        worktreeHasChanges: false,
        validationPassed: false,
        prExists: false,
      }),
    ).toBe('implemented');
  });

  it('advances a blocked validated run to pr_opened when a PR already exists', () => {
    expect(
      deriveResumeStage({
        blockedAtStage: 'validated',
        specComplete: true,
        workspaceRecoverable: true,
        implementAttemptFailed: false,
        hasImplementationArtifacts: true,
        worktreeHasChanges: true,
        validationPassed: true,
        prExists: true,
      }),
    ).toBe('pr_opened');
  });

  it('does not promote past specified when the branch/worktree cannot be recovered', () => {
    expect(
      deriveResumeStage({
        blockedAtStage: 'validated',
        specComplete: true,
        workspaceRecoverable: false,
        implementAttemptFailed: false,
        hasImplementationArtifacts: true,
        worktreeHasChanges: false,
        validationPassed: true,
        prExists: false,
      }),
    ).toBe('specified');
  });

  it('does not promote to validated from stale validation evidence alone', () => {
    expect(
      deriveResumeStage({
        blockedAtStage: 'validated',
        specComplete: true,
        workspaceRecoverable: true,
        implementAttemptFailed: false,
        hasImplementationArtifacts: false,
        worktreeHasChanges: false,
        validationPassed: true,
        prExists: false,
      }),
    ).toBe('specified');
  });

  it('steps back to specified when the latest implement attempt explicitly failed', () => {
    expect(
      deriveResumeStage({
        blockedAtStage: 'validated',
        specComplete: true,
        workspaceRecoverable: true,
        implementAttemptFailed: true,
        hasImplementationArtifacts: false,
        worktreeHasChanges: true,
        validationPassed: false,
        prExists: false,
      }),
    ).toBe('specified');
  });
});

describe('projectStatusForStage', () => {
  const statusValues = { inProgress: 'In progress', inReview: 'In review' };

  it('maps pre-pr stages to In progress', () => {
    expect(projectStatusForStage('implemented', statusValues)).toBe('In progress');
    expect(projectStatusForStage('validated', statusValues)).toBe('In progress');
  });

  it('maps review stages to In review', () => {
    expect(projectStatusForStage('pr_opened', statusValues)).toBe('In review');
    expect(projectStatusForStage('reviewed', statusValues)).toBe('In review');
    expect(projectStatusForStage('fixed', statusValues)).toBe('In review');
  });
});