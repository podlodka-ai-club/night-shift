export function buildTaskImplementationPrompt(taskDescription: string): string {
  return `Implement the task in this repository.\n\nTask description:\n${taskDescription}`;
}

export function buildChangeMetadataPrompt(): string {
  return [
    'Return commit and pull request metadata for the changes you just made.',
    '',
    'Requirements:',
    '- commitMessage should be ready to use with git commit -m',
    '- pullRequestTitle should be concise and specific',
    '- pullRequestBody should summarize the change clearly',
  ].join('\n');
}