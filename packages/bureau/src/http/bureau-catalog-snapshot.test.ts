import { describe, expect, test } from 'bun:test';

import { createBureauCatalogSnapshot } from './bureau-catalog-snapshot.ts';
import { BUREAU_HANDLER_OPERATIONS } from './create-bureau-handler.ts';

describe('createBureauCatalogSnapshot', () => {
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
