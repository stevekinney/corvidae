import { describe, expect, test } from 'bun:test';
import { writeSync } from 'node:fs';

import { loadPtyDevice } from './pty-device.ts';
import {
  MASTER_FLAGS,
  MASTER_FLAG_COUNT,
  MASTER_WINDOW_BYTES,
  type MasterMessage,
} from './pty-master-loop.ts';
import { serveMaster, type MasterScope } from './pty-master-thread.ts';

describe('the master thread', () => {
  test('waits while the window of unread bytes is full, and ends when it is stopped', async () => {
    const device = loadPtyDevice();
    const pair = device.open();
    const shared = new SharedArrayBuffer(MASTER_FLAG_COUNT * Int32Array.BYTES_PER_ELEMENT);
    const flags = new Int32Array(shared);
    Atomics.store(flags, MASTER_FLAGS.inflight, MASTER_WINDOW_BYTES);
    const posts: MasterMessage[] = [];
    let serve:
      ((event: MessageEvent<{ fd: number; shared: SharedArrayBuffer }>) => void) | undefined;
    const scope: MasterScope = {
      addEventListener: (_type, listener) => {
        serve = listener;
      },
      postMessage: (message) => {
        posts.push(message);
      },
    };
    // This thread blocks in the loop, so another one ends it a moment later.
    const stopper = new Worker(
      URL.createObjectURL(
        new Blob(
          [
            `self.addEventListener('message', (event) => {
              const flags = new Int32Array(event.data);
              setTimeout(() => { Atomics.store(flags, ${MASTER_FLAGS.stop}, 1); }, 120);
            });`,
          ],
          { type: 'text/javascript' },
        ),
      ),
    );
    try {
      serveMaster(scope);
      stopper.postMessage(shared, []);
      const started = performance.now();
      serve?.({ data: { fd: pair.masterFd, shared } } as MessageEvent<{
        fd: number;
        shared: SharedArrayBuffer;
      }>);
      expect(performance.now() - started).toBeGreaterThanOrEqual(100);
      expect(posts).toEqual([{ type: 'end', how: 'stopped' }]);
    } finally {
      stopper.terminate();
      device.close(pair.masterFd);
    }
  });

  test('the worker module serves from the global scope it is loaded into', async () => {
    const before = typeof (globalThis as { addEventListener?: unknown }).addEventListener;
    await import('./pty-master-worker.ts');
    expect(before).toBe('function');
  });

  test('reads a real terminal with poll(2) and read(2) and posts what the other end wrote', () => {
    const device = loadPtyDevice();
    const pair = device.open();
    const slave = device.openSlave(pair.slavePath);
    const shared = new SharedArrayBuffer(MASTER_FLAG_COUNT * Int32Array.BYTES_PER_ELEMENT);
    const flags = new Int32Array(shared);
    const posts: MasterMessage[] = [];
    let serve:
      ((event: MessageEvent<{ fd: number; shared: SharedArrayBuffer }>) => void) | undefined;
    const scope: MasterScope = {
      addEventListener: (_type, listener) => {
        serve = listener;
      },
      // The loop runs on this thread, so the test stops it from the first thing it posts.
      postMessage: (message) => {
        posts.push(message);
        Atomics.store(flags, MASTER_FLAGS.stop, 1);
      },
    };
    try {
      serveMaster(scope);
      writeSync(slave, 'thread says hi');
      serve?.({ data: { fd: pair.masterFd, shared } } as MessageEvent<{
        fd: number;
        shared: SharedArrayBuffer;
      }>);
      const first = posts[0];
      expect(first?.type).toBe('data');
      expect(
        new TextDecoder().decode(first?.type === 'data' ? first.chunk : new ArrayBuffer(0)),
      ).toBe('thread says hi');
      expect(posts.at(-1)).toEqual({ type: 'end', how: 'stopped' });
    } finally {
      device.close(slave);
      device.close(pair.masterFd);
    }
  });

  test('a worker started on its module serves the same request', async () => {
    const device = loadPtyDevice();
    const pair = device.open();
    const slave = device.openSlave(pair.slavePath);
    const shared = new SharedArrayBuffer(MASTER_FLAG_COUNT * Int32Array.BYTES_PER_ELEMENT);
    const flags = new Int32Array(shared);
    const worker = new Worker(new URL('./pty-master-worker.ts', import.meta.url).href);
    try {
      const messages: MasterMessage[] = [];
      const ended = new Promise<void>((resolve) => {
        worker.addEventListener('message', (event: MessageEvent<MasterMessage>) => {
          messages.push(event.data);
          if (event.data.type === 'data') Atomics.store(flags, MASTER_FLAGS.stop, 1);
          if (event.data.type === 'end') resolve();
        });
      });
      worker.postMessage({ fd: pair.masterFd, shared }, []);
      writeSync(slave, 'worker says hi');
      await ended;
      expect(messages[0]?.type).toBe('data');
      expect(messages.at(-1)).toEqual({ type: 'end', how: 'stopped' });
    } finally {
      worker.terminate();
      device.close(slave);
      device.close(pair.masterFd);
    }
  });
});
