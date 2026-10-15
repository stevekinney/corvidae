/**
 * COR-424 — `createRun` through the command ledger, end to end: a retried
 * run-creation request with the same caller, agent, request id, and payload
 * returns the original run and receipt instead of creating a second run.
 *
 * Receipts are offered only by a bureau whose runs survive a restart, so
 * every ledgered scenario here runs a durable bureau over SQLite.
 */
import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { type GenerateFunction, waitForCondition } from '@lostgradient/operative';
import { createToolbox, type Tool } from 'armorer';
import { describe, expect, it } from 'bun:test';

import { BureauLedgerConflictError } from './command-ledger';
import { BureauError, createBureau } from './create-bureau';
import { createSqliteStorageFixture } from './test/storage-fixtures';
import { rejectionOf } from './testing/promise-outcome.test-support.ts';
import type { Bureau, BureauOptions } from './types';

const ORIGIN = '2026-10-13T00:00:00.000Z';

/** A generate that holds every run at its first step until `release()`. */
function heldGenerate(): { generate: GenerateFunction; release(): void } {
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    generate: async () => {
      await released;
      return { content: 'done', toolCalls: [] };
    },
    release: () => release(),
  };
}

const REQUEST = {
  message: 'Summarize the quarter.',
  principal: 'alice',
  runCreationRequestId: 'request-1',
} as const;

type ExtraOptions = Pick<BureauOptions, 'flowControl' | 'maximumSteps' | 'systemPrompt'>;

/**
 * Runs `body` against a durable bureau over a fresh SQLite file whose runs
 * are held until `release()`, then tears both down.
 */
async function withDurableBureau(
  body: (bureau: Bureau, release: () => void) => Promise<void>,
  extra: ExtraOptions = {},
): Promise<void> {
  const runtime = createManualRuntimeServices({ origin: ORIGIN });
  const fixture = createSqliteStorageFixture({ runtime });
  const held = heldGenerate();
  const bureau = await createBureau({
    ...extra,
    agents: {},
    generate: held.generate,
    toolbox: createToolbox<readonly Tool[]>([]),
    runtime,
    storage: fixture.configuration,
    durableExecution: true,
    durableOwnership: { ownership: 'none' },
  });
  try {
    await body(bureau, held.release);
  } finally {
    held.release();
    await bureau.dispose();
    await fixture.dispose();
  }
}

async function durableRunIds(bureau: Bureau): Promise<string[] | undefined> {
  const page = await bureau.listDurableRuns();
  return page?.items.map((run) => run.id).toSorted();
}

