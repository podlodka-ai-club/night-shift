import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "../init.js";

describe("night-shift init CLI", () => {
  let tmp: string;
  let stdout = "";
  let stderr = "";
  const origWrite = process.stderr.write.bind(process.stderr);
  const origOut = process.stdout.write.bind(process.stdout);

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "night-shift-init-"));
    stdout = "";
    stderr = "";
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr += chunk.toString();
      return true;
    }) as typeof process.stderr.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout += chunk.toString();
      return true;
    }) as typeof process.stdout.write;
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    process.stderr.write = origWrite;
    process.stdout.write = origOut;
  });

  it("creates a repo-local config template", async () => {
    const code = await main(["--repo-root", tmp]);
    const configPath = path.join(tmp, "night-shift.config.ts");
    const projectPath = path.join(tmp, "openspec", "project.md");

    expect(code).toBe(0);
    expect(stdout).toContain(configPath);
    expect(stdout).toContain(path.join(tmp, "openspec", "specs"));
    expect(stdout).toContain(path.join(tmp, "openspec", "changes"));
    expect(stdout).toContain(projectPath);

    const content = readFileSync(configPath, "utf8");
    expect(content).toContain('defineNightShiftConfig');
    expect(content).toContain('process.env.GITHUB_TOKEN');
    expect(content).toContain('.env');
    expect(content).toContain('adapterFactories');
    expect(content).toContain('openspec-propose');
    expect(content).toContain('openspec-apply-change');

    expect(readFileSync(projectPath, "utf8")).toContain('Bootstrapped by');
  });

  it("does not overwrite an existing config without --force", async () => {
    const configPath = path.join(tmp, "night-shift.config.ts");
    const specsDir = path.join(tmp, "openspec", "specs");
    const changesDir = path.join(tmp, "openspec", "changes");
    const projectPath = path.join(tmp, "openspec", "project.md");
    writeFileSync(configPath, "existing\n", "utf8");
    mkdirSync(specsDir, { recursive: true });
    mkdirSync(changesDir, { recursive: true });
    writeFileSync(projectPath, "# Existing project\n", "utf8");
    writeFileSync(path.join(specsDir, ".keep"), "", "utf8");
    writeFileSync(path.join(changesDir, ".keep"), "", "utf8");

    const code = await main(["--repo-root", tmp]);

    expect(code).toBe(1);
    expect(stderr).toContain('already exists');
    expect(readFileSync(configPath, "utf8")).toBe("existing\n");
  });

  it("scaffolds missing OpenSpec files without overwriting an existing config", async () => {
    const configPath = path.join(tmp, "night-shift.config.ts");
    const specsDir = path.join(tmp, "openspec", "specs");
    const changesDir = path.join(tmp, "openspec", "changes");
    const projectPath = path.join(tmp, "openspec", "project.md");
    writeFileSync(configPath, "existing\n", "utf8");

    const code = await main(["--repo-root", tmp]);

    expect(code).toBe(0);
    expect(stderr).toContain('Keeping it and scaffolding missing OpenSpec files');
    expect(readFileSync(configPath, "utf8")).toBe("existing\n");
    expect(stdout).toContain(specsDir);
    expect(stdout).toContain(changesDir);
    expect(stdout).toContain(projectPath);
  });
});