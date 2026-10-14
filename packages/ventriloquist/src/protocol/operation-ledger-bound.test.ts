import { describe, expect, test } from 'bun:test';

import { connect, expectOk } from './endpoint-pair.test-support.ts';
import { encodeFrame } from './frame-codec.ts';
import { MAXIMUM_QUEUED_OPERATIONS } from './protocol-constants.ts';

/**
 * A submitted-operation failure may name an acknowledged operation only while it can still be in
 * the host FIFO: "the bounded host FIFO is 256 operations", input and resize "share one ordered
 * operation sequence and FIFO", and an acknowledgement is acceptance "into that bounded host FIFO,
 * never backend consumption". The ledger therefore holds at most the FIFO depth of acknowledged
 * operations plus the unresolved ones (also at most the FIFO depth).
 */
describe('the operation ledger stays bounded by the FIFO window', () => {
  const OPERATIONS = 5000;

  test.each([8, MAXIMUM_QUEUED_OPERATIONS])(
    'tracks at most twice the FIFO depth of %j across thousands of operations',
    (depth) => {
      const { host, client } = connect({ host: { maxQueuedOperations: depth } });
      let highest = 0;
      let last = 0;
      for (let index = 0; index < OPERATIONS; index += 1) {
        const sent = expectOk(client.input('a'));
        expectOk(host.receive(sent.frame));
        expectOk(client.receive(expectOk(host.acknowledgeOperation(sent.sequence)).frame));
        last = sent.sequence;
        highest = Math.max(highest, host.trackedOperations, client.trackedOperations);
      }
      expect(highest).toBeLessThanOrEqual(2 * depth);
      expect(host.trackedOperations).toBe(depth);
      expect(client.trackedOperations).toBe(depth);
      // An operation with a full window accepted behind it has left the FIFO and cannot fail.
      expect(host.failOperation(1, 'backend-failed', 'old').ok).toBe(false);
      expect(host.failOperation(last - depth, 'backend-failed', 'old').ok).toBe(false);
      // The oldest operation still inside the window can.
      expect(host.failOperation(last - depth + 1, 'backend-failed', 'recent').ok).toBe(true);
    },
  );

  test('refuses a failure the client received for an operation that left the window', () => {
    const { host, client } = connect({ host: { maxQueuedOperations: 4 } });
    const sequences: number[] = [];
    for (let index = 0; index < 20; index += 1) {
      const sent = expectOk(client.input('a'));
      expectOk(host.receive(sent.frame));
      expectOk(client.receive(expectOk(host.acknowledgeOperation(sent.sequence)).frame));
      sequences.push(sent.sequence);
    }
    const failure = (operationSequence: number, sequence: number) =>
      expectOk(
        encodeFrame({
          kind: 'operation-failure',
          sessionId: host.hello!.sessionId,
          attachmentGeneration: 1,
          sequence,
          operationSequence,
          code: 'backend-failed',
          message: 'm',
        }),
      );
    expect(client.receive(failure(sequences[0]!, 21)).ok).toBe(false);
  });

  test('keeps unresolved operations tracked while they wait for an acknowledgement', () => {
    const { host, client } = connect({ host: { maxQueuedOperations: 4 } });
    const sent = Array.from({ length: 4 }, () => expectOk(client.input('a')));
    for (const operation of sent) expectOk(host.receive(operation.frame));
    expect(host.trackedOperations).toBe(4);
    expect(client.trackedOperations).toBe(4);
  });
});
