/**
 * COR-1477 — durable maintenance bounds the event history and the task set.
 *
 * `retention.events` advances the fleet feed's retention floor, `retention.tasks`
 * deletes terminal tasks through the run store, and the audit trail's clamp
 * keeps holding once the floor moves. Every window is measured on the bureau's
 * injected manual clock, which these tests move with `setTime`.
 */
import { createManualRuntimeServices, type ManualRuntimeServices } from '@lostgradient/lifecycle';
import {
  type DurableEventEnvelope,
  type GenerateFunction,
  stopWhen,
  createAgent,
} from '@lostgradient/operative';
import { createToolbox, type Tool } from 'armorer';
import { createFleetEventFeed, resolveStorage } from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import { BureauError, createBureau } from './create-bureau';
import { DURABLE_HISTORY_GAP_KIND } from './durable-event-history';
import { createSqliteStorageFixture } from './test/storage-fixtures';
import { rejectionOf } from './testing/promise-outcome.test-support.ts';
import type { Bureau, BureauOptions } from './types';
import type { AgentDefinitions } from './agent-catalog';

const ORIGIN = '2026-10-13T00:00:00.000Z';
const ORIGIN_MS = Date.parse(ORIGIN);
const DAY_MS = 86_400_000;

const finishes: GenerateFunction = async () => ({ content: 'done', toolCalls: [] });

/** A model that answers once `gate` opens, so a test decides when its run settles. */
function finishesAfter(gate: Promise<void>): GenerateFunction {
  return async () => {
    await gate;
    return { content: 'done', toolCalls: [] };
  };
}

/** A bounded poll with a small real delay between checks; never a blind sleep. */
async function pollUntil(check: () => boolean): Promise<boolean> {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return check();
}

/**
 * Runs `body` against a durable bureau over a fresh SQLite store, then tears
 * both down. `retentionFloor()` reads the fleet feed's floor from the same file.
 */
async function withBureau(
  body: (context: {
    bureau: Bureau;
    runtime: ManualRuntimeServices;
    retentionFloor: () => Promise<number>;
    at: (offsetMs: number) => void;
  }) => Promise<void>,
  overrides: Partial<BureauOptions> = {},
): Promise<void> {
  const runtime = createManualRuntimeServices({ origin: ORIGIN });
  const fixture = createSqliteStorageFixture({ runtime });
  const bureau = await createBureau<AgentDefinitions>({
    agents: {
      default: createAgent({
        generate: finishes,
        stopWhen: stopWhen.noToolCalls(),
        toolbox: createToolbox<readonly Tool[]>([]),
      }),
    },
    runtime,
    storage: fixture.configuration,
    durable: true,
    durableOwnership: { ownership: 'none' },
    maintenance: 'manual',
    ...overrides,
  });
  try {
    await body({
      bureau,
      runtime,
      at: (offsetMs) => runtime.setTime(ORIGIN_MS + offsetMs),
      retentionFloor: async () => {
        const storage = await resolveStorage(fixture.configuration);
        try {
          const feed = createFleetEventFeed(storage);
          try {
            return await feed.snapshotRetentionFloor();
          } finally {
            feed.dispose();
          }
        } finally {
          storage[Symbol.dispose]();
        }
      },
    });
  } finally {
    await bureau.dispose();
    await fixture.dispose();
  }
}

/** Creates a run and waits for it to finish. */
async function settledRun(bureau: Bureau, message = 'work') {
  const created = await bureau.createRun({ agentName: 'default', message, principal: 'alice' });
  expect(await pollUntil(() => bureau.getRun(created.id)?.status === 'completed')).toBe(true);
  return created;
}

