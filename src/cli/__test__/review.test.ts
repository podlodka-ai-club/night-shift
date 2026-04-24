import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { main } from "../review.js";

describe("cli review", () => {
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

  it("missing positional arg returns 64", async () => {
    const code = await main([]);
    expect(code).toBe(64);
    expect(errBuf).toContain("missing <projectItemId>");
  });

  it("unknown flag returns 64", async () => {
    const code = await main(["PVTI_1", "--bogus"]);
    expect(code).toBe(64);
    expect(errBuf).toContain("Usage");
  });

  it("--iteration with negative number returns 64", async () => {
    const code = await main(["PVTI_1", "--iteration=-1"]);
    expect(code).toBe(64);
    expect(errBuf).toContain("non-negative integer");
  });

  it("--iteration with non-integer returns 64", async () => {
    const code = await main(["PVTI_1", "--iteration", "1.5"]);
    expect(code).toBe(64);
    expect(errBuf).toContain("non-negative integer");
  });
});
