/** The repair's decision (COR-1669, part 2b-3): which histories have lost the end of a task. */
import { describe, expect, it } from 'bun:test';

import { bearsSettlement, createTaskResync } from './task-resync.ts';
import type { TaskRecord, TaskView } from './task-registry.ts';

const record: TaskRecord = {
  schemaVersion: 1,
  taskId: 'run-1',
  contextId: 'session-1',
  incarnation: 'incarnation-1',
  agentName: 'default',
  owner: 'api-key:alice',
  createdAt: '2026-10-18T00:00:00.000Z',
  history: [],
  settled: {
    at: '2026-10-18T00:00:05.000Z',
    status: 'completed',
    finishReason: 'stop',
    message: null,
  },
};

const view: TaskView = {
  id: 'run-1',
  contextId: 'session-1',
  agentName: 'default',
  owner: 'api-key:alice',
  actor: null,
  kind: 'chat',
  origin: null,
  status: 'completed',
  finishReason: 'stop',
  statusMessage: null,
  createdAt: record.createdAt,
  updatedAt: '2026-10-18T00:00:05.000Z',
  cleanup: null,
  openWaits: [],
};

/** A repair over one settled record whose history holds `kinds`; resolves what it appended. */
async function repairWith(kinds: readonly string[]): Promise<string[]> {
  const appended: string[] = [];
  const resync = createTaskResync({
    tasks: {
      get: async () => view,
      record: async () => record,
      resyncCandidates: async () => [record],
      markResyncPending: async () => true,
      clearResyncPending: async () => true,
    },
    history: {
      page: async () =>
        ({
          events: kinds.map((kind, index) => ({
            kind,
            cursor: String(index),
            payload: {},
            emittedAtMs: 1,
          })),
          hasMore: false,
        }) as never,
      record: async (_owner, kind) => {
        appended.push(kind);
        return {} as never;
      },
      retentionFloorTimestamp: async () => 0,
    },
    producer: { serialize: async (_owner, work) => work() },
    diagnose: () => undefined,
  });
  await resync.repairAll();
  return appended;
}

describe('which histories have lost the end of a task', () => {
  it('does not count a tripwire as the end: the run.completed that follows it may be the lost one', async () => {
    expect(bearsSettlement({ kind: 'run.tripwire', payload: {} })).toBe(false);
    expect(await repairWith(['session.created', 'run.tripwire'])).toEqual(['task.resynced']);
  });

  it('repairs nothing when a terminal event is there, and counts each terminal kind', async () => {
    for (const kind of ['run.completed', 'run.error', 'run.aborted']) {
      expect(bearsSettlement({ kind, payload: {} })).toBe(true);
      expect(await repairWith(['run.tripwire', kind])).toEqual([]);
    }
  });
});
