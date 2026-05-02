import assert from 'assert';
import { ScheduleOverlapPolicy } from '@temporalio/client';
import { describe, it } from 'mocha';
import type { ResolvedWorkerEntrypointConfig } from '../entrypoint-config';
import {
  closeWorkerConnections,
  PICKUP_SCHEDULE_ID,
  buildPickupScheduleOptions,
  ensurePickupSchedule,
  openWorkerConnections,
} from '../worker';

describe('worker pickup schedule bootstrap', () => {
  it('builds donor-style pickup schedule options from worker config', () => {
    assert.deepStrictEqual(buildPickupScheduleOptions(buildWorkerConfig()), {
      scheduleId: PICKUP_SCHEDULE_ID,
      spec: { intervals: [{ every: '10s' }] },
      action: {
        type: 'startWorkflow',
        workflowType: 'pickupWorkflow',
        taskQueue: 'test-queue',
        args: [{
          workflowInput: {
            projectOwner: 'acme',
            projectNumber: 42,
            backlogStatusName: 'Backlog',
            readyStatusName: 'Ready',
            inReviewStatusName: 'In review',
            blockedStatusName: 'Blocked',
            branchPrefix: 'orchestrator',
          },
          maxActions: 5,
        }],
      },
      policies: { overlap: ScheduleOverlapPolicy.SKIP },
      state: {},
    });
  });

  it('creates a pickup schedule and triggers it immediately on first startup', async () => {
    const calls: Array<{ type: string; value?: unknown }> = [];
    const options = buildPickupScheduleOptions(buildWorkerConfig());

    await ensurePickupSchedule({
      async stopLegacyPickupCronWorkflow() {
        calls.push({ type: 'stopLegacyPickupCronWorkflow' });
      },
      async createSchedule(value) {
        calls.push({ type: 'createSchedule', value });
      },
      async updateSchedule() {
        throw new Error('updateSchedule should not be called on first create');
      },
      async triggerSchedule() {
        throw new Error('triggerSchedule should not be called on first create');
      },
      isScheduleAlreadyRunning() {
        return false;
      },
    }, options);

    assert.deepStrictEqual(calls, [
      { type: 'stopLegacyPickupCronWorkflow' },
      {
        type: 'createSchedule',
        value: {
          ...options,
          state: { triggerImmediately: true },
        },
      },
    ]);
  });

  it('updates an existing pickup schedule and triggers a best-effort run', async () => {
    const calls: Array<{ type: string; value?: unknown }> = [];
    const options = buildPickupScheduleOptions(buildWorkerConfig());
    const alreadyRunning = new Error('schedule already exists');

    await ensurePickupSchedule({
      async stopLegacyPickupCronWorkflow() {
        calls.push({ type: 'stopLegacyPickupCronWorkflow' });
      },
      async createSchedule() {
        throw alreadyRunning;
      },
      async updateSchedule(value) {
        calls.push({ type: 'updateSchedule', value });
      },
      async triggerSchedule(value) {
        calls.push({ type: 'triggerSchedule', value });
      },
      isScheduleAlreadyRunning(error) {
        return error === alreadyRunning;
      },
    }, options);

    assert.deepStrictEqual(calls, [
      { type: 'stopLegacyPickupCronWorkflow' },
      { type: 'updateSchedule', value: options },
      { type: 'triggerSchedule', value: ScheduleOverlapPolicy.SKIP },
    ]);
  });

  it('closes the native connection if opening the signal connection fails', async () => {
    const calls: string[] = [];
    const connection = {
      async close() {
        calls.push('close-native');
      },
    };
    const connectError = new Error('signal connect failed');

    await assert.rejects(
      () => openWorkerConnections({
        connectNative: async () => {
          calls.push('connect-native');
          return connection;
        },
        connectSignal: async () => {
          calls.push('connect-signal');
          throw connectError;
        },
      }, buildWorkerConfig().temporal.address),
      (error: unknown) => error === connectError,
    );

    assert.deepStrictEqual(calls, ['connect-native', 'connect-signal', 'close-native']);
  });

  it('closes both worker connections even if signal connection cleanup fails', async () => {
    const calls: string[] = [];
    const signalCloseError = new Error('signal close failed');

    await assert.rejects(
      () => closeWorkerConnections(
        {
          async close() {
            calls.push('close-signal');
            throw signalCloseError;
          },
        },
        {
          async close() {
            calls.push('close-native');
          },
        },
      ),
      (error: unknown) => error === signalCloseError,
    );

    assert.deepStrictEqual(calls, ['close-signal', 'close-native']);
  });
});

function buildWorkerConfig(): ResolvedWorkerEntrypointConfig {
  return {
    temporal: {
      address: 'localhost:7233',
      namespace: 'agents',
      taskQueue: 'test-queue',
    },
    workflowInput: {
      projectOwner: 'acme',
      projectNumber: 42,
      backlogStatusName: 'Backlog',
      readyStatusName: 'Ready',
      inReviewStatusName: 'In review',
      blockedStatusName: 'Blocked',
      branchPrefix: 'orchestrator',
    },
    pickup: {
      enabled: true,
      intervalSeconds: 10,
      maxConcurrent: 5,
    },
  };
}