import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ValidationRunner } from '../../src/workspace/ValidationRunner';
import { ValidationConfigMissingError } from '../../src/types';

describe('ValidationRunner.loadRepoConfig', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-val-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('throws ValidationConfigMissingError when config file is absent', () => {
    expect(() => ValidationRunner.loadRepoConfig(tmpDir)).toThrow(ValidationConfigMissingError);
  });

  it('throws ValidationConfigMissingError when validation.commands is empty', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'feature-factory.config.json'),
      JSON.stringify({ validation: { commands: [] } }),
    );
    expect(() => ValidationRunner.loadRepoConfig(tmpDir)).toThrow(ValidationConfigMissingError);
  });

  it('throws ValidationConfigMissingError when validation key is missing', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'feature-factory.config.json'),
      JSON.stringify({}),
    );
    expect(() => ValidationRunner.loadRepoConfig(tmpDir)).toThrow(ValidationConfigMissingError);
  });

  it('loads a valid config', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'feature-factory.config.json'),
      JSON.stringify({ validation: { commands: ['echo ok', 'echo done'] } }),
    );
    const cfg = ValidationRunner.loadRepoConfig(tmpDir);
    expect(cfg.validation.commands).toHaveLength(2);
    expect(cfg.validation.commands[0]).toBe('echo ok');
  });
});

describe('ValidationRunner.allPassed', () => {
  it('returns true when all results pass', () => {
    const results = [
      { passed: true, command: 'echo ok', stdout: 'ok', stderr: '', exitCode: 0 },
    ];
    expect(ValidationRunner.allPassed(results)).toBe(true);
  });

  it('returns false when any result fails', () => {
    const results = [
      { passed: true, command: 'echo ok', stdout: 'ok', stderr: '', exitCode: 0 },
      { passed: false, command: 'npm test', stdout: '', stderr: 'fail', exitCode: 1 },
    ];
    expect(ValidationRunner.allPassed(results)).toBe(false);
  });

  it('returns false for an empty array', () => {
    expect(ValidationRunner.allPassed([])).toBe(false);
  });
});

describe('ValidationRunner.run', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-val-run-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('runs a passing command and returns passed=true', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'feature-factory.config.json'),
      JSON.stringify({ validation: { commands: ['echo hello'] } }),
    );
    const runner = new ValidationRunner();
    const results = await runner.run(tmpDir);
    expect(results).toHaveLength(1);
    expect(results[0].passed).toBe(true);
    expect(results[0].stdout.trim()).toBe('hello');
  });

  it('runs a failing command and returns passed=false', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'feature-factory.config.json'),
      JSON.stringify({ validation: { commands: ['false'] } }),
    );
    const runner = new ValidationRunner();
    const results = await runner.run(tmpDir);
    expect(results[0].passed).toBe(false);
  });

  it('stops after the first failing command', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'feature-factory.config.json'),
      JSON.stringify({ validation: { commands: ['false', 'echo should-not-run'] } }),
    );
    const runner = new ValidationRunner();
    const results = await runner.run(tmpDir);
    expect(results).toHaveLength(1);
    expect(results[0].passed).toBe(false);
  });
});
