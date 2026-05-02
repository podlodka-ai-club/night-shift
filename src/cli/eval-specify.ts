import { parseArgs } from "node:util";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  evaluateSpecifySuite,
  replayRunner,
  SpecifyEvalFixtureSchema,
  type SpecifyEvalFixture,
  type SpecifyEvalResult,
  type SpecifyEvalSummary,
  type SpecifyTurnRunner,
} from "../eval/index.js";
import {
  createCritiqueReviseRunner,
  createLiveRunner,
  type ClosableSpecifyTurnRunner,
} from "./eval-specify-live.js";
import {
  createSpecJudge,
  type JudgeProvider,
  type SpecJudgeVerdict,
} from "./eval-specify-judge.js";

const USAGE = `night-shift eval:specify

Usage:
  night-shift eval:specify --fixtures <dir> [options]

Options:
  --fixtures <dir>    Directory containing fixture *.json files (required)
  --mode replay|live  Replay uses recordedFinalText (default).
                      Live calls the configured adapter — costs real money.
  --provider <id>     Adapter provider in live mode (default: xai)
  --model <id>        Model id in live mode (default: grok-4.1-fast)
  --fixture <id>      Run only the fixture with this id (repeatable)
  --record            Live mode only: write the live result back into the
                      source fixture file (recordedFinalText / recordedUsage /
                      recordedCostMicroUsd) so future replay matches.
  --judge             Live mode only: enable the cross-family judge and run
                      a critique-revise loop. Requires the API key for the
                      chosen judge provider.
  --judge-provider    Judge provider: openai (default) or anthropic. Reads
                      OPENAI_API_KEY or ANTHROPIC_API_KEY accordingly.
  --judge-model <id>  Judge model id (default: gpt-5-mini for openai,
                      claude-haiku-4-5 for anthropic).
  --max-revisions <n> Max specifier revision turns triggered by the judge
                      (default: 1). 0 turns the loop off but still runs the
                      judge for telemetry.
  --json              Emit machine-readable JSON to stdout instead of a table.
  --help              Show this message.

Replay mode is deterministic and free; CI should always use it.
Live mode is gated on having a valid API key (e.g. XAI_API_KEY for the xai
provider) and is intended for fixture authoring or model regression checks.

Exit codes:
  0  all selected fixtures passed (no parse/schema errors and no expectation mismatches)
  1  one or more failures
  64 usage error
`;

interface CliOptions {
  fixturesDir: string;
  json: boolean;
  mode: "replay" | "live";
  provider: string;
  model: string;
  fixtureIds: ReadonlyArray<string>;
  record: boolean;
  judge: boolean;
  judgeProvider: JudgeProvider;
  judgeModel: string;
  maxRevisions: number;
}

function parseCliArgs(argv: ReadonlyArray<string>): CliOptions {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      fixtures: { type: "string" },
      mode: { type: "string", default: "replay" },
      provider: { type: "string", default: "xai" },
      model: { type: "string", default: "grok-4.1-fast" },
      fixture: { type: "string", multiple: true, default: [] },
      record: { type: "boolean", default: false },
      judge: { type: "boolean", default: false },
      "judge-provider": { type: "string", default: "openai" },
      "judge-model": { type: "string" },
      "max-revisions": { type: "string", default: "1" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });
  if (values.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  if (typeof values.fixtures !== "string" || values.fixtures.length === 0) {
    process.stderr.write(USAGE);
    process.exit(64);
  }
  if (values.mode !== "replay" && values.mode !== "live") {
    process.stderr.write(`invalid --mode "${String(values.mode)}" (expected "replay" or "live")\n`);
    process.exit(64);
  }
  if (values.record && values.mode !== "live") {
    process.stderr.write(`--record requires --mode live\n`);
    process.exit(64);
  }
  if (values.judge && values.mode !== "live") {
    process.stderr.write(`--judge requires --mode live\n`);
    process.exit(64);
  }
  const judgeProviderRaw = values["judge-provider"] ?? "openai";
  if (judgeProviderRaw !== "anthropic" && judgeProviderRaw !== "openai") {
    process.stderr.write(
      `invalid --judge-provider "${String(judgeProviderRaw)}" (expected "anthropic" or "openai")\n`,
    );
    process.exit(64);
  }
  const judgeProvider = judgeProviderRaw as JudgeProvider;
  const defaultJudgeModel = judgeProvider === "openai" ? "gpt-5-mini" : "claude-haiku-4-5";
  const maxRevRaw = values["max-revisions"] ?? "1";
  const maxRevisions = Number.parseInt(maxRevRaw, 10);
  if (!Number.isFinite(maxRevisions) || maxRevisions < 0) {
    process.stderr.write(`invalid --max-revisions "${String(maxRevRaw)}" (expected non-negative integer)\n`);
    process.exit(64);
  }
  return {
    fixturesDir: path.resolve(values.fixtures),
    json: values.json === true,
    mode: values.mode,
    provider: values.provider ?? "xai",
    model: values.model ?? "grok-4.1-fast",
    fixtureIds: Array.isArray(values.fixture) ? values.fixture : [],
    record: values.record === true,
    judge: values.judge === true,
    judgeProvider,
    judgeModel: values["judge-model"] ?? defaultJudgeModel,
    maxRevisions,
  };
}

