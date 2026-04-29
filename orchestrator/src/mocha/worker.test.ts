import assert from 'assert';
import { ScheduleOverlapPolicy } from '@temporalio/client';
import { describe, it } from 'mocha';
import type { ResolvedWorkerEntrypointConfig } from '../entrypoint-config';
import {
  PICKUP_SCHEDULE_ID,
  buildPickupScheduleOptions,
  ensurePickupSchedule,
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
            filePathPrefix: 'orchestrator-runs',
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
      filePathPrefix: 'orchestrator-runs',
    },
    pickup: {
      enabled: true,
      intervalSeconds: 10,
      maxConcurrent: 5,
    },
  };
}