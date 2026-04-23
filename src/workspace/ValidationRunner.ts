import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import { ValidationResult, ValidationConfigMissingError } from '../types.js';

const execFileAsync = promisify(execFile);

interface RepoConfig {
  validation: {
    commands: string[];
  };
}

/**
 * Loads validation commands from feature-factory.config.json in the repo root
 * and runs them sequentially, capturing output for each.
 */
export class ValidationRunner {
  /** Parses and returns the repo's validation config. Throws ValidationConfigMissingError if absent. */
  static loadRepoConfig(repoDir: string): RepoConfig {
    const configPath = path.join(repoDir, 'feature-factory.config.json');
    if (!fs.existsSync(configPath)) {
      throw new ValidationConfigMissingError(repoDir);
    }
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Partial<RepoConfig>;
    if (!raw.validation?.commands || raw.validation.commands.length === 0) {
      throw new ValidationConfigMissingError(repoDir);
    }
    return raw as RepoConfig;
  }

  /**
   * Runs every configured validation command in the repo directory.
   * Returns an array of results; the caller decides whether to gate on failures.
   */
  async run(repoDir: string): Promise<ValidationResult[]> {
    const { validation } = ValidationRunner.loadRepoConfig(repoDir);
    const results: ValidationResult[] = [];

    for (const command of validation.commands) {
      const [cmd, ...args] = command.split(/\s+/);
      try {
        const { stdout, stderr } = await execFileAsync(cmd, args, {
          cwd: repoDir,
          timeout: 300_000, // 5 min per command
          maxBuffer: 1024 * 1024 * 10,
        });
        results.push({ passed: true, command, stdout, stderr, exitCode: 0 });
      } catch (err) {
        const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number };
        results.push({
          passed: false,
          command,
          stdout: e.stdout ?? '',
          stderr: e.stderr ?? '',
          exitCode: e.code ?? 1,
        });
        // Stop on first failure – no point running later commands.
        break;
      }
    }

    return results;
  }

  /** Returns true iff all results passed. */
  static allPassed(results: ValidationResult[]): boolean {
    return results.length > 0 && results.every((r) => r.passed);
  }
}
