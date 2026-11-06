/**
 * The fleet feed's engine state events ask again for the views that read that state (COR-1725):
 * each kind in the table below names the entries it makes stale, built from `queryKeys` so a view's
 * key and the mapping cannot drift apart, and no other entry is touched.
 */
import { QueryClient, type QueryKey } from '@tanstack/svelte-query';
import { describe, expect, test } from 'bun:test';

import { queryKeys } from '../query.ts';
import { applyFleetEventFrame } from './cache-integration.ts';
import type { FleetEventFrame } from './fleet-event-source.svelte.ts';

const entries = {
  realms: queryKeys.realms(),
  lease: queryKeys.systemLease(),
  registry: queryKeys.registry(),
  registrySnapshot: queryKeys.registrySnapshot(),
  workers: queryKeys.workers.list(),
  manifests: queryKeys.workers.manifests(['worker-1']),
  rejections: queryKeys.workers.rejections(),
  deployments: queryKeys.workers.deployments(),
  taskDetail: queryKeys.tasks.detail('operation-1'),
  taskDeliveries: queryKeys.tasks.deliveries('operation-1'),
  queues: queryKeys.queues.list(),
  queueTasks: queryKeys.queues.tasks('reports', 'all'),
  conformance: queryKeys.conformance.targets(),
} satisfies Record<string, QueryKey>;

type EntryName = keyof typeof entries;

function frame(kind: string, workflowId?: string): FleetEventFrame {
  return {
    kind,
    ...(workflowId === undefined ? {} : { workflowId }),
    sequence: 1,
    cursor: '1',
    emittedAtMs: 0,
    payload: {},
  };
}

function seeded(): QueryClient {
  const queryClient = new QueryClient();
  for (const key of Object.values(entries)) queryClient.setQueryData(key, () => ({}));
  return queryClient;
}

function invalidated(queryClient: QueryClient): EntryName[] {
  return (Object.keys(entries) as EntryName[]).filter(
    (name) => queryClient.getQueryState(entries[name])?.isInvalidated === true,
  );
}

/** A queue's depth and the tasks listed on it move together. */
const queueEntries: EntryName[] = ['queues', 'queueTasks'];
const workerEntries: EntryName[] = [
  'workers',
  'manifests',
  'registry',
  'registrySnapshot',
  'deployments',
  ...queueEntries,
];

const TABLE: ReadonlyArray<readonly [string, readonly EntryName[]]> = [
  ['worker:connected', workerEntries],
  ['worker:disconnected', workerEntries],
  ['worker:registration-rejected', ['rejections']],
  // The work a build is bound to: a run starting or ending, a task queued or reaching a result.
  ['workflow:started', ['deployments']],
  ['workflow:completed', ['deployments']],
  ['workflow:failed', ['deployments']],
  ['workflow:cancelled', ['deployments']],
  ['workflow:timed-out', ['deployments']],
  ['activity:remote-queued', ['deployments']],
  ['activity:completed', ['deployments', ...queueEntries]],
  ['activity:failed', ['deployments', ...queueEntries]],
  ['task:dead-lettered', ['deployments', ...queueEntries]],
  // A queue's in-flight count is the tasks its workers hold: an attempt starting moves it.
  ['activity:started', queueEntries],
  ['worker:deployment-changed', ['deployments', 'workers']],
  ['queue:depth-changed', queueEntries],
  ['workflow:definition-registered', ['registry', 'registrySnapshot']],
  ['realm:state-changed', ['realms']],
  ['lease:health-changed', ['lease']],
];

describe('the engine’s state events', () => {
  for (const [kind, expected] of TABLE) {
    test(`${kind} asks again for ${expected.join(', ')} and nothing else`, () => {
      const queryClient = seeded();
      applyFleetEventFrame(queryClient, frame(kind));
      expect(invalidated(queryClient).toSorted()).toEqual([...expected].toSorted());
    });
  }

  test('a frame that also names a run is still read by its kind', () => {
    const queryClient = seeded();
    applyFleetEventFrame(queryClient, frame('realm:state-changed', 'workflow-1'));
    expect(invalidated(queryClient)).toEqual(['realms']);
  });

  test('a retention gap asks again for every one of them, and the task evidence', () => {
    const queryClient = seeded();
    applyFleetEventFrame(queryClient, frame('fleet:gap'));
    expect(invalidated(queryClient).toSorted()).toEqual(
      (Object.keys(entries) as EntryName[])
        // The conformance targets are static, not driven by this feed, so a gap leaves them alone.
        .filter((name) => name !== 'conformance')
        .toSorted(),
    );
  });

  test('a kind that is not one of them asks again for none', () => {
    const queryClient = seeded();
    applyFleetEventFrame(queryClient, frame('alert:fired'));
    expect(invalidated(queryClient)).toEqual([]);
  });
});
