import { describe, expect, test } from 'bun:test';
import { defineOperation } from '@lostgradient/backchannel';
import { z } from 'zod';

import { createBureauCatalogSnapshot } from './bureau-catalog-snapshot.ts';
import { BUREAU_HANDLER_OPERATIONS } from './create-bureau-handler.ts';

describe('createBureauCatalogSnapshot', () => {
  test('adds explicit effect schemas to composed Reviews without changing the portable catalog', () => {
    const inventory = z.strictObject({ kind: z.literal('inventory'), itemId: z.string() });
    const composed = createBureauCatalogSnapshot([], [inventory]);
    const detail = composed.operations.find((operation) => operation.name === 'bureau.reviews.get');
    expect(JSON.stringify(detail?.outputSchema)).toContain('inventory');
    expect(JSON.stringify(createBureauCatalogSnapshot())).not.toContain('inventory');
    expect(() => createBureauCatalogSnapshot([], [inventory, inventory])).toThrow();
  });
  test('includes explicitly contributed operations and rejects collisions', () => {
    const operation = defineOperation({
      name: 'fixture.inventory.get',
      summary: 'Read inventory',
      mcpExposable: true,
      behavior: { kind: 'read' },
      destructive: false,
      inputSchema: z.strictObject({ itemId: z.string() }),
      outputSchema: z.strictObject({ itemId: z.string() }),
      access: { kind: 'authenticated' },
      transports: { http: false, jsonRpcHttp: true, jsonRpcWebSocket: false, jsonRpcStdio: false },
      unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
      invoke: async ({ input }) => input,
    });
    const snapshot = createBureauCatalogSnapshot([operation]);
    expect(snapshot.operations.find((entry) => entry.name === operation.name)).toMatchObject({
      name: 'fixture.inventory.get',
      access: { kind: 'authenticated' },
      inputSchema: { properties: { itemId: { type: 'string' } }, required: ['itemId'] },
    });
    expect(() => createBureauCatalogSnapshot([operation, operation])).toThrow();
  });
  test('publishes the review observation and pagination contract', () => {
    const snapshot = JSON.parse(JSON.stringify(createBureauCatalogSnapshot()));
    const operations = new Map(
      snapshot.operations.map((operation: { name: string }) => [operation.name, operation]),
    );
    expect(operations.get('bureau.reviews.list')).toMatchObject({
      behavior: {
        kind: 'read',
        pagination: {
          items: 'reviews',
          cursorInput: 'pageToken',
          nextCursor: 'nextPageToken',
          total: 'total',
          cursorFilters: ['status', 'resolvedAfter'],
          itemKey: ['source', 'id'],
        },
      },
    });
    expect(operations.get('bureau.reviews.get')).toMatchObject({
      behavior: { kind: 'read', key: ['id'] },
    });
    expect(operations.get('bureau.reviews.resolve')).toMatchObject({
      behavior: {
        kind: 'command',
        observedInput: {
          read: 'bureau.reviews.get',
          when: { kind: 'tool-approval', status: 'pending' },
          key: 'id',
          revision: 'round',
        },
        invalidates: ['bureau.reviews.list', 'bureau.reviews.get'],
        conflictReasons: [
          'REVIEW_ROUND_CHANGED',
          'REVIEW_ALREADY_RESOLVED',
          'APPROVAL_OUTCOME_NOT_WRITTEN',
        ],
      },
    });
  });
  test('names every operation the handler serves, sorted by name', () => {
    const names = createBureauCatalogSnapshot().operations.map((operation) => operation.name);

    expect(names).toEqual(BUREAU_HANDLER_OPERATIONS.map((operation) => operation.name).toSorted());
  });

  test('carries the schemas and the kind of an operation and of a feed', () => {
    const byName = new Map(
      createBureauCatalogSnapshot().operations.map((operation) => [operation.name, operation]),
    );

    expect(byName.get('bureau.tasks.get')).toMatchObject({
      kind: 'unary',
      transports: { jsonRpcHttp: true },
    });
    expect(byName.get('bureau.tasks.get')?.inputSchema).toMatchObject({ type: 'object' });
    expect(byName.get('bureau.tasks.events')).toMatchObject({ kind: 'subscription' });
    expect(byName.get('bureau.tasks.events')?.eventSchema).toBeDefined();
  });
});