interface LoadedFixture {
  fixture: SpecifyEvalFixture;
  filePath: string;
}

async function loadFixtures(dir: string): Promise<LoadedFixture[]> {
  const entries = await readdir(dir);
  const out: LoadedFixture[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const filePath = path.join(dir, entry);
    const raw = await readFile(filePath, "utf8");
    out.push({
      fixture: SpecifyEvalFixtureSchema.parse(JSON.parse(raw)),
      filePath,
    });
  }
  out.sort((a, b) => a.fixture.id.localeCompare(b.fixture.id));
  return out;
}

function applyFixtureFilter(
  loaded: ReadonlyArray<LoadedFixture>,
  ids: ReadonlyArray<string>,
): LoadedFixture[] {
  if (ids.length === 0) return [...loaded];
  const wanted = new Set(ids);
  const filtered = loaded.filter((l) => wanted.has(l.fixture.id));
  const found = new Set(filtered.map((l) => l.fixture.id));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length > 0) {
    process.stderr.write(`warning: fixture id(s) not found: ${missing.join(", ")}\n`);
  }
  return filtered;
}

/**
 * Recording wrapper: passes through to the underlying runner and captures
 * the result so the CLI can persist it back into the fixture file when
 * `--record` is set.
 */
function makeRecordingRunner(
  inner: SpecifyTurnRunner,
): {
  runner: SpecifyTurnRunner;
  captured: Map<string, Awaited<ReturnType<SpecifyTurnRunner["run"]>>>;
} {
  const captured = new Map<string, Awaited<ReturnType<SpecifyTurnRunner["run"]>>>();
  const runner: SpecifyTurnRunner = {
    async run(fixture) {
      const turn = await inner.run(fixture);
      captured.set(fixture.id, turn);
      return turn;
    },
  };
  return { runner, captured };
}

async function persistRecordings(
  loaded: ReadonlyArray<LoadedFixture>,
  captured: Map<string, Awaited<ReturnType<SpecifyTurnRunner["run"]>>>,
): Promise<void> {
  for (const { fixture, filePath } of loaded) {
    const turn = captured.get(fixture.id);
    if (!turn) continue;
    const updated = {
      ...fixture,
      recordedFinalText: turn.finalText,
      recordedUsage: turn.usage,
      recordedCostMicroUsd: Math.round(turn.costMicroUsd),
    };
    await writeFile(filePath, JSON.stringify(updated, null, 2) + "\n", "utf8");
  }
}

function renderText(
  results: ReadonlyArray<SpecifyEvalResult>,
  summary: SpecifyEvalSummary,
  mode: "replay" | "live",
): string {
  const lines: string[] = [];
  lines.push(`Specify eval — ${mode} mode`);
  lines.push("─".repeat(40));
  for (const r of results) {
    const flag = r.expectationMismatch ? "FAIL" : "ok  ";
    const cost = `$${(r.costMicroUsd / 1_000_000).toFixed(4)}`;
    lines.push(
      `  ${flag}  ${r.id.padEnd(28)} status=${r.status.padEnd(13)} oq=${r.openQuestionsCount} cost=${cost}`,
    );
    if (r.expectationMismatch) lines.push(`        mismatch: ${r.expectationMismatch}`);
  }
  lines.push("─".repeat(40));
  lines.push(`  total:                ${summary.total}`);
  lines.push(`  refined:              ${summary.byStatus.refined}`);
  lines.push(`  needs_input:          ${summary.byStatus.needs_input}`);
  lines.push(`  parse_error:          ${summary.byStatus.parse_error}`);
  lines.push(`  schema_error:         ${summary.byStatus.schema_error}`);
  lines.push(`  expectationMismatches:${summary.expectationMismatches}`);
  lines.push(`  totalCost:            $${(summary.totalCostMicroUsd / 1_000_000).toFixed(4)}`);
  lines.push(`  totalTokens:          ${summary.totalTokens}`);
  return lines.join("\n") + "\n";
}

