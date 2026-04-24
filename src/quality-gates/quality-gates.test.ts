import { describe, expect, it } from "vitest";
import { createInMemoryFakeQualityGateRunner } from "./fake.js";
import { createNodeQualityGateRunner } from "./index.js";
import { tmpdir } from "node:os";

describe("createNodeQualityGateRunner", () => {
  const runner = createNodeQualityGateRunner();
  const cwd = tmpdir();

  it("reports passed when the command exits 0", async () => {
    const r = await runner.run(
      { name: "echo", command: ["node", "-e", "process.exit(0)"] },
      { cwd },
    );
    expect(r.status).toBe("passed");
    expect(r.exitCode).toBe(0);
  });

  it("reports failed when the command exits non-zero", async () => {
    const r = await runner.run(
      { name: "fail", command: ["node", "-e", "process.exit(2)"] },
      { cwd },
    );
    expect(r.status).toBe("failed");
    expect(r.exitCode).toBe(2);
  });

  it("reports skipped when optional gates exit non-zero", async () => {
    const r = await runner.run(
      {
        name: "opt",
        command: ["node", "-e", "process.exit(1)"],
        optional: true,
      },
      { cwd },
    );
    expect(r.status).toBe("skipped");
  });

  it("truncates logs to 4 KiB", async () => {
    const r = await runner.run(
      {
        name: "log",
        command: [
          "node",
          "-e",
          "for(let i=0;i<1000;i++) process.stdout.write('x'.repeat(100)+'\\n')",
        ],
      },
      { cwd },
    );
    expect(Buffer.byteLength(r.logsTail, "utf8")).toBeLessThanOrEqual(4 * 1024);
  });

  it("kills the process on timeout and reports failed", async () => {
    const r = await runner.run(
      {
        name: "slow",
        command: ["node", "-e", "setTimeout(()=>{},5000)"],
        timeoutMs: 100,
      },
      { cwd },
    );
    expect(r.status).toBe("failed");
    expect(r.logsTail).toContain("timed out");
  });
});

describe("createInMemoryFakeQualityGateRunner", () => {
  it("returns scripted results and records events", async () => {
    const runner = createInMemoryFakeQualityGateRunner();
    runner.script("test", {
      status: "failed",
      exitCode: 1,
      logsTail: "boom",
    });
    const r = await runner.run(
      { name: "test", command: ["npm", "test"] },
      { cwd: "/tmp" },
    );
    expect(r.status).toBe("failed");
    expect(r.logsTail).toBe("boom");
    expect(runner.events).toHaveLength(1);
  });

  it("defaults to passed when no script is configured", async () => {
    const runner = createInMemoryFakeQualityGateRunner();
    const r = await runner.run(
      { name: "x", command: ["true"] },
      { cwd: "/tmp" },
    );
    expect(r.status).toBe("passed");
  });
});
