import { loadConfig } from './config.js';
import { Worker } from './worker.js';
import { resolveFormat } from './output/summarizer.js';

/**
 * Parses the `--summary-format {pretty,json,none}` CLI flag from argv.
 *
 * Returns the flag value when present and valid, or `undefined` otherwise.
 *
 * @example
 *   node src/index.ts --summary-format json
 *   SUMMARY_FORMAT=json node src/index.ts
 */
function parseSummaryFormatFlag(argv: string[]): 'pretty' | 'json' | 'none' | undefined {
  const valid = (v: string): v is 'pretty' | 'json' | 'none' =>
    v === 'pretty' || v === 'json' || v === 'none';
  const die = (v: string): never => {
    console.error(
      `[main] Invalid --summary-format value "${v}". ` +
        'Allowed values: pretty, json, none.',
    );
    process.exit(1);
  };

  // Support --summary-format=VALUE form.
  for (const arg of argv) {
    if (arg.startsWith('--summary-format=')) {
      const value = arg.slice('--summary-format='.length);
      if (valid(value)) return value;
      die(value);
    }
  }

  // Support --summary-format VALUE form.
  const idx = argv.indexOf('--summary-format');
  if (idx !== -1 && idx + 1 < argv.length) {
    const value = argv[idx + 1];
    if (valid(value)) return value;
    die(value);
  }

  return undefined;
}

async function main(): Promise<void> {
  // Parse CLI flag for summary format before config load so it can be passed
  // to the Worker and eventually to EmitRunSummary.
  const summaryFormatFlag = parseSummaryFormatFlag(process.argv.slice(2));

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error('Configuration error:', err instanceof Error ? err.message : err);
    process.exit(1);
  }

  // Resolve effective summary format: CLI flag > config key > CI/TTY auto-detect.
  const resolvedFormat = resolveFormat(
    summaryFormatFlag,
    config.output.runSummary.format,
  );

  const worker = new Worker(config, resolvedFormat);

  // Graceful shutdown on SIGINT / SIGTERM.
  let stopping = false;
  const shutdown = () => {
    if (!stopping) {
      stopping = true;
      console.log('\n[main] Shutting down...');
    }
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    await worker.run();
  } catch (err) {
    console.error('[main] Unhandled error:', err);
    process.exit(1);
  }
}

main();
