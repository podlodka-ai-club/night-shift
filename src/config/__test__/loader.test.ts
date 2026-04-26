import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defineNightShiftConfig } from "../index.js";
import { loadConfig } from "../loader.js";
import { DEFAULT_CONFIG, NightShiftConfigSchema } from "../schema.js";

let tmp: string;
let originalEnv: string | undefined;
let originalGithubToken: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "nightshift-cfg-"));
  originalEnv = process.env.NIGHT_SHIFT_CONFIG;
  originalGithubToken = process.env.GITHUB_TOKEN;
  delete process.env.NIGHT_SHIFT_CONFIG;
  delete process.env.GITHUB_TOKEN;
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  if (originalEnv === undefined) delete process.env.NIGHT_SHIFT_CONFIG;
  else process.env.NIGHT_SHIFT_CONFIG = originalEnv;
  if (originalGithubToken === undefined) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = originalGithubToken;
});

describe("loadConfig", () => {
  it("returns DEFAULT_CONFIG when no file is found", async () => {
    const cfg = await loadConfig({ cwd: tmp });
    expect(cfg.roles.specifier?.provider).toBe("codex");
    expect(cfg.roles.specifier?.model).toBe("gpt-5.4");
    expect(cfg.temporal).toEqual({
      serverUrl: "localhost:7233",
      namespace: "default",
      taskQueue: "night-shift",
    });
  });

  it("honours an explicit path", async () => {
    const p = join(tmp, "custom.config.mjs");
    writeFileSync(
      p,
      `export default { roles: { reviewer: { provider: "codex", model: "gpt-5.4-mini" } } };`,
    );
    const cfg = await loadConfig({ explicitPath: p });
    expect(cfg.roles.reviewer?.model).toBe("gpt-5.4-mini");
    // Defaults still present for other roles
    expect(cfg.roles.implementer?.model).toBe("gpt-5.4");
  });

  it("resolves repoRoot relative to the config file directory", async () => {
    const configDir = join(tmp, "configs");
    mkdirSync(configDir, { recursive: true });
    const p = join(configDir, "night-shift.config.mjs");
    writeFileSync(
      p,
      `export default { repoRoot: "../feature-factory", roles: { reviewer: { provider: "codex", model: "gpt-5.4-mini" } } };`,
    );

    const cfg = await loadConfig({ explicitPath: p });

    expect(cfg.repoRoot).toBe(join(tmp, "feature-factory"));
  });

  it("deep-merges a partial user config", async () => {
    const p = join(tmp, "night-shift.config.mjs");
    writeFileSync(
      p,
      `export default { roles: { reviewer: { provider: "codex", model: "gpt-5.4-mini" } } };`,
    );
    const cfg = await loadConfig({ cwd: tmp });
    expect(cfg.roles.reviewer?.model).toBe("gpt-5.4-mini");
    expect(cfg.roles.specifier?.model).toBe("gpt-5.4");
  });

  it("loads an adjacent .env file before importing the config", async () => {
    const p = join(tmp, "night-shift.config.mjs");
    writeFileSync(join(tmp, ".env"), "GITHUB_TOKEN=from-file\n");
    writeFileSync(
      p,
      `export default {
        github: {
          token: process.env.GITHUB_TOKEN,
          owner: "octo-org",
          repo: "octo-repo",
          projectNodeId: "PVT_123"
        }
      };`,
    );

    const cfg = await loadConfig({ cwd: tmp });

    expect(cfg.github?.token).toBe("from-file");
  });

  it("preserves process env values over an adjacent .env file", async () => {
    const p = join(tmp, "night-shift.config.mjs");
    process.env.GITHUB_TOKEN = "from-shell";
    writeFileSync(join(tmp, ".env"), "GITHUB_TOKEN=from-file\n");
    writeFileSync(
      p,
      `export default {
        github: {
          token: process.env.GITHUB_TOKEN,
          owner: "octo-org",
          repo: "octo-repo",
          projectNodeId: "PVT_123"
        }
      };`,
    );

    const cfg = await loadConfig({ cwd: tmp });

    expect(cfg.github?.token).toBe("from-shell");
  });

  it("accepts custom adapter registration when the role references it", async () => {
    const p = join(tmp, "night-shift.config.mjs");
    writeFileSync(
      p,
      `export default {
        adapterFactories: {
          custom: () => ({ provider: "custom", openSession() { throw new Error("unused"); } })
        },
        roles: { implementer: { provider: "custom", model: "gpt-5.4" } }
      };`,
    );

    const cfg = await loadConfig({ cwd: tmp });

    expect(cfg.roles.implementer?.provider).toBe("custom");
    expect(cfg.adapterFactories?.custom).toBeTypeOf("function");
  });

  it("rejects a reserved built-in adapter id in adapterFactories", async () => {
    const p = join(tmp, "night-shift.config.mjs");
    writeFileSync(
      p,
      `export default {
        adapterFactories: {
          codex: () => ({ provider: "codex", openSession() { throw new Error("unused"); } })
        }
      };`,
    );
    await expect(loadConfig({ cwd: tmp })).rejects.toThrow(/reserved built-in adapter id/);
  });

  it("rejects an invalid provider after registry validation", async () => {
    const p = join(tmp, "night-shift.config.mjs");
    writeFileSync(
      p,
      `export default { roles: { implementer: { provider: "bogus", model: "m" } } };`,
    );
    await expect(loadConfig({ cwd: tmp })).rejects.toThrow(/not a built-in or registered adapter/);
  });

  it("honours NIGHT_SHIFT_CONFIG env var when no explicit path", async () => {
    const p = join(tmp, "env.config.mjs");
    writeFileSync(
      p,
      `export default { roles: { specifier: { provider: "codex", model: "gpt-5.4-mini" } } };`,
    );
    process.env.NIGHT_SHIFT_CONFIG = p;
    const cfg = await loadConfig();
    expect(cfg.roles.specifier?.model).toBe("gpt-5.4-mini");
  });

  it("throws when an explicit path does not exist", async () => {
    await expect(
      loadConfig({ explicitPath: join(tmp, "does-not-exist.mjs") }),
    ).rejects.toThrow(/not found/);
  });
});