function renderJudgeLog(
  judgeLog: ReadonlyArray<{ fixtureId: string; attempt: number; verdict: SpecJudgeVerdict }>,
): string {
  if (judgeLog.length === 0) return "";
  const lines: string[] = [];
  lines.push("");
  lines.push("Judge log");
  lines.push("─".repeat(40));
  let pass = 0;
  let revise = 0;
  let judgeCost = 0;
  for (const entry of judgeLog) {
    const tag = entry.verdict.verdict === "pass" ? "PASS  " : "REVISE";
    const cost = `$${(entry.verdict.costMicroUsd / 1_000_000).toFixed(4)}`;
    lines.push(
      `  ${tag} attempt=${entry.attempt}  ${entry.fixtureId.padEnd(28)} cost=${cost}`,
    );
    if (entry.verdict.verdict === "revise" && entry.verdict.critique) {
      const first = entry.verdict.critique.split("\n").find((l) => l.trim()) ?? "";
      const truncated = first.length > 90 ? `${first.slice(0, 87)}...` : first;
      lines.push(`         ↳ ${truncated}`);
    }
    if (entry.verdict.verdict === "pass") pass++;
    else revise++;
    judgeCost += entry.verdict.costMicroUsd;
  }
  lines.push("─".repeat(40));
  lines.push(`  judge calls:          ${judgeLog.length}`);
  lines.push(`  pass / revise:        ${pass} / ${revise}`);
  lines.push(`  judge cost:           $${(judgeCost / 1_000_000).toFixed(4)}`);
  return lines.join("\n") + "\n";
}

export async function main(argv: ReadonlyArray<string>): Promise<number> {
  const opts = parseCliArgs(argv);
  const loaded = applyFixtureFilter(await loadFixtures(opts.fixturesDir), opts.fixtureIds);
  if (loaded.length === 0) {
    process.stderr.write(`no fixtures found under ${opts.fixturesDir}\n`);
    return 1;
  }

  let liveRunner: ClosableSpecifyTurnRunner | undefined;
  let baseRunner: SpecifyTurnRunner;
  const judgeLog: Array<{ fixtureId: string; attempt: number; verdict: SpecJudgeVerdict }> = [];
  if (opts.mode === "live") {
    if (opts.judge) {
      const judge = createSpecJudge({ provider: opts.judgeProvider, model: opts.judgeModel });
      liveRunner = createCritiqueReviseRunner({
        generator: { provider: opts.provider, model: opts.model },
        judge,
        maxRevisions: opts.maxRevisions,
        onJudgeVerdict: (fixtureId, verdict, attempt) =>
          judgeLog.push({ fixtureId, attempt, verdict }),
      });
    } else {
      liveRunner = createLiveRunner({ provider: opts.provider, model: opts.model });
    }
    baseRunner = liveRunner;
  } else {
    baseRunner = replayRunner;
  }

  const { runner, captured } = makeRecordingRunner(baseRunner);

  try {
    const fixtures = loaded.map((l) => l.fixture);
    const { results, summary } = await evaluateSpecifySuite(fixtures, runner);

    if (opts.record) {
      await persistRecordings(loaded, captured);
    }

    if (opts.json) {
      process.stdout.write(
        JSON.stringify(
          { mode: opts.mode, results, summary, judgeLog: opts.judge ? judgeLog : undefined },
          null,
          2,
        ) + "\n",
      );
    } else {
      process.stdout.write(renderText(results, summary, opts.mode));
      if (opts.judge) process.stdout.write(renderJudgeLog(judgeLog));
    }

    const fixtureById = new Map(fixtures.map((f) => [f.id, f]));
    const failed = results.filter((r) => {
      if (r.expectationMismatch) return true;
      if (r.status === "parse_error" || r.status === "schema_error") {
        const expected = fixtureById.get(r.id)?.expected?.status;
        if (expected !== r.status) return true;
      }
      return false;
    }).length;
    return failed > 0 ? 1 : 0;
  } finally {
    if (liveRunner) await liveRunner.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
      process.exit(1);
    },
  );
}
