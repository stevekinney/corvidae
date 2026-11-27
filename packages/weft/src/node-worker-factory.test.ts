import { expect, test } from 'bun:test';

import { nodeWorkerFactory } from './node-worker-factory.ts';

test('queues messages sent before a Node worker entry registers its handler', async () => {
  const worker = nodeWorkerFactory(
    new URL('./__fixtures__/node-worker-factory-gated.fixture.ts', import.meta.url),
  );
  try {
    const received = new Promise<unknown>((resolve) => {
      worker.addEventListener('message', (event) => {
        if (event instanceof MessageEvent) {
          resolve(event.data);
        }
      });
    });
    worker.postMessage('queued');
    expect(await received).toBe('queued');
  } finally {
    await worker.terminate();
  }
});
