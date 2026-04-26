import { describe, expect, it, vi } from "vitest";
import { startWorker, runWorkerUntilShutdown } from "../worker.js";
import type { ResolvedNightShiftConfig } from "../../config/schema.js";

// Mock Temporal worker
const mockRun = vi.fn().mockResolvedValue(undefined);
const mockShutdown = vi.fn();
const mockWorkerCreate = vi.fn().mockResolvedValue({
  run: mockRun,
  shutdown: mockShutdown,
});
const mockConnect = vi.fn().mockResolvedValue({});

vi.mock("@temporalio/worker", () => ({
  Worker: {
    create: (...args: unknown[]) => mockWorkerCreate(...args),
  },
  NativeConnection: {
    connect: (...args: unknown[]) => mockConnect(...args),
  },
}));

const fakeConfig: ResolvedNightShiftConfig = {
  roles: {},
  temporal: {
    serverUrl: "localhost:7233",
    namespace: "test-ns",
    taskQueue: "test-queue",
  },
};

const fakeDepsFactory = {
  buildSpecifyDeps: vi.fn(),
  buildImplementDeps: vi.fn(),
  buildReviewDeps: vi.fn(),
};

describe("startWorker", () => {
  it("creates a worker with correct config", async () => {
    await startWorker({ config: fakeConfig, depsFactory: fakeDepsFactory });

    const workerOptions = mockWorkerCreate.mock.calls[0]?.[0];

    expect(mockConnect).toHaveBeenCalledWith({
      address: "localhost:7233",
    });

    expect(mockWorkerCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: "test-ns",
        taskQueue: "test-queue",
        workflowsPath: expect.stringMatching(/workflow\.ts$/),
      }),
    );

    expect(workerOptions?.bundlerOptions?.webpackConfigHook).toEqual(expect.any(Function));

    const hookedConfig = workerOptions?.bundlerOptions?.webpackConfigHook({});
    const rules = hookedConfig?.module?.rules;

    expect(Array.isArray(rules)).toBe(true);
    expect(rules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          test: expect.any(RegExp),
          use: [expect.objectContaining({ loader: expect.stringMatching(/temporal-typescript-loader\.cjs$/) })],
        }),
      ]),
    );
  });
});

describe("runWorkerUntilShutdown", () => {
  it("calls worker.run and resolves", async () => {
    const worker = {
      run: vi.fn().mockResolvedValue(undefined),
      shutdown: vi.fn(),
    };

    await runWorkerUntilShutdown(worker as any);
    expect(worker.run).toHaveBeenCalledOnce();
  });
});
