import { spawn } from "node:child_process";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";

export const QualityGateSchema = z.object({
  name: z.string().min(1),
  /** Shell-free: first arg is the command, the rest are argv. */
  command: z.array(z.string().min(1)).min(1),
  /** Optional working directory override (defaults to runner cwd). */
  cwd: z.string().optional(),
  /** Optional per-gate timeout override in ms. */
  timeoutMs: z.number().int().positive().optional(),
  /** When true, a non-zero exit is reported as `skipped` instead of `failed`. */
  optional: z.boolean().optional(),
});
export type QualityGate = z.infer<typeof QualityGateSchema>;

export const QualityGateResultSchema = z.object({
  name: z.string(),
  status: z.enum(["passed", "failed", "skipped"]),
  exitCode: z.number().int().nullable(),
  durationMs: z.number().int().nonnegative(),
  logsTail: z.string(),
});
export type QualityGateResult = z.infer<typeof QualityGateResultSchema>;

export interface QualityGateRunner {
  run(gate: QualityGate, opts: { cwd: string }): Promise<QualityGateResult>;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const MAX_LOGS_TAIL_BYTES = 4 * 1024; // 4 KiB

function tail(buf: Buffer): string {
  if (buf.byteLength <= MAX_LOGS_TAIL_BYTES) return buf.toString("utf8");
  return buf.subarray(buf.byteLength - MAX_LOGS_TAIL_BYTES).toString("utf8");
}

export interface NodeQualityGateRunnerDeps {
  /** Override default per-gate timeout (10 minutes). */
  defaultTimeoutMs?: number;
}

export function createNodeQualityGateRunner(
  deps: NodeQualityGateRunnerDeps = {},
): QualityGateRunner {
  const defaultTimeoutMs = deps.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    async run(gate, opts) {
      const timeoutMs = gate.timeoutMs ?? defaultTimeoutMs;
      const started = Date.now();
      const [cmd, ...args] = gate.command;
      const cwd = gate.cwd
        ? path.isAbsolute(gate.cwd)
          ? gate.cwd
          : path.join(opts.cwd, gate.cwd)
        : opts.cwd;
      return await new Promise<QualityGateResult>((resolve) => {
        const child = spawn(cmd!, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
        const chunks: Buffer[] = [];
        let timedOut = false;
        const onData = (b: Buffer) => chunks.push(b);
        child.stdout?.on("data", onData);
        child.stderr?.on("data", onData);

        const ac = new AbortController();
        void delay(timeoutMs, undefined, { signal: ac.signal })
          .then(() => {
            timedOut = true;
            chunks.push(Buffer.from(`\n[night-shift] gate timed out after ${timeoutMs}ms\n`));
            child.kill("SIGKILL");
          })
          .catch(() => {});

        child.on("error", (err) => {
          ac.abort();
          chunks.push(Buffer.from(`\n[night-shift] spawn error: ${err.message}\n`));
          resolve({
            name: gate.name,
            status: gate.optional ? "skipped" : "failed",
            exitCode: null,
            durationMs: Date.now() - started,
            logsTail: tail(Buffer.concat(chunks)),
          });
        });

        child.on("close", (code) => {
          ac.abort();
          const exitCode = code ?? null;
          let status: QualityGateResult["status"];
          if (timedOut) status = "failed";
          else if (exitCode === 0) status = "passed";
          else status = gate.optional ? "skipped" : "failed";
          resolve({
            name: gate.name,
            status,
            exitCode,
            durationMs: Date.now() - started,
            logsTail: tail(Buffer.concat(chunks)),
          });
        });
      });
    },
  };
}
