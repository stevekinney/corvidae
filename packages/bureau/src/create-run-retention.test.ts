/**
 * COR-424 — the run-creation binding's retention window through `createRun`
 * and `locateRunCreationReceipt`, over both persistent backends. Within the
 * window an exact retry replays the original receipt; once it has passed, a
 * receipt query reports `expired` and the same request id creates a new run.
 * The window is measured on the bureau's injected runtime clock, which these
 * tests move with `setTime`.
 */
import {
  createManualRuntimeServices,
  type ManualRuntimeServices,
  type RuntimeServices,
} from '@lostgradient/lifecycle';
import { type GenerateFunction, stopWhen, createAgent } from '@lostgradient/operative';
import { createToolbox, type Tool } from 'armorer';
import { describe, expect, it } from 'bun:test';

import {
  BureauLedgerConflictError,
  type RunCreationReceipt,
  type RunCreationReceiptLocation,
} from './command-ledger';
import { BureauError, createBureau } from './create-bureau';
import {
  type BureauStorageFixture,
  createLmdbStorageFixture,
  createSqliteStorageFixture,
} from './test/storage-fixtures';
import { rejectionOf } from './testing/promise-outcome.test-support.ts';
import type { Bureau, BureauOptions, CreateRunRequest } from './types';
import type { AgentDefinitions } from './agent-catalog';

const ORIGIN = '2026-10-13T00:00:00.000Z';
const ORIGIN_MS = Date.parse(ORIGIN);
const DAY_MS = 86_400_000;

const REQUEST: CreateRunRequest = {
  agentName: 'default',
  message: 'Summarize the quarter.',
  principal: 'alice',
  runCreationRequestId: 'request-1',
};

const LOCATE = {
  principal: 'alice',
  agentName: 'default',
  commandId: 'request-1',
} as const;

type FixtureFactory = (runtime: RuntimeServices) => BureauStorageFixture;

const BACKENDS: readonly (readonly [string, FixtureFactory])[] = [
  ['sqlite', (runtime) => createSqliteStorageFixture({ runtime })],
  // Relaxed durability drops LMDB's per-commit sync, which cost each case here more than a second
  // on a quiet host (COR-1576). The window is read from the injected clock and nothing restarts, so
  // no case depends on a commit surviving a crash.
  ['lmdb', (runtime) => createLmdbStorageFixture({ runtime, durability: 'relaxed' })],
];

const finishes: GenerateFunction = async () => ({ content: 'done', toolCalls: [] });

/** A model that answers once `gate` opens, so a test decides when its run settles. */
function finishesAfter(gate: Promise<void>): GenerateFunction {
  return async () => {
    await gate;
    return { content: 'done', toolCalls: [] };
  };
}

/**
 * Runs `body` against a durable bureau over a fresh store whose runs finish
 * at their first step, then tears both down.
 */
async function withBureau(
  factory: FixtureFactory,
  body: (bureau: Bureau, runtime: ManualRuntimeServices) => Promise<void>,
  overrides: Partial<BureauOptions> = {},
): Promise<void> {
  const runtime = createManualRuntimeServices({ origin: ORIGIN });
  const fixture = factory(runtime);
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
    ...overrides,
  });
  try {
    await body(bureau, runtime);
  } finally {
    await bureau.dispose();
    await fixture.dispose();
  }
}

/**
 * A bounded poll with a small real delay between checks; never a blind sleep.
 * A zero-delay poll starves LMDB's own completion callbacks (see
 * `run-creation-fault-points.test.ts`).
 */
async function pollUntil(check: () => boolean): Promise<boolean> {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return check();
}

/** Creates the request's run, waits for it to finish, and lets a receipt query observe that. */
async function settledRun(bureau: Bureau, request: CreateRunRequest = REQUEST) {
  const created = await bureau.createRun(request);
  expect(await pollUntil(() => bureau.tasks.detail(created.id)?.status === 'completed')).toBe(true);
  expect(await bureau.tasks.receipt(LOCATE)).toEqual(recorded(created.receipt, created.sessionId));
  return created;
}

