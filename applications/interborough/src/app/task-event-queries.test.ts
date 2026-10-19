import { QueryClient } from '@tanstack/svelte-query';
import { describe, expect, test } from 'bun:test';

import type { FleetEventFrame } from '../lib/live-source/fleet-event-source.svelte.ts';
import { queryKeys } from '../lib/query.ts';
import { invalidateForTaskEvent, subscribeTaskEvidenceInvalidation } from './task-event-queries.ts';

function frame(kind: string, payload: unknown): FleetEventFrame {
  return { kind, sequence: 1, cursor: '1', emittedAtMs: 1, payload };
}

/** Seeds one cached query per key and reports which the client marks invalidated. */
function seededClient(keys: readonly (readonly unknown[])[]) {
  const client = new QueryClient();
  for (const key of keys) client.setQueryData([...key], { seeded: true });
  return {
    client,
    invalidated: () => keys.filter((key) => client.getQueryState([...key])?.isInvalidated === true),
  };
}

const OPERATION = 'op_dead_1';
const KEYS = [
  queryKeys.tasks.detail(OPERATION),
  queryKeys.tasks.deliveries(OPERATION),
  queryKeys.tasks.deadLetter(OPERATION),
  queryKeys.tasks.detail('op_other'),
  queryKeys.diagnostics(),
  queryKeys.diagnosticsFiltered({ buildId: 'build-2' }),
  queryKeys.workers.list(),
] as const;

describe('task evidence invalidation', () => {
  test('a dead-lettered event refreshes that task, its deliveries, and every diagnostics report', () => {
    const { client, invalidated } = seededClient(KEYS);
    const handled = invalidateForTaskEvent(
      client,
      frame('task:dead-lettered', { operationId: OPERATION, workflowId: 'wf_1' }),
    );
    expect(handled).toBe(true);
    expect(invalidated()).toEqual([
      queryKeys.tasks.detail(OPERATION),
      queryKeys.tasks.deliveries(OPERATION),
      queryKeys.tasks.deadLetter(OPERATION),
      queryKeys.diagnostics(),
      queryKeys.diagnosticsFiltered({ buildId: 'build-2' }),
    ]);
  });

  test('a result delivery refreshes that task only, not the diagnostics report', () => {
    const { client, invalidated } = seededClient(KEYS);
    expect(
      invalidateForTaskEvent(client, frame('task:result-delivery', { operationId: OPERATION })),
    ).toBe(true);
    expect(invalidated()).toEqual([
      queryKeys.tasks.detail(OPERATION),
      queryKeys.tasks.deliveries(OPERATION),
      queryKeys.tasks.deadLetter(OPERATION),
    ]);
  });

  test('a dead-lettered event with no readable operation id still refreshes diagnostics', () => {
    const { client, invalidated } = seededClient(KEYS);
    invalidateForTaskEvent(client, frame('task:dead-lettered', 'not an object'));
    expect(invalidated()).toEqual([
      queryKeys.diagnostics(),
      queryKeys.diagnosticsFiltered({ buildId: 'build-2' }),
    ]);
  });

  test('other event kinds are left alone', () => {
    const { client, invalidated } = seededClient(KEYS);
    expect(invalidateForTaskEvent(client, frame('worker:connected', { id: 'w' }))).toBe(false);
    expect(invalidated()).toEqual([]);
  });

  test('the subscription forwards each frame and unsubscribes', () => {
    const { client, invalidated } = seededClient(KEYS);
    let listener: ((next: FleetEventFrame) => void) | undefined;
    let unsubscribed = false;
    const stop = subscribeTaskEvidenceInvalidation(
      {
        subscribe(next) {
          listener = next;
          return () => {
            unsubscribed = true;
          };
        },
      },
      client,
    );
    listener?.(frame('task:dead-lettered', { operationId: OPERATION }));
    expect(invalidated()).toContainEqual(queryKeys.diagnostics());
    stop();
    expect(unsubscribed).toBe(true);
  });
});
