import { anonymousPrincipal, createOperationRegistry } from './index.ts';
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
