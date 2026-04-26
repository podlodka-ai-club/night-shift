import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockWorkerMain = vi.fn().mockResolvedValue(0);

vi.mock("../worker.js", () => ({
  main: (...args: unknown[]) => mockWorkerMain(...args),
}));

vi.mock("../create-ticket.js", () => ({ main: vi.fn().mockResolvedValue(0) }));
vi.mock("../implement.js", () => ({ main: vi.fn().mockResolvedValue(0) }));
vi.mock("../init.js", () => ({ main: vi.fn().mockResolvedValue(0) }));
vi.mock("../pickup.js", () => ({ main: vi.fn().mockResolvedValue(0) }));
vi.mock("../review.js", () => ({ main: vi.fn().mockResolvedValue(0) }));
vi.mock("../specify.js", () => ({ main: vi.fn().mockResolvedValue(0) }));
vi.mock("../start.js", () => ({ main: vi.fn().mockResolvedValue(0) }));

import { main } from "../night-shift.js";

describe("night-shift dispatcher", () => {
  let stdout = "";
  let stderr = "";

  beforeEach(() => {
    stdout = "";
    stderr = "";
    vi.spyOn(process.stdout, "write").mockImplementation((s) => { stdout += String(s); return true; });
    vi.spyOn(process.stderr, "write").mockImplementation((s) => { stderr += String(s); return true; });
    mockWorkerMain.mockReset().mockResolvedValue(0);
  });

  it("prints help with no command", async () => {
    const code = await main([]);
    expect(code).toBe(0);
    expect(stdout).toContain("Usage:");
  });

  it("dispatches subcommands", async () => {
    const code = await main(["worker", "--help"]);
    expect(code).toBe(0);
    expect(mockWorkerMain).toHaveBeenCalledWith(["--help"], process.env);
  });

  it("returns 64 for unknown commands", async () => {
    const code = await main(["bogus"]);
    expect(code).toBe(64);
    expect(stderr).toContain("Unknown command");
  });

  it("declares the packaged night-shift binary", () => {
    const pkg = JSON.parse(
      readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
    ) as { bin?: Record<string, string> };

    expect(pkg.bin?.["night-shift"]).toBe("./bin/night-shift.js");
  });
});