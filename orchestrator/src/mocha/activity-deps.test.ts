import assert from 'assert';
import path from 'node:path';
import { describe, it } from 'mocha';
import { createActivityDependencies } from '../activities';

describe('activity dependencies', () => {
  it('closes stdin for child commands in the default command runner', async () => {
    const orchestratorRoot = path.resolve(__dirname, '..', '..');
    const result = await createActivityDependencies().execFile(
      'node',
      [
        '-e',
        [
          "process.stdin.once('end', () => {",
          "  console.log('stdin-closed');",
          '  process.exit(0);',
          '});',
          "process.stdin.resume();",
          'setTimeout(() => {',
          "  console.error('stdin-still-open');",
          '  process.exit(7);',
          '}, 100);',
        ].join(' '),
      ],
      { cwd: orchestratorRoot },
    );

    assert.strictEqual(result.exitCode, 0);
    assert.match(result.stdout, /stdin-closed/);
  });
});