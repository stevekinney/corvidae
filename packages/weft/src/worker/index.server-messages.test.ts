/**
 * `RemoteWorker` against a scripted WebSocket server that sends what a healthy Weft server never
 * does: frames that are not JSON or are malformed, a protocol error that names no buffered result,
 * and (in the last test) a registration that finds its buffered results cannot all be flushed.
 */

import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import {
  createDeferred,
  restoreRealTimers,
  waitForCondition,
} from '../testing/fake-timers.test-support.ts';
import { RemoteWorker } from './index.ts';

type ScriptedServer = {
  readonly server: ReturnType<typeof Bun.serve>;
  readonly received: Array<Record<string, unknown>>;
  readonly upgradeHeaders: Headers[];
};

/** Accepts every registration, then runs `afterRegister` so a test can script what follows. */
function scriptedServer(
  afterRegister: (ws: Bun.ServerWebSocket<unknown>) => void = () => {},
): ScriptedServer {
  const received: Array<Record<string, unknown>> = [];
  const upgradeHeaders: Headers[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(request, bunServer) {
      upgradeHeaders.push(request.headers);
      return bunServer.upgrade(request, { data: undefined }) ? undefined : new Response('ok');
    },
    websocket: {
      message(ws, message) {
        const parsed = JSON.parse(String(message)) as Record<string, unknown>;
        received.push(parsed);
        if (parsed['type'] !== 'register') return;
        ws.send(
          JSON.stringify({
            type: 'registerAck',
            protocolVersion: 8,
            workerId: parsed['workerId'],
            queue: 'default',
            concurrency: 10,
            acceptedManifestDigest: 'sha256:test-accepted-digest',
            serverCapabilities: [],
            sessionGeneration: 1,
          }),
        );
        afterRegister(ws);
      },
    },
  });
  return { server, received, upgradeHeaders };
}

function createWorker(
  scripted: ScriptedServer,
  extra: Partial<ConstructorParameters<typeof RemoteWorker>[0]> = {},
  activities: Record<string, (input: unknown) => Promise<unknown>> = {
    echo: async (input) => input,
  },
): RemoteWorker {
  return new RemoteWorker({
    serverUrl: `ws://localhost:${scripted.server.port}`,
    deploymentName: 'test-deployment',
    buildId: 'test-build',
    workflows: { orders: { name: 'orders', activities } },
    ...extra,
  });
}

describe('RemoteWorker server frames', () => {
  let scripted: ScriptedServer | undefined;
  let worker: RemoteWorker | undefined;

  afterEach(() => {
    restoreRealTimers();
    worker?.[Symbol.dispose]();
    worker = undefined;
    void scripted?.server.stop(true);
    scripted = undefined;
  });

  it('sends the configured headers with the WebSocket upgrade', async () => {
    scripted = scriptedServer();
    worker = createWorker(scripted, { headers: { authorization: 'Bearer worker-token' } });

    await worker.connect();

    expect(scripted.upgradeHeaders[0]?.get('authorization')).toBe('Bearer worker-token');
  });

  it('ignores a frame that is not JSON and warns about it', async () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      scripted = scriptedServer((ws) => ws.send('this is not json'));
      worker = createWorker(scripted);

      await worker.connect();
      await waitForCondition(() => warnSpy.mock.calls.length > 0, { label: 'warning logged' });

      expect(String(warnSpy.mock.calls[0]?.[0])).toContain('Received non-JSON server message');
      expect(worker.connected).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('ignores a malformed frame of a known type and warns about it', async () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      scripted = scriptedServer((ws) => ws.send(JSON.stringify({ type: 'task' })));
      worker = createWorker(scripted);

      await worker.connect();
      await waitForCondition(() => warnSpy.mock.calls.length > 0, { label: 'warning logged' });

      expect(String(warnSpy.mock.calls[0]?.[0])).toContain('Received malformed server message');
      expect(worker.connected).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('skips a frame of an unknown type silently and carries on with the next frame', async () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      scripted = scriptedServer((ws) => {
        ws.send(JSON.stringify({ type: 'from-the-future' }));
        ws.send(JSON.stringify({ type: 'task' }));
      });
      worker = createWorker(scripted);

      await worker.connect();
      await waitForCondition(() => warnSpy.mock.calls.length > 0, { label: 'warning logged' });

      // Frames are handled in order, so the only warning is the malformed frame after the unknown one.
      expect(warnSpy.mock.calls).toHaveLength(1);
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain('Received malformed server message');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('reports a protocol error that names no result as a plain warning', async () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      scripted = scriptedServer((ws) =>
        ws.send(
          JSON.stringify({ type: 'protocolError', code: 'invalid_message', message: 'bad frame' }),
        ),
      );
      worker = createWorker(scripted);

      await worker.connect();
      await waitForCondition(() => warnSpy.mock.calls.length > 0, { label: 'warning logged' });

      expect(String(warnSpy.mock.calls[0]?.[0])).toBe(
        '[weft] RemoteWorker protocol error from server: bad frame',
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('says so when a rejected result is not in the outbox', async () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      scripted = scriptedServer((ws) =>
        ws.send(
          JSON.stringify({
            type: 'protocolError',
            code: 'invalid_message',
            message: 'unknown operation',
            operationId: 'op-never-buffered',
            attemptToken: 'attempt-1',
          }),
        ),
      );
      worker = createWorker(scripted);

      await worker.connect();
      await waitForCondition(() => warnSpy.mock.calls.length > 0, { label: 'warning logged' });

      expect(String(warnSpy.mock.calls[0]?.[0])).toContain(
        '; no matching buffered result was found',
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('rejects connect() when the socket cannot take every buffered result on registration', async () => {
    const gate = createDeferred();
    const taskFrame = (operationId: string) =>
      JSON.stringify({
        type: 'task',
        operationId,
        attemptToken: `attempt-${operationId}`,
        activityName: 'orders.wait',
        input: {},
      });
    scripted = scriptedServer((ws) => {
      if (
        scripted === undefined ||
        scripted.received.filter((m) => m['type'] === 'register').length > 1
      ) {
        return;
      }
      ws.send(taskFrame('op-1'));
      ws.send(taskFrame('op-2'));
      // Drop the connection once both tasks are in flight, so the results have nowhere to go.
      setTimeout(() => ws.close(), 20);
    });
    worker = createWorker(scripted, {}, { wait: async () => gate.promise });

    await worker.connect();
    await waitForCondition(() => !worker!.connected, { label: 'connection dropped' });
    gate.resolve();
    await waitForCondition(() => worker!.inFlight === 0, { label: 'both results buffered' });

    // The first buffered result closes the socket as it goes out, so the second finds it unusable.
    const realSend = WebSocket.prototype.send;
    const sendSpy = spyOn(WebSocket.prototype, 'send').mockImplementation(function (
      this: WebSocket,
      data: Parameters<WebSocket['send']>[0],
    ) {
      realSend.call(this, data);
      if (typeof data === 'string' && data.includes('"taskResult"')) this.close();
    });
    try {
      const failure = await rejectionOf(worker.connect());

      expect((failure as Error).message).toBe(
        'reconnect required: result flush failed during registration',
      );
    } finally {
      sendSpy.mockRestore();
    }
  });
});
