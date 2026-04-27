import assert from 'assert';
import { describe, it } from 'mocha';
import type { Logger, LogLevel, LogMetadata } from '@temporalio/worker';
import { createExpectedWarningFilterLogger } from './workflow-test-helpers';

type LogEntry = { level: LogLevel; message: string; meta?: LogMetadata };

function createRecordingLogger(entries: LogEntry[]): Logger {
  const push = (level: LogLevel, message: string, meta?: LogMetadata) => {
    entries.push({ level, message, meta });
  };

  return {
    log: push,
    trace: (message, meta) => push('TRACE', message, meta),
    debug: (message, meta) => push('DEBUG', message, meta),
    info: (message, meta) => push('INFO', message, meta),
    warn: (message, meta) => push('WARN', message, meta),
    error: (message, meta) => push('ERROR', message, meta),
  };
}

describe('workflow test warning logger', () => {
  it('suppresses only matching worker warnings', () => {
    const entries: LogEntry[] = [];
    const logger = createExpectedWarningFilterLogger(createRecordingLogger(entries), () => [/commit failed/]);

    logger.warn('Activity failed', { sdkComponent: 'worker', error: new Error('commit failed') });
    logger.warn('Activity failed', { sdkComponent: 'worker', error: new Error('unexpected failure') });

    assert.deepStrictEqual(entries.map((entry) => String(entry.meta?.error)), ['Error: unexpected failure']);
  });

  it('does not suppress non-worker warnings even when the text matches', () => {
    const entries: LogEntry[] = [];
    const logger = createExpectedWarningFilterLogger(createRecordingLogger(entries), () => [/commit failed/]);

    logger.warn('Activity failed', { sdkComponent: 'activity', error: new Error('commit failed') });

    assert.strictEqual(entries.length, 1);
  });
});