import { expect, it } from 'bun:test';
import { z } from 'zod';
import { anonymousPrincipal, createOperationRegistry } from './index.ts';
import { makeOperation } from './json-rpc-operation.test-support.ts';
import { createJsonRpcWebSocketSession } from './json-rpc-websocket.ts';
import { describeTransportConformance } from './testing.ts';
import { connectFramedTransport } from './transport-conformance-framed.test-support.ts';

describeTransportConformance('WebSocket', ({ operations, host }) =>
  connectFramedTransport((receive) => {
    const session = createJsonRpcWebSocketSession({
      registry: createOperationRegistry(operations),
      engine: host,
      principal: anonymousPrincipal(),
      emitter: { send: receive },
    });
    return { send: session.handleMessage, close: session.close };
  }),
);

it.each([
  [
    'weft.workflows.subscribe',
    'weft.workflows.events',
    { workflowId: 'workflow', selector: 'events' },
  ],
  ['weft.events.subscribe', 'weft.events.subscribe', {}],
] as const)('aborts startup for %s when the socket closes', async (method, name, params) => {
  const entered = Promise.withResolvers<AbortSignal | undefined>();
  const resume = Promise.withResolvers<void>();
  const frames: string[] = [];
  const operation = makeOperation({
    name,
    kind: 'subscription',
    inputSchema: z.object({ workflowId: z.string().optional(), selector: z.string().optional() }),
    outputSchema: z.never(),
    eventSchema: z.never(),
    invoke: async () => {
      throw new Error('the interceptor ends the subscription');
    },
  });
  const session = createJsonRpcWebSocketSession({
    registry: createOperationRegistry([operation], {
      interceptors: [
        async ({ signal }) => {
          entered.resolve(signal);
          await resume.promise;
          return { ok: false, fault: { code: 'EngineFailure', message: 'closed', data: {} } };
        },
      ],
    }),
    engine: {},
    feed: {
      replay: async function* () {},
      subscribe: async function* () {},
      dispose() {},
    },
    principal: anonymousPrincipal(),
    emitter: { send: (frame) => frames.push(frame) },
  });

  const pending = session.handleMessage(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }));
  try {
    const signal = await Promise.race([
      entered.promise,
      pending.then(() => {
        throw new Error('the session returned before reaching the subscription interceptor');
      }),
    ]);
    expect(signal?.aborted).toBe(false);
    await session.close();
    expect(signal?.aborted).toBe(true);
  } finally {
    resume.resolve();
    await session.close();
    await pending;
  }
  expect(frames).toEqual([]);
});
