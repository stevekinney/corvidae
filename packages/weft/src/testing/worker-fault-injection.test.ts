import { afterEach, describe, expect, it } from 'bun:test';

import type { ServerToWorkerMessage } from '../worker/protocol.ts';
import {
  connectFaultInjectingWorker,
  type FaultInjectingWorker,
} from './worker-fault-injection.test-support.ts';

type ServerSocket = { send(data: string): void };

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  // Close the worker before stopping the server, the order every other suite
  // using this harness tears down in.
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const SHUTDOWN = { type: 'shutdown' } as const;

function protocolError(message: string): ServerToWorkerMessage {
  return { type: 'protocolError', code: 'unknown_message_type', message };
}

/**
 * Serve one WebSocket endpoint and connect a fault-injecting worker to it. The
 * server sends nothing until the test says so: a frame sent from `open` can
 * arrive in the same TCP chunk as the handshake response, which is a different
 * (and nondeterministic) path through the harness than the one under test.
 */
async function connectToScriptedServer(): Promise<{
  worker: FaultInjectingWorker;
  serverSocket: ServerSocket;
  /** Resolves once one more frame has been parsed and buffered. */
  nextArrival: () => Promise<void>;
}> {
  let resolveSocket: (socket: ServerSocket) => void = () => undefined;
  const socketReady = new Promise<ServerSocket>((resolve) => {
    resolveSocket = resolve;
  });
  const server = Bun.serve({
    port: 0,
    fetch(request, running) {
      return running.upgrade(request)
        ? undefined
        : new Response('upgrade required', { status: 426 });
    },
    websocket: {
      open() {},
      // The worker's first frame tells us the connection is established.
      message(socket) {
        resolveSocket(socket);
      },
    },
  });
  cleanups.push(() => server.stop(true));

  const waiters: Array<() => void> = [];
  const worker = await connectFaultInjectingWorker({
    url: `ws://127.0.0.1:${String(server.port)}/`,
    workerId: 'scripted',
    onAnyInbound() {
      for (const waiter of waiters.splice(0)) waiter();
    },
  });
  cleanups.push(() => worker.hardClose());
  worker.send({ type: 'heartbeat', workerId: 'scripted' });
  return {
    worker,
    serverSocket: await socketReady,
    // `onAnyInbound` runs just before the frame is buffered; the promise
    // continuation runs after the synchronous frame handler has returned.
    nextArrival: () =>
      new Promise<void>((resolve) => {
        waiters.push(resolve);
      }),
  };
}

describe('nextServerMessage buffer scan', () => {
  // Regression test for the flaky `worker-fault-injection.test-support.ts:286`
  // coverage allowance: passing over a buffered, non-matching message is the
  // only thing that executes that closing brace, and only a timing race in
  // other suites used to reach it. This test reaches it on every run.
  it('passes over a buffered non-matching message and leaves it for a later waiter', async () => {
    const { worker, serverSocket, nextArrival } = await connectToScriptedServer();

    let arrived = nextArrival();
    serverSocket.send(JSON.stringify(SHUTDOWN));
    await arrived;

    // SHUTDOWN is buffered and does not match, so the scan passes over it,
    // finds nothing, and installs a live listener for the next frame.
    arrived = nextArrival();
    const pending = worker.nextServerMessage((message) => message.type === 'protocolError');
    serverSocket.send(JSON.stringify(protocolError('first')));
    await arrived;
    expect(await pending).toEqual(protocolError('first'));

    // The passed-over message stayed buffered...
    expect(await worker.nextServerMessage((message) => message.type === 'shutdown')).toEqual(
      SHUTDOWN,
    );

    // ...and the matched one was removed, so a second waiter sees the next frame.
    arrived = nextArrival();
    serverSocket.send(JSON.stringify(protocolError('second')));
    await arrived;
    expect(await worker.nextServerMessage((message) => message.type === 'protocolError')).toEqual(
      protocolError('second'),
    );
  });

  it('skips a non-matching buffered message ahead of a buffered match', async () => {
    const { worker, serverSocket, nextArrival } = await connectToScriptedServer();

    for (const frame of [SHUTDOWN, protocolError('behind')]) {
      const arrived = nextArrival();
      serverSocket.send(JSON.stringify(frame));
      await arrived;
    }
    // Buffer is [shutdown, protocolError]: the scan passes over the first
    // entry and splices out the second.
    const match = await worker.nextServerMessage((message) => message.type === 'protocolError');
    expect(match).toEqual(protocolError('behind'));
    expect(await worker.nextServerMessage((message) => message.type === 'shutdown')).toEqual(
      SHUTDOWN,
    );
  });
});
