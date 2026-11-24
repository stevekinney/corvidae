import type { CatalogSnapshot } from '../src/index.ts';
import { createOperationClientSources } from './generate-operation-client.ts';
import { fixtureOptions, fixtureSnapshot } from './operation-client-test-support.ts';

/** A portable catalog with a paged read, a one-time command and a cursor stream. */
export function svelteFixtureSnapshot(): CatalogSnapshot {
  const snapshot = fixtureSnapshot();
  return {
    ...snapshot,
    operations: snapshot.operations.map((operation) => {
      if (operation.name === 'probe.jobs.list')
        return {
          ...operation,
          inputSchema: {
            type: 'object',
            properties: { cursor: { type: 'string' }, filter: { type: 'string' } },
            additionalProperties: false,
          },
          outputSchema: {
            type: 'object',
            properties: {
              jobs: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: { id: { type: 'string' }, tenant: { type: 'string' } },
                  required: ['id', 'tenant'],
                  additionalProperties: false,
                },
              },
              next: { anyOf: [{ type: 'string' }, { type: 'null' }] },
              total: { type: 'number' },
            },
            required: ['jobs', 'next', 'total'],
            additionalProperties: false,
          },
          behavior: {
            kind: 'read',
            key: ['filter'],
            pagination: {
              items: 'jobs',
              cursorInput: 'cursor',
              nextCursor: 'next',
              total: 'total',
              cursorFilters: ['filter'],
              itemKey: ['tenant', 'id'],
            },
          },
        };
      if (operation.name === 'probe.jobs.cancel')
        return {
          ...operation,
          outputSchema: {
            type: 'object',
            properties: { secret: { type: 'string' } },
            required: ['secret'],
            additionalProperties: false,
          },
          behavior: {
            kind: 'command',
            invalidates: ['probe.jobs.list'],
            responseDisposition: 'one-time',
          },
        };
      if (operation.name === 'probe.jobs.watch')
        return { ...operation, behavior: { kind: 'read', cursor: 'cursor' } };
      return operation;
    }),
  };
}

/** The complete checked-in generated fixture. */
export function svelteFixtureSources() {
  return createOperationClientSources(
    svelteFixtureSnapshot(),
    fixtureOptions({
      outputDirectory: '../backchannel-svelte/tests/fixture/generated',
      portableEntries: true,
      svelte: true,
      subscriptions: 'generic',
      subscriptionRoutes: { include: (operation) => operation.name === 'probe.jobs.watch' },
    }),
  );
}
