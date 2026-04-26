import { describe, expect, it, vi } from "vitest";
import { startPickupSchedule, startWorker, runWorkerUntilShutdown } from "../worker.js";
import type { ResolvedNightShiftConfig } from "../../config/schema.js";

const temporalClientMocks = vi.hoisted(() => ({
  ScheduleAlreadyRunning: class ScheduleAlreadyRunning extends Error {
    constructor(message: string, public readonly scheduleId: string) {
      super(message);
    }
  },
  WorkflowNotFoundError: class WorkflowNotFoundError extends Error {
    constructor(message: string, public readonly workflowId: string, public readonly runId?: string) {
      super(message);
    }
  },
  ScheduleOverlapPolicy: {
    SKIP: "SKIP",
  },
}));

// Mock Temporal worker
const mockRun = vi.fn().mockResolvedValue(undefined);
const mockShutdown = vi.fn();
const mockWorkerCreate = vi.fn().mockResolvedValue({
  run: mockRun,
  shutdown: mockShutdown,
});
const mockConnect = vi.fn().mockResolvedValue({});
const mockScheduleCreate = vi.fn();
const mockScheduleUpdate = vi.fn();
const mockScheduleTrigger = vi.fn();
const mockWorkflowTerminate = vi.fn();

vi.mock("@temporalio/client", () => ({
  Connection: {
    connect: (...args: unknown[]) => mockConnect(...args),
  },
  Client: vi.fn().mockImplementation(() => ({
    workflow: {
      getHandle: vi.fn(() => ({
        terminate: (...args: unknown[]) => mockWorkflowTerminate(...args),
      })),
    },
  })),
  ScheduleClient: vi.fn().mockImplementation(() => ({
    create: (...args: unknown[]) => mockScheduleCreate(...args),
    getHandle: vi.fn(() => ({
      update: (...args: unknown[]) => mockScheduleUpdate(...args),
      trigger: (...args: unknown[]) => mockScheduleTrigger(...args),
    })),
  })),
  ScheduleAlreadyRunning: temporalClientMocks.ScheduleAlreadyRunning,
  ScheduleOverlapPolicy: temporalClientMocks.ScheduleOverlapPolicy,
  WorkflowNotFoundError: temporalClientMocks.WorkflowNotFoundError,
}));

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
  pickup: {
    enabled: true,
    intervalSeconds: 10,
    maxConcurrent: 2,
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

describe("startPickupSchedule", () => {
  it("creates a pickup schedule and triggers it immediately on create", async () => {
    mockWorkflowTerminate.mockRejectedValueOnce(new temporalClientMocks.WorkflowNotFoundError("missing", "pickup-cron"));
    mockScheduleCreate.mockResolvedValueOnce(undefined);

    await startPickupSchedule({ config: fakeConfig });

    expect(mockConnect).toHaveBeenCalledWith({
      address: "localhost:7233",
    });
    expect(mockScheduleCreate).toHaveBeenCalledWith({
      scheduleId: "pickup-schedule",
      spec: { intervals: [{ every: "10s" }] },
      action: {
        type: "startWorkflow",
        workflowType: "pickupWorkflow",
        taskQueue: "test-queue",
        args: [2],
      },
      policies: {
        overlap: temporalClientMocks.ScheduleOverlapPolicy.SKIP,
      },
      state: { triggerImmediately: true },
    });
    expect(mockScheduleUpdate).not.toHaveBeenCalled();
    expect(mockScheduleTrigger).not.toHaveBeenCalled();
  });

  it("updates an existing schedule and triggers a best-effort run", async () => {
    mockWorkflowTerminate.mockResolvedValueOnce(undefined);
    mockScheduleCreate.mockRejectedValueOnce(
      new temporalClientMocks.ScheduleAlreadyRunning("exists", "pickup-schedule"),
    );
    mockScheduleUpdate.mockResolvedValueOnce(undefined);
    mockScheduleTrigger.mockResolvedValueOnce(undefined);

    await startPickupSchedule({ config: fakeConfig });

    expect(mockWorkflowTerminate).toHaveBeenCalledWith("Pickup cron migrated to schedule");
    expect(mockScheduleUpdate).toHaveBeenCalledOnce();
    const updateFn = mockScheduleUpdate.mock.calls[0]?.[0] as (() => unknown) | undefined;
    expect(updateFn?.()).toEqual({
      scheduleId: "pickup-schedule",
      spec: { intervals: [{ every: "10s" }] },
      action: {
        type: "startWorkflow",
        workflowType: "pickupWorkflow",
        taskQueue: "test-queue",
        args: [2],
      },
      policies: {
        overlap: temporalClientMocks.ScheduleOverlapPolicy.SKIP,
      },
    });
    expect(mockScheduleTrigger).toHaveBeenCalledWith(temporalClientMocks.ScheduleOverlapPolicy.SKIP);
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
