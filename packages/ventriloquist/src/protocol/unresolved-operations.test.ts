import { describe, expect, test } from 'bun:test';

import { connect, expectOk } from './endpoint-pair.test-support.ts';

describe('ClientEndpoint.unresolvedOperations', () => {
  test('counts operations from send until the host acknowledges or refuses them', () => {
    const { host, client } = connect({ host: { maxQueuedOperations: 3 } });
    expect(client.unresolvedOperations).toBe(0);
    const first = expectOk(client.input('a'));
    const second = expectOk(client.input('b'));
    expect(client.unresolvedOperations).toBe(2);
    expectOk(host.receive(first.frame));
    expectOk(host.receive(second.frame));
    expectOk(client.receive(expectOk(host.acknowledgeOperation(first.sequence)).frame));
    expect(client.unresolvedOperations).toBe(1);
    expectOk(client.receive(expectOk(host.acknowledgeOperation(second.sequence)).frame));
    expect(client.unresolvedOperations).toBe(0);
  });

  test('is the window the endpoint enforces: a full window refuses the next input', () => {
    const { client } = connect({ host: { maxQueuedOperations: 2 } });
    expectOk(client.input('a'));
    expectOk(client.input('b'));
    expect(client.unresolvedOperations).toBe(2);
    const refused = client.input('c');
    expect(refused.ok).toBe(false);
    expect(client.unresolvedOperations).toBe(2);
  });
});
