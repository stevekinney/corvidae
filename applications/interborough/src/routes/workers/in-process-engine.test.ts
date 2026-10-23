import { describe, expect, test } from 'bun:test';

import { runsInProcessOnly } from './in-process-engine.ts';
import type { TaskQueuesListOutput, WorkersListOutput } from './worker-catalog-types.ts';

const none = { items: [], deployments: [], routingPolicy: 'least-loaded' } as WorkersListOutput;
const noQueues = { items: [] } as unknown as TaskQueuesListOutput;
const oneQueue = { items: [{ queue: 'default' }] } as unknown as TaskQueuesListOutput;
const search = (query: string) => new URLSearchParams(query);

describe('runsInProcessOnly', () => {
  test('is true when no worker, deployment, or queue exists', () => {
    expect(runsInProcessOnly(none, noQueues, search(''))).toBe(true);
    expect(runsInProcessOnly(none, noQueues, search('tab=diagnostics'))).toBe(true);
  });

  test('is false once a worker is connected', () => {
    const connected = { ...none, items: [{ id: 'worker-1' }] } as unknown as WorkersListOutput;
    expect(runsInProcessOnly(connected, noQueues, search(''))).toBe(false);
  });

  test('is false once a deployment has reported', () => {
    const reported = { ...none, deployments: [{ buildId: 'b1' }] } as unknown as WorkersListOutput;
    expect(runsInProcessOnly(reported, noQueues, search(''))).toBe(false);
  });

  test('is false while a task queue exists, whose ledger Diagnostics reads', () => {
    expect(runsInProcessOnly(none, oneQueue, search(''))).toBe(false);
  });

  test('is false for an address that names a worker, a queue, or a task', () => {
    for (const query of ['worker=w1', 'queue=default', 'task=op-1']) {
      expect(runsInProcessOnly(none, noQueues, search(query)), query).toBe(false);
    }
  });
});