describe("TemporalConfigSchema", () => {
  it("defineNightShiftConfig returns its input unchanged", () => {
    const factory = () => ({ provider: "custom", openSession() { throw new Error("unused"); } });
    const cfg = defineNightShiftConfig({
      ...DEFAULT_CONFIG,
      adapterFactories: {
        custom: factory,
      },
    });

    expect(cfg.adapterFactories?.custom).toBe(factory);
  });

  it("applies defaults when temporal key is omitted", () => {
    const parsed = NightShiftConfigSchema.parse(DEFAULT_CONFIG);
    expect(parsed.temporal).toEqual({
      serverUrl: "localhost:7233",
      namespace: "default",
      taskQueue: "night-shift",
    });
  });

  it("custom values override defaults", () => {
    const parsed = NightShiftConfigSchema.parse({
      ...DEFAULT_CONFIG,
      temporal: { namespace: "prod" },
    });
    expect(parsed.temporal.namespace).toBe("prod");
    expect(parsed.temporal.serverUrl).toBe("localhost:7233");
    expect(parsed.temporal.taskQueue).toBe("night-shift");
  });
});

describe("PickupConfigSchema", () => {
  it("accepts valid pickup config", () => {
    const parsed = NightShiftConfigSchema.parse({
      ...DEFAULT_CONFIG,
      pickup: { enabled: true, intervalSeconds: 10, maxConcurrent: 3 },
    });
    expect(parsed.pickup).toEqual({ enabled: true, intervalSeconds: 10, maxConcurrent: 3 });
  });

  it("applies defaults when section is partial", () => {
    const parsed = NightShiftConfigSchema.parse({
      ...DEFAULT_CONFIG,
      pickup: { enabled: true },
    });
    expect(parsed.pickup).toEqual({ enabled: true, intervalSeconds: 10, maxConcurrent: 5 });
  });

  it("accepts legacy minute-based pickup config", () => {
    const parsed = NightShiftConfigSchema.parse({
      ...DEFAULT_CONFIG,
      pickup: { enabled: true, intervalMinutes: 1, maxConcurrent: 3 },
    });
    expect(parsed.pickup).toEqual({ enabled: true, intervalSeconds: 60, maxConcurrent: 3 });
  });

  it("allows omitting pickup entirely", () => {
    const parsed = NightShiftConfigSchema.parse(DEFAULT_CONFIG);
    expect(parsed.pickup).toBeUndefined();
  });

  it("rejects intervalSeconds: 0", () => {
    expect(() =>
      NightShiftConfigSchema.parse({
        ...DEFAULT_CONFIG,
        pickup: { enabled: true, intervalSeconds: 0 },
      }),
    ).toThrow();
  });

  it("rejects intervalMinutes: 0 in legacy configs", () => {
    expect(() =>
      NightShiftConfigSchema.parse({
        ...DEFAULT_CONFIG,
        pickup: { enabled: true, intervalMinutes: 0 },
      }),
    ).toThrow();
  });

  it("rejects maxConcurrent: 0", () => {
    expect(() =>
      NightShiftConfigSchema.parse({
        ...DEFAULT_CONFIG,
        pickup: { enabled: true, maxConcurrent: 0 },
      }),
    ).toThrow();
  });
});
