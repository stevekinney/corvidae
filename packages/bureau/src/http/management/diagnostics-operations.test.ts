/**
 * COR-1731 — `bureau.diagnostics.get` over a real Bureau and its handler: the scope that gates it,
 * the snapshot it returns being the Bureau's own, and what its wire form carries.
 */
import { createAgent, stopWhen } from '@lostgradient/operative';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { afterEach, describe, expect, it } from 'bun:test';

import { BUREAU_HANDLER_OPERATIONS } from '../create-bureau-handler.ts';
import { diagnosticsGetOperation } from './diagnostics-operations.ts';
import {
  approvalToolbox,
  chargesOnce,
  openBureau,
  type OpenedBureau,
  rpc,
} from './management-fixtures.test-support.ts';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

async function open(options: Parameters<typeof openBureau>[0] = {}): Promise<OpenedBureau> {
  const opened = await openBureau(options);
  cleanups.push(() => opened.dispose());
  return opened;
}

describe('bureau.diagnostics.get', () => {
  it('is served', () => {
    expect(BUREAU_HANDLER_OPERATIONS).toContain(diagnosticsGetOperation);
  });

  it('describes itself and every field it returns', () => {
    expect(diagnosticsGetOperation.description).toContain('bureau.diagnostics:read');
    const shape = diagnosticsGetOperation.outputSchema.shape;
    for (const [name, schema] of Object.entries(shape)) {
      expect({ name, description: schema.description }).toEqual({
        name,
        description: expect.any(String),
      });
    }
  });

  it('answers a caller holding bureau.diagnostics:read with the Bureau’s own reading', async () => {
    const opened = await open();

    const answered = await rpc(
      opened.handler,
      'bureau.diagnostics.get',
      {},
      'diagnostics-reader-key',
    );

    expect(answered.error).toBeUndefined();
    expect(answered.result).toEqual({
      recovery: { status: 'clean', failedRunCount: 0 },
      lifecycle: 'ready',
      liveFrameSubscriberCount: 0,
      eventFeedSubscriberCount: 0,
      watchers: [],
      modelCatalogRevision: 1,
      runningRunCount: 0,
      abortingRunCount: 0,
      pendingReviewCount: 0,
    });
    expect(answered.result).toEqual(
      JSON.parse(JSON.stringify(opened.bureau.internals.diagnostics())),
    );
  });

  it('answers the operator, who holds every scope', async () => {
    const opened = await open();

    const answered = await rpc(opened.handler, 'bureau.diagnostics.get', {}, 'operator-key');

    expect(answered.error).toBeUndefined();
  });

  it('refuses callers without the scope, and every other scope does not stand in for it', async () => {
    const opened = await open();
    for (const key of [
      'alice-key',
      'tasks-reader-key',
      'audit-reader-key',
      'settings-writer-key',
      'agents-reader-key',
    ]) {
      const answered = await rpc(opened.handler, 'bureau.diagnostics.get', {}, key);
      expect({ key, error: answered.error?.data }).toMatchObject({
        key,
        error: { httpStatus: 403 },
      });
      expect(answered.result).toBeUndefined();
    }
  });

  it('refuses a request with no credential', async () => {
    const opened = await open();

    const response = await opened.handler(
      new Request('http://localhost/jsonrpc', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'bureau.diagnostics.get',
          params: {},
        }),
      }),
    );

    expect(response.status).toBe(401);
  });

  it('refuses a parameter it does not declare', async () => {
    const opened = await open();

    const answered = await rpc(
      opened.handler,
      'bureau.diagnostics.get',
      { principal: 'someone-else' },
      'diagnostics-reader-key',
    );

    expect(answered.error).toBeDefined();
    expect(answered.result).toBeUndefined();
  });

  it('carries counts, statuses, and timestamps and names no run, review, or agent', async () => {
    const charges: number[] = [];
    const opened = await open({
      agents: {
        parked: createAgent({
          generate: chargesOnce,
          toolbox: approvalToolbox(charges),
          stopWhen: stopWhen.some(stopWhen.pendingApproval(), stopWhen.noToolCalls()),
        }),
      },
    });
    const run = await opened.bureau.tasks.start('parked', 'charge the card');
    await waitUntil(() => opened.bureau.reviews.list().length === 1);
    const [review] = opened.bureau.reviews.list();

    const answered = await rpc(
      opened.handler,
      'bureau.diagnostics.get',
      {},
      'diagnostics-reader-key',
    );

    expect(answered.result).toMatchObject({ pendingReviewCount: 1 });
    const wire = JSON.stringify(answered.result);
    for (const forbidden of [run.id, review!.id, 'parked', 'charge', 'charge-card']) {
      expect(wire).not.toContain(forbidden);
    }
  });
});
