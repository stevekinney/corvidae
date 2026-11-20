import { expect, it } from 'bun:test';
import manifest from '../package.json';
import { inProcessCatalogTransport, inProcessSubscriptionTransport } from './client/index.ts';
import { anonymousPrincipal, createOperationRegistry } from './index.ts';
import { describeTransportConformance } from './testing.ts';

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

it('keeps Zod as the only production dependency', () => {
  expect(Object.keys(manifest.dependencies)).toEqual(['zod']);
});
