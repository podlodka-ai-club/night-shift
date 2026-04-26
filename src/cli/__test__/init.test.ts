import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

    expect(code).toBe(0);
    expect(stdout).toContain(configPath);
    expect(stdout).toContain('npm install -g openspec');
    expect(stdout).toContain('openspec init .');
    expect(stdout).toContain('specifier: provider=codex, model=gpt-5.4');
    expect(stdout).toContain('repository itself, not from Night Shift config');
    expect(stdout).not.toContain(path.join(tmp, "openspec", "specs"));

    const content = readFileSync(configPath, "utf8");
    expect(content).toContain('defineNightShiftConfig');
    expect(content).toContain('const env = (');
    expect(content).toContain('token: env.GITHUB_TOKEN');
    expect(content).toContain('.env');
    expect(content).toContain('pickup: {');
    expect(content).toContain('enabled: true');
    expect(content).toContain('intervalSeconds: 10');
    expect(content).not.toContain('systemPromptFile');
    expect(content).toContain('adapterFactories');
    expect(content).not.toContain('skills');
    expect(existsSync(path.join(tmp, "openspec"))).toBe(false);
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

  it("does not scaffold OpenSpec when an existing config blocks init", async () => {
    const configPath = path.join(tmp, "night-shift.config.ts");
    writeFileSync(configPath, "existing\n", "utf8");

    const code = await main(["--repo-root", tmp]);

    expect(code).toBe(1);
    expect(stderr).toContain('already exists');
    expect(readFileSync(configPath, "utf8")).toBe("existing\n");
    expect(existsSync(path.join(tmp, "openspec"))).toBe(false);
  });
});