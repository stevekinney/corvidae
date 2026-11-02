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
    tracker = createCatalogSettlementTracker(),
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
      tracker,
      diagnose: (diagnostic) => diagnostics.push(diagnostic.message),
    });
    return { run, published, second, followed, diagnostics, tracker, hook };
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

  it('is waited for by a shutdown while the durable run is read and every listener writes, however long storage takes', async () => {
    const storageRead = Promise.withResolvers<DurableEnd>();
    const listenerWrite = Promise.withResolvers<void>();
    const { run, published, tracker, hook } = observed(
      {
        result: () =>
          Promise.reject(new Error('Engine was disposed before the workflow completed')),
      },
      async () => undefined,
      () => storageRead.promise,
    );
    const wrote: string[] = [];
    hook.subscribe(async (settlement) => {
      await listenerWrite.promise;
      wrote.push(settlement.status);
    });
    tracker.follow(run);

    let returned = false;
    const waiting = tracker.settled().then(() => void (returned = true));
    // load-proof: a count of event-loop turns past the tracker's own bound; the database answers when the test says so, not when a clock does
    for (let turn = 0; turn < 120; turn += 1) await yieldToPortableEventLoop();
    expect(returned).toBe(false);
    storageRead.resolve('completed');
    // load-proof: a count of event-loop turns past the tracker's own bound; the listener's write finishes when the test says so
    for (let turn = 0; turn < 120; turn += 1) await yieldToPortableEventLoop();
    expect(returned).toBe(false);
    expect(wrote).toEqual([]);

    listenerWrite.resolve();
    await waiting;
    expect(wrote).toEqual(['completed']);
    expect(published).toMatchObject([{ status: 'completed' }]);
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

  it('writes nothing for a run that ends after the shutdown stopped waiting, and nothing is published', async () => {
    // A run followed before the shutdown, still running when the shutdown stopped waiting for run
    // ends, whose end then arrives: the storage behind its listeners may already be closed.
    const ending = Promise.withResolvers<{ finishReason: string; content: string }>();
    const admitted: string[] = [];
    const { run, published, second, tracker } = observed(
      { result: () => ending.promise },
      async () => void admitted.push('admitted'),
    );
    tracker.follow(run);

    await tracker.settled(0);
    expect(admitted).toEqual(['admitted']);

    ending.resolve({ finishReason: 'stop-condition', content: 'answer' });
    await run;

    expect(published).toEqual([]);
    expect(second).toEqual([]);
  });

  it('records nothing for a run whose start committed after the shutdown stopped waiting', async () => {
    // The first publish is registered only once the run's start has committed, which can be after
    // the shutdown found nothing followed and moved on.
    const tracker = createCatalogSettlementTracker();
    await tracker.settled();
    const admitted: string[] = [];
    const { run, published, diagnostics } = observed(
      { result: async () => ({ finishReason: 'stop-condition', content: 'answer' }) },
      async () => void admitted.push('admitted'),
      undefined,
      tracker,
    );
    tracker.follow(run);

    await run;

    expect(admitted).toEqual([]);
    expect(published).toEqual([]);
    expect(diagnostics).toEqual([]);
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
    // load-proof: the tracker's own bound is a count of event-loop turns, so this publish counts turns the same way; no clock decides which finishes first
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

  it('bounds the wait for a run to end: a limit of zero waits for nothing, and a publish whose run has not ended outlasts the limit', async () => {
    const tracker = createCatalogSettlementTracker();
    const ended: string[] = [];
    tracker.follow(endsAfter(5, ended));
    tracker.follow(endsAfter(500, ended));

    await tracker.settled(0);
    expect(ended).toEqual([]);
    await tracker.settled(20);
    expect(ended).toEqual(['after 5']);
  });

  it('is a barrier for the storage work of a run that has ended, however many turns it takes', async () => {
    const tracker = createCatalogSettlementTracker();
    const storage = Promise.withResolvers<void>();
    let written = false;
    tracker.follow(
      tracker
        .commit(async () => {
          await storage.promise;
          written = true;
        })
        .then(() => undefined),
    );

    let returned = false;
    const waiting = tracker.settled(5).then(() => void (returned = true));
    // load-proof: a count of event-loop turns, like the bound under test, far past that bound; the storage work is released by the test, not by a clock
    for (let turn = 0; turn < 200; turn += 1) await yieldToPortableEventLoop();
    expect(returned).toBe(false);

    storage.resolve();
    await waiting;
    expect(written).toBe(true);
  });

  it('waits for the work of a run that ends while it is waiting, and still leaves the run that never does', async () => {
    const tracker = createCatalogSettlementTracker();
    const runEnds = Promise.withResolvers<void>();
    const storage = Promise.withResolvers<void>();
    const finished: string[] = [];
    tracker.follow(
      (async () => {
        await runEnds.promise;
        await tracker.commit(async () => {
          await storage.promise;
          finished.push('recorded');
        });
      })(),
    );
    tracker.follow(new Promise<void>(() => undefined));

    let returned = false;
    const waiting = tracker.settled(5).then(() => void (returned = true));
    runEnds.resolve();
    // load-proof: a count of event-loop turns, like the bound under test; both gates are released by the test, not by a clock
    for (let turn = 0; turn < 50; turn += 1) await yieldToPortableEventLoop();
    expect(returned).toBe(false);

    storage.resolve();
    await waiting;
    expect(finished).toEqual(['recorded']);
  });

  it('refuses storage work committed after it settled, and says so', async () => {
    const tracker = createCatalogSettlementTracker();
    const ran: string[] = [];
    expect(await tracker.commit(async () => void ran.push('before'))).toBe(true);

    await tracker.settled();

    expect(await tracker.commit(async () => void ran.push('after'))).toBe(false);
    expect(ran).toEqual(['before']);
  });

  it('waits for the work it admitted before it closed, and closes once that work is done', async () => {
    const tracker = createCatalogSettlementTracker();
    const storage = Promise.withResolvers<void>();
    const ran: string[] = [];
    const committing = tracker.commit(async () => {
      await storage.promise;
      ran.push('first');
    });

    const waiting = tracker.settled(0);
    storage.resolve();
    await waiting;

    expect(await committing).toBe(true);
    expect(await tracker.commit(async () => void ran.push('second'))).toBe(false);
    expect(ran).toEqual(['first']);
  });

  it('follows nothing after it settled, and does not leave the publish it was handed unhandled', async () => {
    const tracker = createCatalogSettlementTracker();
    await tracker.settled();

    tracker.follow(Promise.reject(new Error('published too late')));

    await tracker.settled();
  });

  it('ignores a publish that rejects', async () => {
    const tracker = createCatalogSettlementTracker();
    tracker.follow(Promise.reject(new Error('never published')));

    await tracker.settled();
  });
});
