import { expect } from 'bun:test';
import { TEST_SCOPE_VOCABULARY } from './scope-vocabulary.test-support.ts';

import { createOperationRegistry } from './index.ts';
import { runStdioSession } from './stdio-session.ts';
import { describeTransportConformance } from './testing.ts';
import { connectFramedTransport } from './transport-conformance-framed.test-support.ts';

describeTransportConformance('stdio', ({ operations, host }) =>
  connectFramedTransport((receive) => {
    let stdin!: ReadableStreamDefaultController<Uint8Array>;
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        stdin = controller;
      },
    });
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    const session = runStdioSession({
      scopeVocabulary: TEST_SCOPE_VOCABULARY,
      input,
      output: new WritableStream({ write: (chunk) => receive(decoder.decode(chunk)) }),
      admission: { kind: 'allow-unauthenticated-local-admin' },
      registry: createOperationRegistry(operations),
      engine: host,
      feed: undefined,
      discoverDocument: () => ({}),
    });
    return {
      send: (frame) => stdin.enqueue(encoder.encode(frame + '\n')),
      close: async () => {
        stdin.close();
        expect(await session).toEqual({ exitCode: 0 });
      },
    };
  }),
);