describe('createRun with a run-creation request id', () => {
  it('returns the same run and the original receipt on an exact retry, persisting one run', async () => {
    await withDurableBureau(async (bureau) => {
      const first = await bureau.createRun(REQUEST);
      const retry = await bureau.createRun(REQUEST);

      expect(first.receipt).toEqual({
        runId: first.id,
        requestId: 'request-1',
        createdAt: ORIGIN,
        status: 'running',
      });
      expect(retry.id).toBe(first.id);
      expect(retry.sessionId).toBe(first.sessionId);
      expect(retry.receipt).toEqual(first.receipt);
      expect(await durableRunIds(bureau)).toEqual([first.id]);
      expect(bureau.listRuns().map((run) => run.id)).toEqual([first.id]);
    });
  });

  it('creates one run for two identical requests issued concurrently', async () => {
    await withDurableBureau(async (bureau) => {
      const [first, second] = await Promise.all([
        bureau.createRun(REQUEST),
        bureau.createRun(REQUEST),
      ]);

      expect(second.id).toBe(first.id);
      expect(second.receipt).toEqual(first.receipt);
      expect(await durableRunIds(bureau)).toEqual([first.id]);
    });
  });

  it('treats a retry that spells out the defaults it first omitted as the same command', async () => {
    await withDurableBureau(
      async (bureau) => {
        const first = await bureau.createRun(REQUEST);
        const retry = await bureau.createRun({
          ...REQUEST,
          agentName: 'bureau',
          systemPrompt: 'You keep the books.',
          maximumSteps: 7,
        });

        expect(retry.id).toBe(first.id);
        expect(retry.receipt).toEqual(first.receipt);
        expect(await durableRunIds(bureau)).toEqual([first.id]);

        // A value that differs from the default is a different command.
        const conflict = await rejectionOf(bureau.createRun({ ...REQUEST, maximumSteps: 8 }));
        expect(conflict).toBeInstanceOf(BureauLedgerConflictError);
      },
      { systemPrompt: 'You keep the books.', maximumSteps: 7 },
    );
  });

  it('rejects the same request id with a different payload as a typed conflict carrying the original receipt', async () => {
    await withDurableBureau(async (bureau) => {
      const first = await bureau.createRun(REQUEST);
      const conflict = await rejectionOf(
        bureau.createRun({ ...REQUEST, message: 'Summarize the year.' }),
      );

      expect(conflict).toBeInstanceOf(BureauLedgerConflictError);
      expect(conflict).not.toBeInstanceOf(BureauError);
      expect(conflict).toMatchObject({
        requestId: 'request-1',
        reason: 'payload-mismatch',
        originalReceipt: first.receipt,
      });
      expect(bureau.listRuns().map((run) => run.id)).toEqual([first.id]);

      // The original entry is unaffected: an exact retry still replays it.
      const retry = await bureau.createRun(REQUEST);
      expect(retry.receipt).toEqual(first.receipt);
    });
  });

  it('creates one run per published agent for one request id', async () => {
    await withDurableBureau(async (bureau) => {
      const forBureau = await bureau.createRun(REQUEST);
      const forResearcher = await bureau.createRun({ ...REQUEST, agentName: 'researcher' });
      const researcherRetry = await bureau.createRun({ ...REQUEST, agentName: 'researcher' });

      expect(forResearcher.id).not.toBe(forBureau.id);
      expect(researcherRetry.id).toBe(forResearcher.id);
      expect(await durableRunIds(bureau)).toEqual([forBureau.id, forResearcher.id].toSorted());
    });
  });

  it('scopes the request id to the caller', async () => {
    await withDurableBureau(async (bureau) => {
      const alice = await bureau.createRun(REQUEST);
      const bob = await bureau.createRun({ ...REQUEST, principal: 'bob' });

      expect(bob.id).not.toBe(alice.id);
      expect(bureau.listRuns()).toHaveLength(2);
    });
  });

  it('keys the request id without surrounding whitespace', async () => {
    await withDurableBureau(async (bureau) => {
      const first = await bureau.createRun(REQUEST);
      const retry = await bureau.createRun({ ...REQUEST, runCreationRequestId: ' request-1 ' });

      expect(retry.id).toBe(first.id);
      expect(retry.receipt).toEqual(first.receipt);
      expect(await durableRunIds(bureau)).toEqual([first.id]);
    });
  });

  it('keys the principal exactly as the run records its owner', async () => {
    await withDurableBureau(async (bureau) => {
      const padded = await bureau.createRun({ ...REQUEST, principal: ' alice ' });
      const exact = await bureau.createRun(REQUEST);

      // A padded principal is a different owner, so it never replays to `alice`.
      expect(exact.id).not.toBe(padded.id);
      expect(await durableRunIds(bureau)).toEqual([padded.id, exact.id].toSorted());
      const located = await bureau.locateRunCreationReceipt({
        principal: 'alice',
        runCreationRequestId: 'request-1',
      });
      expect(located.status === 'recorded' && located.receipt.runId).toBe(exact.id);
    });
  });

  it('requires an authenticated principal to own the request id', async () => {
    await withDurableBureau(async (bureau) => {
      for (const request of [
        { message: 'hi', runCreationRequestId: 'request-1' },
        { message: 'hi', principal: ' ', runCreationRequestId: 'request-1' },
        { message: 'hi', principal: 'alice', runCreationRequestId: ' ' },
      ]) {
        const rejection = await rejectionOf(bureau.createRun(request));
        expect(rejection).toBeInstanceOf(BureauError);
        expect((rejection as BureauError).code).toBe('BAD_REQUEST');
      }
      expect(bureau.listRuns()).toEqual([]);
    });
  });

  it('offers no receipts without a durable engine', async () => {
    const bureau = await createBureau({
      agents: {},
      generate: async () => ({ content: 'done', toolCalls: [] }),
      toolbox: createToolbox<readonly Tool[]>([]),
      runtime: createManualRuntimeServices({ origin: ORIGIN }),
    });
    try {
      const rejection = await rejectionOf(bureau.createRun(REQUEST));
      expect(rejection).toBeInstanceOf(BureauError);
      expect(rejection).toMatchObject({ code: 'NOT_CONFIGURED', subject: 'durable' });
      expect(bureau.listRuns()).toEqual([]);
    } finally {
      await bureau.dispose();
    }
  });

  it('leaves a request without a request id unledgered', async () => {
    const held = heldGenerate();
    const bureau = await createBureau({
      agents: {},
      generate: held.generate,
      toolbox: createToolbox<readonly Tool[]>([]),
      runtime: createManualRuntimeServices({ origin: ORIGIN }),
    });
    try {
      const first = await bureau.createRun({ message: 'hi', principal: 'alice' });
      const second = await bureau.createRun({ message: 'hi', principal: 'alice' });

      expect(first.receipt).toBeUndefined();
      expect(second.id).not.toBe(first.id);
    } finally {
      held.release();
      await bureau.dispose();
    }
  });

  it('replays an exact retry instead of letting flow control reject it as a duplicate', async () => {
    await withDurableBureau(
      async (bureau) => {
        const first = await bureau.createRun(REQUEST);
        const retry = await bureau.createRun(REQUEST);

        expect(retry.id).toBe(first.id);
        expect(retry.receipt).toEqual(first.receipt);
      },
      { flowControl: { singleton: { key: (trigger) => trigger.message } } },
    );
  });

  it('releases the claim when flow control rejects a fresh request, so a later retry starts the run', async () => {
    await withDurableBureau(
      async (bureau, release) => {
        const occupying = await bureau.createRun({ message: 'first', principal: 'alice' });
        const rejected = await rejectionOf(bureau.createRun(REQUEST));
        expect(rejected).toBeInstanceOf(BureauError);
        expect((rejected as BureauError).code).toBe('RATE_LIMITED');

        release();
        await waitForCondition(
          () => bureau.getRun(occupying.id)?.status === 'completed',
          'the occupying run did not complete',
        );

        const retry = await bureau.createRun(REQUEST);
        expect(retry.id).not.toBe(occupying.id);
        expect(retry.receipt).toMatchObject({ runId: retry.id, requestId: 'request-1' });
        expect(
          bureau
            .listRuns()
            .map((run) => run.id)
            .toSorted(),
        ).toEqual([occupying.id, retry.id].toSorted());
      },
      { flowControl: { concurrency: { limit: 1, key: () => 'all-runs' } } },
    );
  });
});