describe('retention.events', () => {
  it('advances the fleet feed floor past events older than the window on a maintenance pass, 7 days by default', async () => {
    await withBureau(async ({ bureau, runtime, at, retentionFloor }) => {
      await settledRun(bureau);
      await runtime.deferred.drain();
      expect(await retentionFloor()).toBe(0);

      // An event exactly as old as the window is not older than it.
      at(7 * DAY_MS);
      await bureau.runDurableMaintenance();
      expect(await retentionFloor()).toBe(0);

      at(7 * DAY_MS + 1);
      await bureau.runDurableMaintenance();
      expect(await retentionFloor()).toBeGreaterThan(0);
    });
  });

  it('honors a configured window, and never advances the floor under "forever"', async () => {
    await withBureau(
      async ({ bureau, runtime, at, retentionFloor }) => {
        await settledRun(bureau);
        await runtime.deferred.drain();
        at(60_000);
        await bureau.runDurableMaintenance();
        expect(await retentionFloor()).toBe(0);
        at(60_001);
        await bureau.runDurableMaintenance();
        expect(await retentionFloor()).toBeGreaterThan(0);
      },
      { retention: { events: { olderThan: 60_000 } } },
    );

    await withBureau(
      async ({ bureau, runtime, at, retentionFloor }) => {
        await settledRun(bureau);
        await runtime.deferred.drain();
        at(1_000 * DAY_MS);
        await bureau.runDurableMaintenance();
        expect(await retentionFloor()).toBe(0);
      },
      { retention: { events: 'forever' } },
    );
  });

  it('advances the floor from the automatic maintenance interval too, with no manual call', async () => {
    await withBureau(
      async ({ bureau, runtime, retentionFloor }) => {
        await settledRun(bureau);
        await runtime.deferred.drain();
        expect(await retentionFloor()).toBe(0);

        // One tick of the automatic pass (five minutes) after the window.
        await runtime.advance(5 * 60_000 + 1);
        let floor = 0;
        for (let attempt = 0; attempt < 400 && floor === 0; attempt++) {
          floor = await retentionFloor();
          if (floor === 0) await new Promise((resolve) => setTimeout(resolve, 5));
        }
        expect(floor).toBeGreaterThan(0);
      },
      { retention: { events: { olderThan: 60_000 } }, maintenance: 'automatic' },
    );
  });

  it('reports a resume below the advanced floor as one gap event through the bureau', async () => {
    await withBureau(async ({ bureau, runtime, at }) => {
      const run = await settledRun(bureau);
      await runtime.deferred.drain();
      const owner = { kind: 'run', id: run.id } as const;
      const before = await bureau.eventHistory(owner);
      if (!('events' in before)) throw new Error('expected a page of events');
      const cursor = before.events[0]?.cursor;
      expect(cursor).toBeDefined();

      at(8 * DAY_MS);
      await bureau.runDurableMaintenance();
      // The run's own newer events keep arriving after the floor moves.
      const second = await settledRun(bureau, 'later');
      await runtime.deferred.drain();

      const received: DurableEventEnvelope[] = [];
      const subscription = bureau.subscribeEventHistory(owner, (event) => received.push(event), {
        since: cursor,
      });
      expect(
        await pollUntil(() => received.some((event) => event.kind === DURABLE_HISTORY_GAP_KIND)),
      ).toBe(true);
      subscription.unsubscribe();
      expect(received.filter((event) => event.kind === DURABLE_HISTORY_GAP_KIND)).toHaveLength(1);
      expect(received[0]?.kind).toBe(DURABLE_HISTORY_GAP_KIND);
      expect(second.id).not.toBe(run.id);
    });
  });

  it('rejects a window that is not a finite, non-negative number', async () => {
    for (const olderThan of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      const failure = await rejectionOf(
        createBureau<AgentDefinitions>({
          agents: {
            default: createAgent({
              generate: finishes,
              toolbox: createToolbox<readonly Tool[]>([]),
            }),
          },
          retention: { events: { olderThan } },
        }),
      );
      expect(failure).toBeInstanceOf(BureauError);
      expect(failure).toMatchObject({ code: 'BAD_REQUEST' });
    }
  });
});

