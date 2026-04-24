import { describe, expect, it } from "vitest";
import { createFakeOpenSpecCli } from "./openspec-cli.js";

describe("FakeOpenSpecCli", () => {
  it("consumes scripted responses in order and records calls", async () => {
    const cli = createFakeOpenSpecCli();
    cli.script([{ ok: true }, { ok: false, error: "boom" }]);
    const a = await cli.validate("x");
    const b = await cli.validate("y", { strict: false });
    expect(a).toEqual({ ok: true });
    expect(b).toEqual({ ok: false, error: "boom" });
    expect(cli.calls).toEqual([
      { name: "x", strict: true },
      { name: "y", strict: false },
    ]);
  });

  it("throws when the script is exhausted", async () => {
    const cli = createFakeOpenSpecCli();
    cli.script([]);
    await expect(cli.validate("x")).rejects.toThrow(/no scripted response/);
  });
});
