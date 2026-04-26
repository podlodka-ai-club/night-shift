import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyRepoLocalConfigIsolation, resolveSelectedRepoRoot } from "../shared.js";

describe("repo-local config isolation", () => {
  it("resolves the selected repo root against cwd", () => {
    expect(resolveSelectedRepoRoot("../target", "/tmp/night-shift")).toBe(
      path.resolve("/tmp/night-shift", "../target"),
    );
  });

  it("scopes the temporal task queue to the repo root", () => {
    const config = {
      roles: {},
      temporal: {
        serverUrl: "localhost:7233",
        namespace: "default",
        taskQueue: "night-shift",
      },
    };

    const isolated = applyRepoLocalConfigIsolation(config as any, "/tmp/repo-a");
    const sameRepo = applyRepoLocalConfigIsolation(config as any, "/tmp/repo-a");
    const otherRepo = applyRepoLocalConfigIsolation(config as any, "/tmp/repo-b");

    expect(isolated.temporal.taskQueue).toMatch(/^night-shift-[a-f0-9]{12}$/);
    expect(sameRepo.temporal.taskQueue).toBe(isolated.temporal.taskQueue);
    expect(otherRepo.temporal.taskQueue).not.toBe(isolated.temporal.taskQueue);
  });
});