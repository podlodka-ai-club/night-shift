import { spawn } from "node:child_process";

export type OpenSpecValidateResult =
  | { ok: true }
  | { ok: false; error: string };

export interface OpenSpecCli {
  /**
   * Run `openspec change validate <name> --strict` (or equivalent) against the
   * current working directory. Resolves `{ ok: true }` on exit code 0 and
   * `{ ok: false, error }` on any non-zero exit with combined stdout/stderr.
   */
  validate(
    name: string,
    opts?: { strict?: boolean; cwd?: string },
  ): Promise<OpenSpecValidateResult>;
}

export interface CreateOpenSpecCliDeps {
  /** Binary to invoke. Defaults to `npx`. */
  bin?: string;
  /** Extra leading args (e.g. `["openspec"]` when bin is `npx`). */
  baseArgs?: string[];
}

/**
 * Real openspec CLI wrapper — shells out to `npx openspec change validate`.
 */
export function createOpenSpecCli(deps: CreateOpenSpecCliDeps = {}): OpenSpecCli {
  const bin = deps.bin ?? "npx";
  const baseArgs = deps.baseArgs ?? ["openspec"];
  return {
    async validate(name, opts = {}) {
      const args = [...baseArgs, "change", "validate", name];
      if (opts.strict !== false) args.push("--strict");
      return await new Promise<OpenSpecValidateResult>((resolve) => {
        const child = spawn(bin, args, {
          cwd: opts.cwd ?? process.cwd(),
          stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        let err = "";
        child.stdout.on("data", (d: Buffer) => {
          out += d.toString("utf8");
        });
        child.stderr.on("data", (d: Buffer) => {
          err += d.toString("utf8");
        });
        child.on("error", (e) =>
          resolve({ ok: false, error: `failed to spawn ${bin}: ${e.message}` }),
        );
        child.on("close", (code) => {
          if (code === 0) resolve({ ok: true });
          else
            resolve({
              ok: false,
              error: (err || out || `exit ${code}`).trim(),
            });
        });
      });
    },
  };
}

export interface FakeOpenSpecCli extends OpenSpecCli {
  /** Scripted responses consumed in FIFO order. */
  script(responses: OpenSpecValidateResult[]): void;
  readonly calls: ReadonlyArray<{ name: string; strict: boolean }>;
}

/**
 * In-memory fake. Pushes a list of scripted responses; each call to
 * `validate` consumes the next one. Throws if the script is empty.
 */
export function createFakeOpenSpecCli(): FakeOpenSpecCli {
  let queue: OpenSpecValidateResult[] = [];
  const calls: Array<{ name: string; strict: boolean }> = [];
  return {
    script(responses) {
      queue = [...responses];
    },
    get calls() {
      return calls;
    },
    async validate(name, opts = {}) {
      calls.push({ name, strict: opts.strict !== false });
      const r = queue.shift();
      if (!r) throw new Error(`FakeOpenSpecCli: no scripted response for ${name}`);
      return r;
    },
  };
}
