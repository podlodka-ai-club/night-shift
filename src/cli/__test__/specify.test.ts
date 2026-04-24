import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { main } from "../specify.js";

describe("cli specify", () => {
  const origWrite = process.stderr.write.bind(process.stderr);
  const origOut = process.stdout.write.bind(process.stdout);
  let errBuf = "";
  let outBuf = "";
  beforeEach(() => {
    errBuf = "";
    outBuf = "";
    process.stderr.write = ((chunk: string | Uint8Array) => {
      errBuf += chunk.toString();
      return true;
    }) as typeof process.stderr.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      outBuf += chunk.toString();
      return true;
    }) as typeof process.stdout.write;
  });
  afterEach(() => {
    process.stderr.write = origWrite;
    process.stdout.write = origOut;
  });

  it("--help prints usage and returns 0", async () => {
    const code = await main(["--help"]);
    expect(code).toBe(0);
    expect(outBuf).toContain("Usage:");
  });

  it("missing required args returns 64", async () => {
    const code = await main([]);
    expect(code).toBe(64);
    expect(errBuf).toContain("missing --item or --change");
  });

  it("unknown flag returns 64", async () => {
    const code = await main(["--item", "x", "--change", "y", "--bogus"]);
    expect(code).toBe(64);
    expect(errBuf).toContain("Usage");
  });
});
