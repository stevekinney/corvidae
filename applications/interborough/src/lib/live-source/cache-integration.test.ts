import {
  WorkflowCompletedEvent,
  WorkflowStartedEvent,
  type WorkflowEvent,
  type WorkflowStatus,
} from '@lostgradient/weft';
import { QueryClient } from '@tanstack/svelte-query';
import { describe, expect, test } from 'bun:test';

import { updateHistoryQueryKey } from '../../routes/workflows/detail/updates/updates-data.ts';
import {
  applyFleetEventFrame,
  applyScheduleFleetFrame,
  applyWorkflowTailFrame,
  REVIEWS_LIST_KEY_PREFIX,
  SCHEDULES_DETAIL_KEY_PREFIX,
  SCHEDULES_LIST_KEY_PREFIX,
  SCHEDULES_RUN_HISTORY_KEY_PREFIX,
  WORKERS_LIST_KEY,
  workflowDetailKey,
  workflowEventsKey,
  workflowFinalizerKey,
  WORKFLOWS_AGGREGATE_KEY_PREFIX,
  WORKFLOWS_LIST_KEY_PREFIX,
  workflowUpdatesKey,
} from './cache-integration.ts';
import type { FleetEventFrame } from './fleet-event-source.svelte.ts';

function event(type: string, timestamp = 0, data: Record<string, unknown> = {}): WorkflowEvent {
  return { type, timestamp, data };
}

describe('workflowDetailKey / workflowEventsKey', () => {
  test('produce the documented array shapes', () => {
    expect(workflowDetailKey('wf_1')).toEqual(['workflows', 'detail', 'wf_1']);
    expect(workflowEventsKey('wf_1')).toEqual(['workflows', 'events', 'wf_1']);
  });
});

describe('applyWorkflowTailFrame', () => {
  test('creates the events cache on the first frame', () => {
    const queryClient = new QueryClient();
    const frame = event('activity:started', 100, { name: 'a' });
    applyWorkflowTailFrame(queryClient, 'wf_1', frame);
    expect(queryClient.getQueryData<WorkflowEvent[]>(workflowEventsKey('wf_1'))).toEqual([frame]);
  });

  test('appends subsequent frames to the existing events cache', () => {
    const queryClient = new QueryClient();
    const first = event('activity:started', 100);
    const second = event('activity:completed', 200);
    applyWorkflowTailFrame(queryClient, 'wf_1', first);
    applyWorkflowTailFrame(queryClient, 'wf_1', second);
    expect(queryClient.getQueryData<WorkflowEvent[]>(workflowEventsKey('wf_1'))).toEqual([
      first,
      second,
    ]);
  });

  test("does not touch a different workflow's events cache", () => {
    const queryClient = new QueryClient();
    applyWorkflowTailFrame(queryClient, 'wf_1', event('activity:started', 100));
    expect(queryClient.getQueryData(workflowEventsKey('wf_2'))).toBeUndefined();
  });

  test("patches an already-cached detail's status/updatedAt on a lifecycle event", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(workflowDetailKey('wf_1'), () => ({
      id: 'wf_1',
      status: 'running' as WorkflowStatus,
      updatedAt: 1,
      unrelatedField: 'kept',
    }));

    applyWorkflowTailFrame(queryClient, 'wf_1', event(WorkflowCompletedEvent.type, 500));

    expect(queryClient.getQueryData<Record<string, unknown>>(workflowDetailKey('wf_1'))).toEqual({
      id: 'wf_1',
      status: 'completed',
      updatedAt: 500,
      unrelatedField: 'kept',
    });
  });

  test('does not create a detail cache entry that was never fetched (setQueryData no-op on cache miss)', () => {
    const queryClient = new QueryClient();
    applyWorkflowTailFrame(queryClient, 'wf_1', event(WorkflowStartedEvent.type, 100));
    expect(queryClient.getQueryData(workflowDetailKey('wf_1'))).toBeUndefined();
  });

  test('leaves the detail cache untouched for event types with no status mapping', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(workflowDetailKey('wf_1'), () => ({
      status: 'running' as WorkflowStatus,
      updatedAt: 1,
    }));
    applyWorkflowTailFrame(queryClient, 'wf_1', event('activity:started', 999));
    expect(queryClient.getQueryData<Record<string, unknown>>(workflowDetailKey('wf_1'))).toEqual({
      status: 'running',
      updatedAt: 1,
    });
  });
});

function fleetFrame(
  overrides: Partial<FleetEventFrame> & Pick<FleetEventFrame, 'kind'>,
): FleetEventFrame {
  return {
    sequence: 1,
    cursor: '1',
    emittedAtMs: 0,
    payload: {},
    ...overrides,
  };
}