describe('the audit trail beside an advancing floor', () => {
  it('prunes audit records older than both the floor and its own window, and none newer than either', async () => {
    await withBureau(
      async ({ bureau, runtime, at }) => {
        const old = await settledRun(bureau, 'old');
        await runtime.deferred.drain();
        at(3 * DAY_MS);
        const recent = await settledRun(bureau, 'recent');
        await runtime.deferred.drain();
        const oldBefore = await bureau.auditTrail?.query({ runId: old.id });
        const recentBefore = await bureau.auditTrail?.query({ runId: recent.id });
        expect(oldBefore?.length).toBeGreaterThan(0);

        // The event window (2 days) advances the floor past the old run's
        // events; the audit window (1 day) then reaches its audit records.
        await bureau.runDurableMaintenance();

        expect(await bureau.auditTrail?.query({ runId: old.id })).toEqual([]);
        expect(await bureau.auditTrail?.query({ runId: recent.id })).toEqual(recentBefore);
      },
      { retention: { events: { olderThan: 2 * DAY_MS }, audit: { olderThan: DAY_MS } } },
    );
  });

  it('keeps a record the floor has overtaken while it is newer than the audit window', async () => {
    await withBureau(
      async ({ bureau, runtime, at, retentionFloor }) => {
        const run = await settledRun(bureau);
        await runtime.deferred.drain();
        const before = await bureau.auditTrail?.query({ runId: run.id });
        at(2 * DAY_MS);

        await bureau.runDurableMaintenance();

        // The floor passed the run's events, but the audit window (5 days) has not.
        expect(await retentionFloor()).toBeGreaterThan(0);
        expect(await bureau.auditTrail?.query({ runId: run.id })).toEqual(before);
      },
      { retention: { events: { olderThan: DAY_MS }, audit: { olderThan: 5 * DAY_MS } } },
    );
  });

  it('never prunes a record the retained history still covers, however old it is by its own window', async () => {
    await withBureau(
      async ({ bureau, runtime, at, retentionFloor }) => {
        const run = await settledRun(bureau);
        await runtime.deferred.drain();
        const before = await bureau.auditTrail?.query({ runId: run.id });
        at(30 * DAY_MS);

        await bureau.runDurableMaintenance();

        // `'forever'` events: the floor stays put, so the clamp protects the record.
        expect(await retentionFloor()).toBe(0);
        expect(await bureau.auditTrail?.query({ runId: run.id })).toEqual(before);
      },
      { retention: { events: 'forever', audit: { olderThan: DAY_MS } } },
    );
  });

  it("with 'forever' prunes nothing, whatever the floor does", async () => {
    await withBureau(
      async ({ bureau, runtime, at, retentionFloor }) => {
        const run = await settledRun(bureau);
        await runtime.deferred.drain();
        const before = await bureau.auditTrail?.query({ runId: run.id });
        at(100 * DAY_MS);

        await bureau.runDurableMaintenance();

        expect(await retentionFloor()).toBeGreaterThan(0);
        expect(await bureau.auditTrail?.query({ runId: run.id })).toEqual(before);
        expect(await bureau.auditTrail?.query({ type: 'audit.pruned' })).toEqual([]);
      },
      { retention: { events: { olderThan: DAY_MS }, audit: 'forever' } },
    );
  });
});

