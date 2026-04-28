import type { SelectedProjectIssue } from '../shared';

export function buildChangeName(issue: SelectedProjectIssue): string {
  const slug = issue.issueTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'change';
  return `${issue.issueNumber}-${slug}`;
}