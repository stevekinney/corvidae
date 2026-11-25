import { QueryClient } from '@tanstack/svelte-query';
import { expect, it } from 'bun:test';
import { createCatalogHost, createSubscription } from './index.ts';

it('resumes from the last cursor, drops duplicates and releases its stream', async () => {
  const cursors: (string | undefined)[] = [];
  const inputs: unknown[] = [];
  let aborted = false;
  const host = createCatalogHost({
    scope: 'a',
    cache: new QueryClient(),
    transport: async () => null,
    subscription: async function* (_name, input, options) {
      inputs.push(input);
      cursors.push(options?.lastEventId);
      options?.signal?.addEventListener('abort', () => {
        aborted = true;
      });
      yield { type: 'event', id: '1', data: 'one' };
      yield { type: 'event', id: '2', data: 'two' };
    },
  });
  const events: unknown[] = [];
  const input = { topic: 'original' };
  const subscription = createSubscription(host, 'events', input, (event) => events.push(event));
  input.topic = 'changed';
  await subscription.connect();
  await subscription.connect();
  expect(cursors).toEqual([undefined, '2']);
  expect(inputs).toEqual([{ topic: 'original' }, { topic: 'original' }]);
  expect(events).toEqual(['one', 'two']);
  subscription.dispose();
  expect(aborted).toBe(true);
});

it('reports an unsupported subscription transport', () => {
  const host = createCatalogHost({
    scope: 'a',
    cache: new QueryClient(),
    transport: async () => null,
  });
  expect(() => createSubscription(host, 'events', {}, () => {})).toThrow('unsupported');
});
