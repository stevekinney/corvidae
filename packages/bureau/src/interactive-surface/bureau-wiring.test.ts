import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { MemoryStorage } from '@lostgradient/storage';
import { describe, expect, it } from 'bun:test';

import { createDurableEventHistory } from '../durable-event-history';
import type { TaskRegistry, TaskView } from '../task-registry';
import { createBureauInteractiveSurfaces } from './bureau-wiring';
import { INTERACTIVE_SURFACE_CONTRACT_VERSION } from './types';

const TASK = 'agent-run-1';

function registry(status: TaskView['status']): Pick<TaskRegistry, 'get' | 'onSettled'> {
  const view = { id: TASK, contextId: 'session-1', owner: 'api-key:alice', status };
  return {
    get: async () => view as unknown as TaskView,
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
      reviewIdsOf: async () => new Set([`approval:${TASK}:call-1`]),
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
