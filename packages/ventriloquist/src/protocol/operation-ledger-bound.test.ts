import { describe, expect, test } from 'bun:test';

import { connect, expectOk } from './endpoint-pair.test-support.ts';
import { encodeFrame } from './frame-codec.ts';
import { MAXIMUM_QUEUED_OPERATIONS } from './protocol-constants.ts';

/**
 * A submitted-operation failure may name an acknowledged operation only while it can still be in
 * the host FIFO or be the one the host is processing: "the bounded host FIFO is 256 operations",
 * input and resize "share one ordered operation sequence and FIFO", an acknowledgement is acceptance
 * "into that bounded host FIFO, never backend consumption", and "a submitted operation can still
 * fail later" (`backend-failed`: "server, submitted operation"). The operation being processed has
 * left the FIFO but is still submitted, so the ledger holds at most the FIFO depth plus that active
 * operation of acknowledged operations, plus the unresolved ones (at most the FIFO depth).
 */
describe('the operation ledger stays bounded by the FIFO window plus the active operation', () => {
  const OPERATIONS = 5000;

  test.each([1, 8, MAXIMUM_QUEUED_OPERATIONS])(
    'tracks at most twice the FIFO depth of %j plus the active operation across thousands of operations',
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
      expect(highest).toBeLessThanOrEqual(2 * depth + 1);
      expect(host.trackedOperations).toBe(depth + 1);
      expect(client.trackedOperations).toBe(depth + 1);
      // An operation with the FIFO depth plus one accepted behind it has finished and cannot fail.
      expect(host.failOperation(1, 'backend-failed', 'old').ok).toBe(false);
      expect(host.failOperation(last - depth - 1, 'backend-failed', 'old').ok).toBe(false);
      // The oldest operation still inside the window, the active one, can.
      expect(host.failOperation(last - depth, 'backend-failed', 'active').ok).toBe(true);
    },
  );

  test('keeps the active operation failable after the next one is acknowledged at depth 1', () => {
    const { host, client } = connect({ host: { maxQueuedOperations: 1 } });
    const active = expectOk(client.input('a'));
    expectOk(host.receive(active.frame));
    expectOk(client.receive(expectOk(host.acknowledgeOperation(active.sequence)).frame));
    // The host now processes `active`, which leaves the FIFO and makes room for the next operation.
    const next = expectOk(client.input('b'));
    expectOk(host.receive(next.frame));
    expectOk(client.receive(expectOk(host.acknowledgeOperation(next.sequence)).frame));
    const failure = expectOk(host.failOperation(active.sequence, 'backend-failed', 'active'));
    const received = expectOk(client.receive(failure.frame));
    expect(received.kind).toBe('operation-failure');
  });

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