describe('applyFleetEventFrame', () => {
  test('a workflow-scoped frame invalidates the workflow detail — never the events append cache, or the list and aggregate a person reads at their own pace', async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(WORKFLOWS_LIST_KEY_PREFIX, () => []);
    queryClient.setQueryData(WORKFLOWS_AGGREGATE_KEY_PREFIX, () => []);
    queryClient.setQueryData(workflowDetailKey('wf_1'), () => ({}));
    queryClient.setQueryData(workflowEventsKey('wf_1'), () => []);

    applyFleetEventFrame(
      queryClient,
      fleetFrame({ kind: 'workflow:completed', workflowId: 'wf_1' }),
    );

    // The shell applies every frame; the list's Live toggle (`workflow-list-live.svelte.ts`) is what
    // refreshes the list, so a frame must not reflow it under a person.
    expect(queryClient.getQueryState(WORKFLOWS_LIST_KEY_PREFIX)?.isInvalidated).toBeFalsy();
    expect(queryClient.getQueryState(WORKFLOWS_AGGREGATE_KEY_PREFIX)?.isInvalidated).toBeFalsy();
    expect(queryClient.getQueryState(workflowDetailKey('wf_1'))?.isInvalidated).toBe(true);
    // Fleet frames never append into the live-tail events cache (module doc).
    expect(queryClient.getQueryState(workflowEventsKey('wf_1'))?.isInvalidated).toBeFalsy();
  });

  test("a workflow-scoped frame also invalidates that workflow's finalizer query (weft#732 item 4)", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(workflowFinalizerKey('wf_1'), () => null);
    applyFleetEventFrame(
      queryClient,
      fleetFrame({ kind: 'workflow:teardown', workflowId: 'wf_1' }),
    );
    expect(queryClient.getQueryState(workflowFinalizerKey('wf_1'))?.isInvalidated).toBe(true);
  });

  test("a workflow-scoped frame does not invalidate a different workflow's detail cache", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(workflowDetailKey('wf_2'), () => ({}));
    applyFleetEventFrame(queryClient, fleetFrame({ kind: 'workflow:started', workflowId: 'wf_1' }));
    expect(queryClient.getQueryState(workflowDetailKey('wf_2'))?.isInvalidated).toBeFalsy();
  });

  test('schedule:fired invalidates the schedules list', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(SCHEDULES_LIST_KEY_PREFIX, () => []);
    applyFleetEventFrame(queryClient, fleetFrame({ kind: 'schedule:fired' }));
    expect(queryClient.getQueryState(SCHEDULES_LIST_KEY_PREFIX)?.isInvalidated).toBe(true);
  });

  test('human-review:requested invalidates the reviews list', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(REVIEWS_LIST_KEY_PREFIX, () => []);
    applyFleetEventFrame(queryClient, fleetFrame({ kind: 'human-review:requested' }));
    expect(queryClient.getQueryState(REVIEWS_LIST_KEY_PREFIX)?.isInvalidated).toBe(true);
  });

  test('a review frame invalidates the reviews list whether or not it names a workflow', () => {
    for (const workflowId of [undefined, 'wf_1']) {
      const queryClient = new QueryClient();
      queryClient.setQueryData(REVIEWS_LIST_KEY_PREFIX, () => []);
      applyFleetEventFrame(
        queryClient,
        fleetFrame({
          kind: 'human-review:completed',
          ...(workflowId === undefined ? {} : { workflowId }),
        }),
      );
      expect(queryClient.getQueryState(REVIEWS_LIST_KEY_PREFIX)?.isInvalidated).toBe(true);
    }
  });

  test.each(['update:received', 'update:completed'])(
    '%s invalidates that run’s update history, and no other run’s',
    (kind) => {
      const queryClient = new QueryClient();
      queryClient.setQueryData([...workflowUpdatesKey('wf_1'), 2], () => ({ items: [] }));
      queryClient.setQueryData(workflowUpdatesKey('wf_2'), () => ({ items: [] }));
      applyFleetEventFrame(queryClient, fleetFrame({ kind, workflowId: 'wf_1' }));
      expect(queryClient.getQueryState([...workflowUpdatesKey('wf_1'), 2])?.isInvalidated).toBe(
        true,
      );
      expect(queryClient.getQueryState(workflowUpdatesKey('wf_2'))?.isInvalidated).toBeFalsy();
    },
  );

  test('workflowUpdatesKey is the key the updates tab reads', () => {
    expect(workflowUpdatesKey('wf_1')).toEqual([...updateHistoryQueryKey('wf_1')]);
  });

  test('a fleet gap asks again for everything the feed drives, but not the workflow list', () => {
    const queryClient = new QueryClient();
    const keys = [
      REVIEWS_LIST_KEY_PREFIX,
      WORKERS_LIST_KEY,
      SCHEDULES_LIST_KEY_PREFIX,
      workflowDetailKey('wf_1'),
      workflowFinalizerKey('wf_1'),
      workflowUpdatesKey('wf_1'),
    ];
    for (const key of keys) queryClient.setQueryData(key, () => []);
    queryClient.setQueryData(WORKFLOWS_LIST_KEY_PREFIX, () => []);

    applyFleetEventFrame(queryClient, fleetFrame({ kind: 'fleet:gap' }));

    for (const key of keys) expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(WORKFLOWS_LIST_KEY_PREFIX)?.isInvalidated).toBeFalsy();
  });

  test('worker:connected invalidates the workers list', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(WORKERS_LIST_KEY, () => []);
    applyFleetEventFrame(queryClient, fleetFrame({ kind: 'worker:connected' }));
    expect(queryClient.getQueryState(WORKERS_LIST_KEY)?.isInvalidated).toBe(true);
  });

  test('an unrecognized, non-workflow-scoped kind invalidates nothing (out of scope — session-scoped alerts, per module doc)', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(WORKFLOWS_LIST_KEY_PREFIX, () => []);
    queryClient.setQueryData(SCHEDULES_LIST_KEY_PREFIX, () => []);
    queryClient.setQueryData(REVIEWS_LIST_KEY_PREFIX, () => []);
    queryClient.setQueryData(WORKERS_LIST_KEY, () => []);

    applyFleetEventFrame(queryClient, fleetFrame({ kind: 'alert:fired' }));

    expect(queryClient.getQueryState(WORKFLOWS_LIST_KEY_PREFIX)?.isInvalidated).toBeFalsy();
    expect(queryClient.getQueryState(SCHEDULES_LIST_KEY_PREFIX)?.isInvalidated).toBeFalsy();
    expect(queryClient.getQueryState(REVIEWS_LIST_KEY_PREFIX)?.isInvalidated).toBeFalsy();
    expect(queryClient.getQueryState(WORKERS_LIST_KEY)?.isInvalidated).toBeFalsy();
  });
});

