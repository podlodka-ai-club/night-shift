import { beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../create-ticket.js";

vi.mock("../../config/loader.js", () => ({
  loadConfig: vi.fn().mockResolvedValue({
    roles: {},
    temporal: { serverUrl: "localhost:7233", namespace: "default", taskQueue: "night-shift" },
  }),
}));

const mockCreateProjectTicket = vi.fn().mockResolvedValue({
  itemId: "PVTI_42",
  projectNodeId: "PVT_1",
  ticketId: "42",
  title: "Improve workflow ticket utility",
  issueNumber: 42,
  status: "Ready",
  issueUrl: "https://github.com/org-55/feature-factory/issues/42",
});

vi.mock("../../github/factory.js", () => ({
  createGitHubClient: vi.fn().mockResolvedValue({
    createProjectTicket: (...args: unknown[]) => mockCreateProjectTicket(...args),
  }),
}));

let stdout = "";
let stderr = "";

beforeEach(() => {
  stdout = "";
  stderr = "";
  vi.spyOn(process.stdout, "write").mockImplementation((s) => {
    stdout += s;
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((s) => {
    stderr += s;
    return true;
  });
  mockCreateProjectTicket.mockReset().mockResolvedValue({
    itemId: "PVTI_42",
    projectNodeId: "PVT_1",
    ticketId: "42",
    title: "Improve workflow ticket utility",
    issueNumber: 42,
    status: "Ready",
    issueUrl: "https://github.com/org-55/feature-factory/issues/42",
  });
});

describe("night-shift create-ticket CLI", () => {
  it("creates a project ticket and prints the derived change name", async () => {
    const code = await main([
      "--title",
      "Improve workflow ticket utility",
      "--status",
      "Ready",
    ]);

    expect(code).toBe(0);
    expect(mockCreateProjectTicket).toHaveBeenCalledWith({
      title: "Improve workflow ticket utility",
      status: "Ready",
    });
    expect(stdout).toContain("PVTI_42");
    expect(stdout).toContain("improve-workflow-ticket-utility-42");
    expect(stdout).toContain(
      "npm exec night-shift -- start PVTI_42 --change improve-workflow-ticket-utility-42",
    );
  });

  it("supports JSON output", async () => {
    const code = await main([
      "--title",
      "Improve workflow ticket utility",
      "--status",
      "Ready",
      "--json",
    ]);

    expect(code).toBe(0);
    expect(stdout).toContain('"itemId": "PVTI_42"');
    expect(stdout).toContain(
      '"changeName": "improve-workflow-ticket-utility-42"',
    );
  });

  it("requires --title", async () => {
    const code = await main([]);
    expect(code).toBe(64);
    expect(stderr).toContain("missing --title");
  });

  it("rejects invalid status values", async () => {
    const code = await main(["--title", "x", "--status", "Mystery"]);
    expect(code).toBe(64);
    expect(stderr).toContain("invalid --status value");
  });

  it("uses --repo-root for repo-local config discovery", async () => {
    const code = await main(["--title", "x", "--repo-root", "/tmp/app"]);

    expect(code).toBe(0);
    const { loadConfig } = await import("../../config/loader.js");
    expect(loadConfig).toHaveBeenCalledWith({ cwd: "/tmp/app" });
  });
});