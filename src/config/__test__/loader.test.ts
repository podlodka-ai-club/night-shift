import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../loader.js";
import { DEFAULT_CONFIG, NightShiftConfigSchema } from "../schema.js";

let tmp: string;
let originalEnv: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "nightshift-cfg-"));
  originalEnv = process.env.NIGHT_SHIFT_CONFIG;
  delete process.env.NIGHT_SHIFT_CONFIG;
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  if (originalEnv === undefined) delete process.env.NIGHT_SHIFT_CONFIG;
  else process.env.NIGHT_SHIFT_CONFIG = originalEnv;
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

  it("rejects an invalid provider", async () => {
    const p = join(tmp, "night-shift.config.mjs");
    writeFileSync(
      p,
      `export default { roles: { implementer: { provider: "bogus", model: "m" } } };`,
    );
    await expect(loadConfig({ cwd: tmp })).rejects.toThrow();
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
      pickup: { enabled: true, intervalMinutes: 10, maxConcurrent: 3 },
    });
    expect(parsed.pickup).toEqual({ enabled: true, intervalMinutes: 10, maxConcurrent: 3 });
  });

  it("applies defaults when section is partial", () => {
    const parsed = NightShiftConfigSchema.parse({
      ...DEFAULT_CONFIG,
      pickup: { enabled: true },
    });
    expect(parsed.pickup).toEqual({ enabled: true, intervalMinutes: 5, maxConcurrent: 5 });
  });

  it("allows omitting pickup entirely", () => {
    const parsed = NightShiftConfigSchema.parse(DEFAULT_CONFIG);
    expect(parsed.pickup).toBeUndefined();
  });

  it("rejects intervalMinutes: 0", () => {
    expect(() =>
      NightShiftConfigSchema.parse({
        ...DEFAULT_CONFIG,
        pickup: { enabled: true, intervalMinutes: 0 },
      }),
    ).toThrow();
  });

  it("rejects non-divisor intervalMinutes (e.g., 7)", () => {
    expect(() =>
      NightShiftConfigSchema.parse({
        ...DEFAULT_CONFIG,
        pickup: { enabled: true, intervalMinutes: 7 },
      }),
    ).toThrow(/divisor of 60/);
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
