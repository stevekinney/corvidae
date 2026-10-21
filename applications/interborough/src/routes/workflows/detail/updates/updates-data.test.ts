import { describe, expect, test } from 'bun:test';

import { throwingRejectionOf } from '@lostgradient/testing';
import { HttpClientError } from '@lostgradient/weft';

import {
  describeUpdate,
  entryNeedsResult,
  isSubmissionTimeout,
  readUpdateResult,
  sendUpdate,
  type UpdateHistoryEntry,
  type UpdatesClient,
} from './updates-data.ts';

function entry(outcome: UpdateHistoryEntry['outcome'], error?: string): UpdateHistoryEntry {
  return {
    updateId: 'u-1',
    name: 'applyDiscount',
    receivedAt: 1_000,
    outcome,
    ...(outcome === 'pending' ? {} : { completedAt: 1_100 }),
    ...(error === undefined ? {} : { error }),
  };
}

describe('describeUpdate', () => {
  test('shows a failed update’s stored message whatever the result lookup says', () => {
    expect(describeUpdate(entry('failed', 'insufficient balance'), undefined, false)).toEqual({
      kind: 'failed',
      message: 'insufficient balance',
    });
    expect(describeUpdate(entry('failed'), { status: 'pending' }, true)).toEqual({
      kind: 'failed',
      message: 'The update failed.',
    });
  });

  test('tells a pending update on a live run from one on a run that has ended', () => {
    expect(describeUpdate(entry('pending'), undefined, false)).toEqual({ kind: 'awaiting' });
    expect(describeUpdate(entry('pending'), undefined, true)).toEqual({ kind: 'never-answered' });
  });

  test('shows a completed update’s result, loading it first, and says so when it was swept', () => {
    expect(describeUpdate(entry('completed'), undefined, false)).toEqual({
      kind: 'loading-result',
    });
    expect(
      describeUpdate(
        entry('completed'),
        { status: 'completed', result: 42, error: undefined },
        true,
      ),
    ).toEqual({ kind: 'result', value: 42 });
    expect(describeUpdate(entry('completed'), { status: 'pending' }, false)).toEqual({
      kind: 'swept',
    });
  });
});

describe('entryNeedsResult', () => {
  test('is true only for a completed update', () => {
    expect(entryNeedsResult(entry('completed'))).toBe(true);
    expect(entryNeedsResult(entry('pending'))).toBe(false);
    expect(entryNeedsResult(entry('failed', 'x'))).toBe(false);
  });
});

describe('isSubmissionTimeout', () => {
  test('recognises a timeout by status or by fault code, over either transport', () => {
    // REST: the status. JSON-RPC: the fault code, and the status the envelope carries.
    expect(isSubmissionTimeout(new HttpClientError(504, 'timed out'))).toBe(true);
    expect(
      isSubmissionTimeout(
        new HttpClientError(504, 'timed out', {
          faultCode: 'Timeout',
          data: { updateId: 'u-1', weftCode: 'Timeout', httpStatus: 504 },
        }),
      ),
    ).toBe(true);
    expect(
      isSubmissionTimeout(new HttpClientError(500, 'timed out', { faultCode: 'Timeout' })),
    ).toBe(true);
  });

  test('does not call any other failure a timeout', () => {
    expect(isSubmissionTimeout(new HttpClientError(422, 'refused'))).toBe(false);
    // `Request Timeout` is no longer what the server answers a timeout with: nothing treats it as one.
    expect(isSubmissionTimeout(new HttpClientError(408, 'timed out'))).toBe(false);
    expect(isSubmissionTimeout(new Error('network unreachable'))).toBe(false);
    expect(isSubmissionTimeout('boom')).toBe(false);
    expect(isSubmissionTimeout(null)).toBe(false);
  });
});

describe('readUpdateResult', () => {
  function clientAnswering(answer: unknown): UpdatesClient {
    return {
      operations: {
        'weft.workflows.updates.list': async () => ({ items: [] }),
        'weft.updates.result.get': async () => answer,
        'weft.workflows.update': async () => ({ updateId: 'u-1', result: null }),
      },
    };
  }

  test('reads a pending and a completed answer', async () => {
    expect(await readUpdateResult(clientAnswering({ status: 'pending' }), 'u-1')).toEqual({
      status: 'pending',
    });
    expect(
      await readUpdateResult(clientAnswering({ status: 'completed', result: { ok: true } }), 'u-1'),
    ).toEqual({ status: 'completed', result: { ok: true }, error: undefined });
  });

  test('refuses a shape or a status it does not know', async () => {
    const noShape = await throwingRejectionOf(readUpdateResult(clientAnswering(null), 'u-1'));
    expect(noShape).toThrow('unexpected shape');
    const noStatus = await throwingRejectionOf(
      readUpdateResult(clientAnswering({ status: 'gone' }), 'u-1'),
    );
    expect(noStatus).toThrow('unexpected status');
  });
});

describe('sendUpdate', () => {
  test('sends the name as updateName, and leaves out a payload or key it was not given', async () => {
    const sent: unknown[] = [];
    const client = {
      operations: {
        'weft.workflows.update': async (input: unknown) => {
          sent.push(input);
          return { updateId: 'u-1', result: null };
        },
      },
    } as unknown as UpdatesClient;

    await sendUpdate(client, 'wf-1', {
      name: 'applyDiscount',
      payload: undefined,
      timeoutMs: 1_000,
      idempotencyKey: undefined,
    });
    await sendUpdate(client, 'wf-1', {
      name: 'applyDiscount',
      payload: { code: 'SAVE10' },
      timeoutMs: 5_000,
      idempotencyKey: 'key-1',
    });

    expect(sent).toEqual([
      { workflowId: 'wf-1', updateName: 'applyDiscount', timeout: 1_000 },
      {
        workflowId: 'wf-1',
        updateName: 'applyDiscount',
        payload: { code: 'SAVE10' },
        timeout: 5_000,
        idempotencyKey: 'key-1',
      },
    ]);
  });
});
