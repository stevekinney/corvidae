import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { MemoryStorage } from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import { createDurableEventHistory } from '../durable-event-history';
import type { TaskRecord, TaskRegistry, TaskView } from '../task-registry';
import { createBureauInteractiveSurfaces } from './bureau-wiring';
import { INTERACTIVE_SURFACE_CONTRACT_VERSION } from './types';

const TASK = 'agent-run-1';

function registry(status: TaskView['status']): Pick<TaskRegistry, 'record' | 'get' | 'onSettled'> {
  const record = {
    taskId: TASK,
    contextId: 'session-1',
    owner: 'api-key:alice',
    settled: {
      status: 'completed',
      at: '2026-10-22T00:00:00.000Z',
      finishReason: null,
      message: null,
    },
  } as const satisfies Partial<TaskRecord>;
  return {
    record: async () => record as unknown as TaskRecord,
    get: async () => ({ status }) as unknown as TaskView,
    onSettled: () => () => undefined,
  };
}

describe('createBureauInteractiveSurfaces', () => {
  it('keeps a surface live while its task waits on a review, though its run has ended', async () => {
    const runtime = createManualRuntimeServices();
    const storage = new MemoryStorage();
    const surfaces = createBureauInteractiveSurfaces({
      storage,
      history: createDurableEventHistory(storage, runtime),
      tasks: registry('input-required'),
      now: () => runtime.clock.now(),
      diagnose: () => undefined,
    });
    if (surfaces === undefined) throw new Error('surfaces need storage and history');

    const receipt = await surfaces.create({
      type: 'surface.create',
      contractVersion: INTERACTIVE_SURFACE_CONTRACT_VERSION,
      commandId: 'create-1',
      taskId: TASK,
      surfaceId: 'approve',
      summary: 'Approve the deploy?',
      representation: { kind: 'input-form', schema: { type: 'object' } },
      actions: [
        {
          name: 'approve',
          intent: 'approve',
          continuation: { type: 'review', reviewId: `approval:${TASK}:call-1` },
        },
      ],
    });

    expect(receipt).toMatchObject({
      outcome: 'accepted',
      surface: { state: 'open', liveness: 'live' },
    });
  });
});