/** The location of a recorded receipt; fails when the run carried none. */
function recorded(
  receipt: RunCreationReceipt | undefined,
  sessionId?: string,
): RunCreationReceiptLocation {
  if (receipt === undefined) throw new Error('expected the run to carry a receipt');
  return { status: 'recorded', receipt, sessionId: sessionId ?? (expect.any(String) as string) };
}

async function durableRunIds(bureau: Bureau): Promise<string[] | undefined> {
  const page = await bureau.tasks.workflows();
  return page?.items.map((run) => run.id).toSorted();
}

describe.each(BACKENDS)('run-creation retention over %s', (_backend, factory) => {
  it('replays the original receipt for an exact retry within the window', async () => {
    await withBureau(factory, async (bureau, runtime) => {
      const created = await settledRun(bureau);

      runtime.setTime(ORIGIN_MS + DAY_MS - 1);
      const retry = await bureau.createRun(REQUEST);

      expect(retry.id).toBe(created.id);
      expect(retry.receipt).toEqual(created.receipt);
      expect(await durableRunIds(bureau)).toEqual([created.id]);
    });
  });

  it('reports the receipt expired after the window, and the same request id creates a new run', async () => {
    await withBureau(factory, async (bureau, runtime) => {
      const created = await settledRun(bureau);

      runtime.setTime(ORIGIN_MS + DAY_MS);
      expect(await bureau.tasks.receipt(LOCATE)).toEqual({
        status: 'expired',
        requestId: 'request-1',
        expiredAt: new Date(ORIGIN_MS + DAY_MS).toISOString(),
      });
      const fresh = await bureau.createRun(REQUEST);

      expect(fresh.id).not.toBe(created.id);
      expect(fresh.receipt).toEqual({
        runId: fresh.id,
        requestId: 'request-1',
        createdAt: new Date(ORIGIN_MS + DAY_MS).toISOString(),
        status: 'running',
      });
      expect(await durableRunIds(bureau)).toEqual([created.id, fresh.id].toSorted());
      expect(await bureau.tasks.receipt(LOCATE)).toEqual(recorded(fresh.receipt));
    });
  });

  it('no longer reports a conflict for a different payload once the binding has expired', async () => {
    await withBureau(factory, async (bureau, runtime) => {
      const created = await settledRun(bureau);
      const changed = { ...REQUEST, message: 'Summarize the year.' };
      expect(await rejectionOf(bureau.createRun(changed))).toBeInstanceOf(
        BureauLedgerConflictError,
      );

      runtime.setTime(ORIGIN_MS + DAY_MS);
      const fresh = await bureau.createRun(changed);

      expect(fresh.id).not.toBe(created.id);
      expect(fresh.receipt).toMatchObject({ runId: fresh.id, requestId: 'request-1' });
      expect(await durableRunIds(bureau)).toEqual([created.id, fresh.id].toSorted());
    });
  });

  it('honors a configured window', async () => {
    await withBureau(
      factory,
      async (bureau, runtime) => {
        const created = await settledRun(bureau);

        runtime.setTime(ORIGIN_MS + 59_999);
        expect(await bureau.createRun(REQUEST)).toMatchObject({ id: created.id });

        runtime.setTime(ORIGIN_MS + 60_000);
        expect(await bureau.tasks.receipt(LOCATE)).toMatchObject({ status: 'expired' });
        const fresh = await bureau.createRun(REQUEST);
        expect(fresh.id).not.toBe(created.id);
      },
      { retention: { receipts: { olderThan: 60_000 } } },
    );
  });

  it('expires a run nobody queried at its terminal time plus the window', async () => {
    const gate = Promise.withResolvers<void>();
    await withBureau(
      factory,
      async (bureau, runtime) => {
        const created = await bureau.createRun(REQUEST);
        const settledAt = ORIGIN_MS + 5_000;
        runtime.setTime(settledAt);
        gate.resolve();
        expect(await pollUntil(() => bureau.tasks.detail(created.id)?.status === 'completed')).toBe(
          true,
        );

        // No retry or query observes the run until a week later.
        runtime.setTime(ORIGIN_MS + 7 * DAY_MS);
        expect(await bureau.tasks.receipt(LOCATE)).toEqual({
          status: 'expired',
          requestId: 'request-1',
          expiredAt: new Date(settledAt + DAY_MS).toISOString(),
        });
        const fresh = await bureau.createRun(REQUEST);
        expect(fresh.id).not.toBe(created.id);
      },
      {
        agents: { default: createAgent({ generate: finishesAfter(gate.promise) }) },
      },
    );
  });

  it('deletes an expired binding and its conflict records in durable maintenance', async () => {
    await withBureau(
      factory,
      async (bureau, runtime) => {
        const created = await settledRun(bureau);
        expect(
          await rejectionOf(bureau.createRun({ ...REQUEST, message: 'Summarize the year.' })),
        ).toBeInstanceOf(BureauLedgerConflictError);

        runtime.setTime(ORIGIN_MS + DAY_MS - 1);
        expect(await bureau.runDurableMaintenance()).toBe(true);
        expect(await bureau.tasks.receipt(LOCATE)).toEqual(recorded(created.receipt));

        runtime.setTime(ORIGIN_MS + DAY_MS);
        expect(await bureau.runDurableMaintenance()).toBe(true);
        expect(await bureau.tasks.receipt(LOCATE)).toEqual({
          status: 'not-found',
          requestId: 'request-1',
        });
      },
      { maintenance: 'manual' },
    );
  });
});

