import { describe, expect, test } from 'bun:test';

import { createBureauCatalogSnapshot } from './bureau-catalog-snapshot.ts';
import { BUREAU_HANDLER_OPERATIONS } from './create-bureau-handler.ts';

describe('createBureauCatalogSnapshot', () => {
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
