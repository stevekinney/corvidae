import { expect, spyOn, test } from 'bun:test';
import { Miniflare } from 'miniflare';

import { withWorker } from './workerd.ts';

const entry = new URL('./fixture-worker.ts', import.meta.url).pathname;
const assets = new URL('./fixtures', import.meta.url).pathname;

async function responseText(response: Promise<{ text(): Promise<string> }>): Promise<string> {
  const resolved = await response;
  return resolved.text();
}

test('runs a bundled Worker with platform bindings', async () => {
  const outboundService = (request: Request) =>
    new Response(`stubbed ${new URL(request.url).pathname}`);
  await withWorker(
    { entry, assets, durableObjects: { COUNTER: 'Counter' }, d1Databases: ['DB'], outboundService },
    async ({
      dispatchFetch,
      getD1Database,
      getDurableObjectNamespace,
      outboundService: boundService,
    }) => {
      expect(await responseText(dispatchFetch('https://fixture.test/'))).toBe('round trip');
      expect(await responseText(dispatchFetch('https://fixture.test/durable'))).toBe('1');
      expect(await responseText(dispatchFetch('https://fixture.test/durable'))).toBe('2');
      expect(await responseText(dispatchFetch('https://fixture.test/d1'))).toBe('stored');
      expect(await responseText(dispatchFetch('https://fixture.test/async-local-storage'))).toBe(
        'carried',
      );
      expect(await responseText(dispatchFetch('https://fixture.test/outbound'))).toBe(
        'stubbed /fixture',
      );
      expect(await responseText(dispatchFetch('https://fixture.test/asset'))).toBe(
        'asset response\n',
      );
      expect(await getD1Database('DB')).toBeDefined();
      expect(await getDurableObjectNamespace('COUNTER')).toBeDefined();
      expect(boundService).toBe(outboundService);
    },
  );
});

test('disposes Miniflare when the callback throws', async () => {
  const failure = new Error('callback failure');
  const dispose = spyOn(Miniflare.prototype, 'dispose');
  const outcome = await withWorker({ entry }, async () => {
    throw failure;
  }).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(outcome).toBe(failure);
  expect(dispose).toHaveBeenCalledTimes(1);
  dispose.mockRestore();
});