describe('a schedule’s derived queries', () => {
  const HISTORY_KEY = [...SCHEDULES_RUN_HISTORY_KEY_PREFIX, 'nightly'];
  const OTHER_HISTORY_KEY = [...SCHEDULES_RUN_HISTORY_KEY_PREFIX, 'weekly'];
  const DETAIL_KEY = [...SCHEDULES_DETAIL_KEY_PREFIX, 'nightly'];

  function seeded(): QueryClient {
    const queryClient = new QueryClient();
    queryClient.setQueryData(SCHEDULES_LIST_KEY_PREFIX, []);
    queryClient.setQueryData(DETAIL_KEY, {});
    queryClient.setQueryData(HISTORY_KEY, { items: [{ id: 'run-1', status: 'running' }] });
    queryClient.setQueryData(OTHER_HISTORY_KEY, { items: [{ id: 'run-9', status: 'completed' }] });
    return queryClient;
  }

  const stale = (queryClient: QueryClient, key: readonly unknown[]) =>
    queryClient.getQueryState(key)?.isInvalidated === true;

  test.each(['schedule:fired', 'schedule:missed-fire'])(
    '%s refetches the list, every detail and every run history',
    (kind) => {
      const queryClient = seeded();
      applyFleetEventFrame(queryClient, fleetFrame({ kind }));
      expect(stale(queryClient, SCHEDULES_LIST_KEY_PREFIX)).toBe(true);
      expect(stale(queryClient, DETAIL_KEY)).toBe(true);
      expect(stale(queryClient, HISTORY_KEY)).toBe(true);
      expect(stale(queryClient, OTHER_HISTORY_KEY)).toBe(true);
    },
  );

  test.each(['workflow:completed', 'workflow:failed', 'workflow:cancelled', 'workflow:timed-out'])(
    'a run that settles (%s) refetches only the histories that list it',
    (kind) => {
      const queryClient = seeded();
      applyFleetEventFrame(queryClient, fleetFrame({ kind, workflowId: 'run-1' }));
      expect(stale(queryClient, HISTORY_KEY)).toBe(true);
      expect(stale(queryClient, OTHER_HISTORY_KEY)).toBe(false);
      // Its status is not the schedule’s own fields.
      expect(stale(queryClient, SCHEDULES_LIST_KEY_PREFIX)).toBe(false);
      expect(stale(queryClient, DETAIL_KEY)).toBe(false);
    },
  );

  test('a run that has not settled, or no run at all, refetches nothing', () => {
    const queryClient = seeded();
    applyScheduleFleetFrame(
      queryClient,
      fleetFrame({ kind: 'workflow:started', workflowId: 'run-1' }),
    );
    applyScheduleFleetFrame(queryClient, fleetFrame({ kind: 'workflow:completed' }));
    applyScheduleFleetFrame(queryClient, fleetFrame({ kind: 'alert:fired' }));
    expect(stale(queryClient, HISTORY_KEY)).toBe(false);
    expect(stale(queryClient, SCHEDULES_LIST_KEY_PREFIX)).toBe(false);
  });

  test('a history that is not a page of runs is left alone', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(HISTORY_KEY, 'unexpected');
    queryClient.setQueryData(OTHER_HISTORY_KEY, { items: ['run-1', null] });
    applyScheduleFleetFrame(
      queryClient,
      fleetFrame({ kind: 'workflow:failed', workflowId: 'run-1' }),
    );
    expect(stale(queryClient, HISTORY_KEY)).toBe(false);
    expect(stale(queryClient, OTHER_HISTORY_KEY)).toBe(false);
  });
});
