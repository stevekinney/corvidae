/**
 * COR-424 — `createRun` through the command ledger, end to end: a retried
 * run-creation request with the same caller, request id, and payload returns
 * the original run and receipt instead of creating a second run.
 */
import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { type GenerateFunction, waitForCondition } from '@lostgradient/operative';
import { createToolbox, type Tool } from 'armorer';
import { describe, expect, it } from 'bun:test';

import { BureauLedgerConflictError } from './command-ledger';
import { BureauError, createBureau } from './create-bureau';
import { createSqliteStorageFixture } from './test/storage-fixtures';
import { rejectionOf } from './testing/promise-outcome.test-support.ts';

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

describe('createRun with a run-creation request id', () => {
  it('returns the same run and the original receipt on an exact retry, persisting one run', async () => {
    const held = heldGenerate();
    const bureau = await createBureau({
      agents: {},
      generate: held.generate,
      toolbox: createToolbox<readonly Tool[]>([]),
      runtime: createManualRuntimeServices({ origin: ORIGIN }),
    });
    try {
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
      expect(bureau.listRuns().map((run) => run.id)).toEqual([first.id]);
    } finally {
      held.release();
      await bureau.dispose();
    }
  });

  it('persists exactly one durable run for an exact retry over SQLite', async () => {
    const runtime = createManualRuntimeServices({ origin: ORIGIN });
    const fixture = createSqliteStorageFixture({ runtime });
    const held = heldGenerate();
    const bureau = await createBureau({
      agents: {},
      generate: held.generate,
      toolbox: createToolbox<readonly Tool[]>([]),
      runtime,
      storage: fixture.configuration,
      durableExecution: true,
      durableOwnership: { ownership: 'none' },
    });
    try {
      const first = await bureau.createRun(REQUEST);
      const retry = await bureau.createRun(REQUEST);

      expect(retry.id).toBe(first.id);
      expect(retry.receipt).toEqual(first.receipt);
      const durableRuns = await bureau.listDurableRuns();
      expect(durableRuns?.items.map((run) => run.id)).toEqual([first.id]);
      expect(bureau.listRuns().map((run) => run.id)).toEqual([first.id]);
    } finally {
      held.release();
      await bureau.dispose();
      await fixture.dispose();
    }
  });

  it('rejects the same request id with a different payload as a typed conflict', async () => {
    const held = heldGenerate();
    const bureau = await createBureau({
      agents: {},
      generate: held.generate,
      toolbox: createToolbox<readonly Tool[]>([]),
      runtime: createManualRuntimeServices({ origin: ORIGIN }),
    });
    try {
      const first = await bureau.createRun(REQUEST);
      const conflict = await rejectionOf(
        bureau.createRun({ ...REQUEST, message: 'Summarize the year.' }),
      );

      expect(conflict).toBeInstanceOf(BureauLedgerConflictError);
      expect(conflict).toMatchObject({ requestId: 'request-1', reason: 'payload-mismatch' });
      expect(bureau.listRuns().map((run) => run.id)).toEqual([first.id]);

      // The original entry is unaffected: an exact retry still replays it.
      const retry = await bureau.createRun(REQUEST);
      expect(retry.receipt).toEqual(first.receipt);
    } finally {
      held.release();
      await bureau.dispose();
    }
  });

  it('scopes the request id to the caller', async () => {
    const held = heldGenerate();
    const bureau = await createBureau({
      agents: {},
      generate: held.generate,
      toolbox: createToolbox<readonly Tool[]>([]),
      runtime: createManualRuntimeServices({ origin: ORIGIN }),
    });
    try {
      const alice = await bureau.createRun(REQUEST);
      const bob = await bureau.createRun({ ...REQUEST, principal: 'bob' });

      expect(bob.id).not.toBe(alice.id);
      expect(bureau.listRuns()).toHaveLength(2);
    } finally {
      held.release();
      await bureau.dispose();
    }
  });

  it('requires an authenticated principal to own the request id', async () => {
    const bureau = await createBureau({
      agents: {},
      generate: async () => ({ content: 'done', toolCalls: [] }),
      toolbox: createToolbox<readonly Tool[]>([]),
      runtime: createManualRuntimeServices({ origin: ORIGIN }),
    });
    try {
      const rejection = await rejectionOf(
        bureau.createRun({ message: 'hi', runCreationRequestId: 'request-1' }),
      );
      expect(rejection).toBeInstanceOf(BureauError);
      expect((rejection as BureauError).code).toBe('BAD_REQUEST');

      const blank = await rejectionOf(
        bureau.createRun({ message: 'hi', principal: 'alice', runCreationRequestId: ' ' }),
      );
      expect(blank).toBeInstanceOf(BureauError);
      expect((blank as BureauError).code).toBe('BAD_REQUEST');
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
    const held = heldGenerate();
    const bureau = await createBureau({
      agents: {},
      generate: held.generate,
      toolbox: createToolbox<readonly Tool[]>([]),
      runtime: createManualRuntimeServices({ origin: ORIGIN }),
      flowControl: { singleton: { key: (trigger) => trigger.message } },
    });
    try {
      const first = await bureau.createRun(REQUEST);
      const retry = await bureau.createRun(REQUEST);

      expect(retry.id).toBe(first.id);
      expect(retry.receipt).toEqual(first.receipt);
    } finally {
      held.release();
      await bureau.dispose();
    }
  });

  it('releases the claim when flow control rejects a fresh request, so a later retry starts the run', async () => {
    const held = heldGenerate();
    const bureau = await createBureau({
      agents: {},
      generate: held.generate,
      toolbox: createToolbox<readonly Tool[]>([]),
      runtime: createManualRuntimeServices({ origin: ORIGIN }),
      flowControl: { concurrency: { limit: 1, key: () => 'all-runs' } },
    });
    try {
      const occupying = await bureau.createRun({ message: 'first', principal: 'alice' });
      const rejected = await rejectionOf(bureau.createRun(REQUEST));
      expect(rejected).toBeInstanceOf(BureauError);
      expect((rejected as BureauError).code).toBe('RATE_LIMITED');

      held.release();
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
    } finally {
      held.release();
      await bureau.dispose();
    }
  });
});
