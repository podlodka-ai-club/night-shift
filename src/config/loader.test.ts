import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "./loader.js";
import { DEFAULT_CONFIG } from "./schema.js";

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
    expect(cfg).toEqual(DEFAULT_CONFIG);
    expect(cfg.roles.specifier?.provider).toBe("codex");
    expect(cfg.roles.specifier?.model).toBe("gpt-5.4");
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