describe('locateRunCreationReceipt', () => {
  it('reports a request id it never saw as not found', async () => {
    await withBureau(BACKENDS[0]![1], async (bureau) => {
      expect(await bureau.tasks.receipt(LOCATE)).toEqual({
        status: 'not-found',
        requestId: 'request-1',
      });
    });
  });

  it('scopes the query to the caller and the published agent', async () => {
    await withBureau(BACKENDS[0]![1], async (bureau) => {
      await settledRun(bureau);
      expect(await bureau.tasks.receipt({ ...LOCATE, principal: 'mallory' })).toMatchObject({
        status: 'not-found',
      });
      expect(await bureau.tasks.receipt({ ...LOCATE, agentName: 'other-agent' })).toMatchObject({
        status: 'not-found',
      });
      expect(await bureau.tasks.receipt({ ...LOCATE, agentName: 'default' })).toMatchObject({
        status: 'recorded',
      });
    });
  });

  it('requires a principal and a request id', async () => {
    await withBureau(BACKENDS[0]![1], async (bureau) => {
      for (const request of [
        { principal: ' ', commandId: 'request-1' },
        { principal: 'alice', commandId: '' },
      ]) {
        const failure = await rejectionOf(bureau.tasks.receipt(request));
        expect(failure).toBeInstanceOf(BureauError);
        expect((failure as BureauError).code).toBe('BAD_REQUEST');
      }
    });
  });

  it('offers no receipts without a durable engine', async () => {
    const bureau = await createBureau<AgentDefinitions>({
      agents: {
        default: createAgent({ generate: finishes, toolbox: createToolbox<readonly Tool[]>([]) }),
      },
      runtime: createManualRuntimeServices({ origin: ORIGIN }),
    });
    try {
      const failure = await rejectionOf(bureau.tasks.receipt(LOCATE));
      expect(failure).toBeInstanceOf(BureauError);
      expect((failure as BureauError).code).toBe('NOT_CONFIGURED');
    } finally {
      await bureau.dispose();
    }
  });
});

describe('retention.receipts', () => {
  it.each([0, -1, 1.5])('rejects %p at construction', async (receiptMilliseconds) => {
    const failure = await rejectionOf(
      createBureau<AgentDefinitions>({
        agents: {
          default: createAgent({ generate: finishes, toolbox: createToolbox<readonly Tool[]>([]) }),
        },
        runtime: createManualRuntimeServices({ origin: ORIGIN }),
        retention: { receipts: { olderThan: receiptMilliseconds } },
      }),
    );
    expect(failure).toBeInstanceOf(BureauError);
    expect((failure as BureauError).code).toBe('BAD_REQUEST');
  });
});