describe('retention.tasks', () => {
  it('deletes a terminal task once it is older than 30 days by default, and not one inside the window', async () => {
    await withBureau(async ({ bureau, at }) => {
      const run = await settledRun(bureau);

      // A task exactly as old as the window is not older than it.
      at(30 * DAY_MS);
      await bureau.runDurableMaintenance();
      expect(bureau.getRun(run.id)).toBeDefined();

      at(30 * DAY_MS + 1);
      await bureau.runDurableMaintenance();
      expect(bureau.getRun(run.id)).toBeUndefined();
    });
  });

  it('deletes an errored task once it is older than the window, so retention does not stop at run.error', async () => {
    const failing: GenerateFunction = async () => {
      throw new Error('model unavailable');
    };
    await withBureau(
      async ({ bureau, at }) => {
        const created = await bureau.createRun({
          agentName: 'default',
          message: 'fails',
          principal: 'alice',
        });
        expect(await pollUntil(() => bureau.getRun(created.id)?.status === 'error')).toBe(true);

        // `run.error` is followed by `run.completed`, which closes the run and
        // starts its window; poll the passes until it has and the run goes.
        at(2 * DAY_MS);
        for (let attempt = 0; attempt < 400 && bureau.getRun(created.id) !== undefined; attempt++) {
          await bureau.runDurableMaintenance();
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        expect(bureau.getRun(created.id)).toBeUndefined();
      },
      {
        retention: { tasks: { olderThan: DAY_MS } },
        agents: { default: createAgent({ generate: failing }) },
      },
    );
  });

  it('never deletes a task that has not reached a terminal status', async () => {
    const gate = Promise.withResolvers<void>();
    const hold = { on: false };
    await withBureau(
      async ({ bureau, at }) => {
        const settled = await settledRun(bureau, 'short');
        hold.on = true;
        const running = await bureau.createRun({
          agentName: 'default',
          message: 'long',
          principal: 'alice',
        });

        at(365 * DAY_MS);
        await bureau.runDurableMaintenance();

        expect(bureau.getRun(running.id)?.status).toBe('running');
        expect(bureau.getRun(settled.id)).toBeUndefined();
        gate.resolve();
      },
      {
        retention: { tasks: { olderThan: DAY_MS } },
        agents: { default: createAgent({ generate: holdableGenerate(hold, gate.promise) }) },
      },
    );
  });

  it('removes the run through the run store, so run.removed fires for each deleted task', async () => {
    await withBureau(
      async ({ bureau, at }) => {
        const removed: string[] = [];
        bureau.addEventListener('run.removed', (event) => removed.push(event.runId));
        const first = await settledRun(bureau, 'one');
        const second = await settledRun(bureau, 'two');

        at(2 * DAY_MS);
        await bureau.runDurableMaintenance();

        expect(removed.toSorted()).toEqual([first.id, second.id].toSorted());
        // The deletion is also recorded as the durable `run.removed` event.
        const history = await bureau.eventHistory({ kind: 'run', id: first.id });
        expect(history).toMatchObject({ outcome: 'deleted-aggregate' });
      },
      { retention: { tasks: { olderThan: DAY_MS }, events: 'forever' } },
    );
  });

  it('keeps a task whose run-creation binding is still stored until the sweep has deleted it', async () => {
    await withBureau(
      async ({ bureau, at }) => {
        const request = {
          agentName: 'default',
          message: 'Summarize the quarter.',
          principal: 'alice',
          runCreationRequestId: 'request-1',
        };
        const locate = {
          principal: 'alice',
          agentName: 'default',
          runCreationRequestId: 'request-1',
        } as const;
        const created = await bureau.createRun(request);
        expect(await pollUntil(() => bureau.getRun(created.id)?.status === 'completed')).toBe(true);
        // Records when the run settled, which starts the binding's window.
        expect(await bureau.locateRunCreationReceipt(locate)).toMatchObject({ status: 'recorded' });

        // `retention.tasks` equals the binding retention, and the horizon passes
        // before the ledger sweep has run: the binding is expired but stored.
        at(60_001);
        expect(await bureau.locateRunCreationReceipt(locate)).toMatchObject({ status: 'expired' });
        await bureau.runDurableMaintenance();

        // The sweep deleted the binding in this pass, after the task step had
        // already seen it: the task survives, and the retry finds nothing bound.
        expect(await bureau.locateRunCreationReceipt(locate)).toMatchObject({
          status: 'not-found',
        });
        expect(bureau.getRun(created.id)).toBeDefined();

        await bureau.runDurableMaintenance();
        expect(bureau.getRun(created.id)).toBeUndefined();
      },
      { retention: { tasks: { olderThan: 60_000 }, receipts: { olderThan: 60_000 } } },
    );
  });

  it('keeps every task under "forever"', async () => {
    await withBureau(
      async ({ bureau, at }) => {
        const run = await settledRun(bureau);
        at(10_000 * DAY_MS);
        await bureau.runDurableMaintenance();
        expect(bureau.getRun(run.id)).toBeDefined();
      },
      { retention: { tasks: 'forever' } },
    );
  });

  it('rejects a window that is not a finite, non-negative number', async () => {
    const failure = await rejectionOf(
      createBureau<AgentDefinitions>({
        agents: {
          default: createAgent({ generate: finishes, toolbox: createToolbox<readonly Tool[]>([]) }),
        },
        retention: { tasks: { olderThan: -1 } },
      }),
    );
    expect(failure).toMatchObject({ code: 'BAD_REQUEST' });
  });
});

/** A model that answers at once until `hold.on` is set, then holds every call behind `gate`. */
function holdableGenerate(hold: { on: boolean }, gate: Promise<void>): GenerateFunction {
  const waits = finishesAfter(gate);
  return async (...input) => (hold.on ? waits(...input) : finishes(...input));
}

describe('runDurableMaintenance in a fully ephemeral bureau (COR-1477)', () => {
  it('reports true when task retention removed runs, and undefined when it removed none', async () => {
    const runtime = createManualRuntimeServices({ origin: ORIGIN });
    const bureau = await createBureau<AgentDefinitions>({
      agents: {
        default: createAgent({
          generate: finishes,
          stopWhen: stopWhen.noToolCalls(),
          toolbox: createToolbox<readonly Tool[]>([]),
        }),
      },
      runtime,
      retention: { tasks: { olderThan: DAY_MS } },
    });
    try {
      const created = await bureau.createRun({
        agentName: 'default',
        message: 'work',
        principal: 'alice',
      });
      expect(await pollUntil(() => bureau.getRun(created.id)?.status === 'completed')).toBe(true);

      // Inside the window: nothing to maintain.
      expect(await bureau.runDurableMaintenance()).toBeUndefined();
      expect(bureau.getRun(created.id)).toBeDefined();

      runtime.setTime(ORIGIN_MS + DAY_MS + 1);
      expect(await bureau.runDurableMaintenance()).toBe(true);
      expect(bureau.getRun(created.id)).toBeUndefined();

      // Nothing left to remove.
      expect(await bureau.runDurableMaintenance()).toBeUndefined();
    } finally {
      await bureau.dispose();
    }
  });
});
