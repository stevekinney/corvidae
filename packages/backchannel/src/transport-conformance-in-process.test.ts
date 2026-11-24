import { expect, it } from 'bun:test';
import { z } from 'zod';
import manifest from '../package.json';
import { inProcessCatalogTransport, inProcessSubscriptionTransport } from './client/index.ts';
import { anonymousPrincipal, createOperationRegistry } from './index.ts';
import { describeTransportConformance, makeOperation } from './testing.ts';

describeTransportConformance('In-process', ({ operations, host }) => {
  const options = {
    registry: createOperationRegistry(operations),
    host,
    principal: anonymousPrincipal(),
  };
  return {
    call: inProcessCatalogTransport(options),
    subscribe: inProcessSubscriptionTransport(options),
  };
});

it('limits production dependencies to credentials and Zod', () => {
  expect(Object.keys(manifest.dependencies).toSorted()).toEqual([
    '@lostgradient/credentials',
    'zod',
  ]);
});

it('ends an outstanding read when abort closes a feed that rejects its reader', async () => {
  const readStarted = Promise.withResolvers<void>();
  const read = Promise.withResolvers<IteratorResult<unknown>>();
  const operation = makeOperation({
    name: 'probe.abort',
    kind: 'subscription',
    inputSchema: z.object({}),
    outputSchema: z.object({}),
    eventSchema: z.unknown(),
    invoke: async () => ({
      subscriptionId: 'pending',
      envelope: {},
      iterable: {
        [Symbol.asyncIterator]: () => ({
          next() {
            readStarted.resolve();
            return read.promise;
          },
        }),
      },
      close: async () => {
        read.reject(new DOMException('Feed closed', 'AbortError'));
      },
    }),
  });
  const subscribe = inProcessSubscriptionTransport({
    registry: createOperationRegistry([operation]),
    host: {},
    principal: anonymousPrincipal(),
  });
  const controller = new AbortController();
  const events = subscribe('probe.abort', {}, { signal: controller.signal });
  const next = events[Symbol.asyncIterator]().next();
  await readStarted.promise;
  controller.abort();
  expect(await next).toMatchObject({ done: true });
});
