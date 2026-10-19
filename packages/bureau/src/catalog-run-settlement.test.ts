import { yieldToPortableEventLoop } from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import {
  type CatalogRunSettlement,
  createCatalogRunSettlementHook,
  createCatalogSettlementTracker,
  type DurableEnd,
  type FreshCatalogRunHandle,
  publishFreshCatalogRun,
} from './catalog-run-settlement';

const settlement: CatalogRunSettlement = {
  runId: 'agent-run-1',
  agentName: 'worker',
  status: 'completed',
  finishReason: 'stop-condition',
  message: null,
  content: 'answer',
  recovered: true,
};

describe('the catalog-run settlement hook', () => {
  it('tells every subscriber, in subscription order, and stops telling one that unsubscribed', async () => {
    const hook = createCatalogRunSettlementHook(() => undefined);
    const seen: string[] = [];
    const first = hook.subscribe((event) => void seen.push(`first:${event.runId}`));
    hook.subscribe(async (event) => {
      await Promise.resolve();
      seen.push(`second:${event.runId}`);
    });

    await hook.publish(settlement);
    first();
    await hook.publish({ ...settlement, runId: 'agent-run-2' });

    expect(seen).toEqual(['first:agent-run-1', 'second:agent-run-1', 'second:agent-run-2']);
  });

  it('isolates a listener that throws or rejects, and reports it', async () => {
    const diagnostics: string[] = [];
    const hook = createCatalogRunSettlementHook((diagnostic) =>
      diagnostics.push(diagnostic.message),
    );
    const seen: string[] = [];
    hook.subscribe(() => {
      throw new Error('boom');
    });
    hook.subscribe(() => Promise.reject(new Error('later boom')));
    hook.subscribe((event) => void seen.push(event.runId));

    await hook.publish(settlement);

    expect(seen).toEqual(['agent-run-1']);
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics.join()).toContain('agent-run-1');
  });
});

describe('publishing a fresh catalog dispatch', () => {
  function observed(
    handle: Partial<FreshCatalogRunHandle>,
    admit: () => Promise<void>,
    durableEnd?: () => Promise<DurableEnd>,
  ) {
    const hook = createCatalogRunSettlementHook(() => undefined);
    const published: CatalogRunSettlement[] = [];
    const second: CatalogRunSettlement[] = [];
    hook.subscribe((event) => void published.push(event));
    hook.subscribe((event) => void second.push(event));
    const followed: unknown[] = [];
    const diagnostics: string[] = [];
    const run = publishFreshCatalogRun({
      handle: {
        id: 'agent-run-1',
        result: async () => ({ finishReason: 'stop-condition', content: 'answer' }),
        closed: async () => ({ status: 'completed' }),
        ...handle,
      },
      agentName: 'worker',
      admit,
      hook,
      followCleanup: (closed) => void followed.push(closed),
      durableEnd,
      diagnose: (diagnostic) => diagnostics.push(diagnostic.message),
    });
    return { run, published, second, followed, diagnostics };
  }

  it('publishes the end of a run whose task record could not be written, and says so', async () => {
    const { run, published, second, diagnostics } = observed({}, () =>
      Promise.reject(new Error('storage is down')),
    );

    await run;

    expect(published).toMatchObject([
      { runId: 'agent-run-1', status: 'completed', content: 'answer' },
    ]);
    expect(second).toHaveLength(1);
    expect(diagnostics.join()).toContain('storage is down');
  });

  it('publishes failed when the handle’s result rejects', async () => {
    const { run, published } = observed(
      { result: () => Promise.reject(new Error('the engine fell over')) },
      async () => undefined,
    );

    await run;

    expect(published).toMatchObject([
      { status: 'failed', finishReason: 'error', recovered: false, content: null },
    ]);
    expect(published[0]?.message).toContain('the engine fell over');
  });

  it('publishes nothing when the handle rejects while the durable run is still running, as it does when the engine is disposed', async () => {
    const reads: string[] = [];
    const { run, published } = observed(
      {
        result: () =>
          Promise.reject(new Error('Engine was disposed before the workflow completed')),
      },
      async () => undefined,
      async () => {
        reads.push('read');
        return 'in-flight';
      },
    );

    await run;

    expect(reads).toEqual(['read']);
    expect(published).toEqual([]);
  });

  it('publishes nothing when the durable run cannot be read after the handle rejects', async () => {
    const { run, published } = observed(
      { result: () => Promise.reject(new Error('rejected')) },
      async () => undefined,
      () => Promise.reject(new Error('Cannot use a closed database')),
    );

    await run;

    expect(published).toEqual([]);
  });

  it('publishes the terminal state the durable run reached when the handle rejects', async () => {
    const outcomes: Array<[DurableEnd, string]> = [
      ['failed', 'failed'],
      ['canceled', 'canceled'],
      ['completed', 'completed'],
      ['not-durable', 'failed'],
    ];
    for (const [end, status] of outcomes) {
      const { run, published } = observed(
        { result: () => Promise.reject(new Error('rejected')) },
        async () => undefined,
        async () => end,
      );

      await run;

      expect(published).toMatchObject([{ status, recovered: false }]);
    }
  });

  it('follows the cleanup of a canceled run before publishing it', async () => {
    const { run, published, followed } = observed(
      { result: async () => ({ finishReason: 'aborted', content: '' }) },
      async () => undefined,
    );

    await run;

    expect(followed).toHaveLength(1);
    expect(published[0]?.status).toBe('canceled');
  });
});

describe('the settlement tracker a shutdown waits on', () => {
  /** A publish that ends after `turns` event-loop turns. */
  async function endsAfter(turns: number, ended: string[]): Promise<void> {
    for (let turn = 0; turn < turns; turn += 1) await yieldToPortableEventLoop();
    ended.push(`after ${String(turns)}`);
  }

  it('waits for a publish that ends within its turn limit', async () => {
    const tracker = createCatalogSettlementTracker();
    const ended: string[] = [];
    tracker.follow(endsAfter(5, ended));

    await tracker.settled();

    expect(ended).toEqual(['after 5']);
  });

  it('is a bound, not a barrier: a limit of zero waits for nothing, and a publish that outlasts the limit is left', async () => {
    const tracker = createCatalogSettlementTracker();
    const ended: string[] = [];
    tracker.follow(endsAfter(5, ended));
    tracker.follow(endsAfter(500, ended));

    await tracker.settled(0);
    expect(ended).toEqual([]);
    await tracker.settled(20);
    expect(ended).toEqual(['after 5']);
  });

  it('ignores a publish that rejects', async () => {
    const tracker = createCatalogSettlementTracker();
    tracker.follow(Promise.reject(new Error('never published')));

    await tracker.settled();
  });
});
