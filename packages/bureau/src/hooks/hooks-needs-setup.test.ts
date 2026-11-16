/**
 * COR-2176 — while a plugin needs setup (a secret it declared is missing), a delivery of its
 * reaction makes no attempt, stays `pending` and releases its lease, and it is driven again,
 * without a restart, when the plugin's gate reports the secret saved. `hooks-reactions-matrix.test.ts`
 * holds the interleavings; these are the acceptance criteria as a person would read them.
 */
import { waitUntil } from '@lostgradient/testing/wait-until';
import { describe, expect, it } from 'bun:test';

import { availabilityGate, harness, outcomes } from './hooks-reactions.test-support.ts';

describe('a delivery of a plugin that needs setup', () => {
  it('makes no attempt, stays pending and releases its lease', async () => {
    const h = harness({ gate: availabilityGate(false) });
    const hook = await h.hook();
    await h.open();

    h.dispatch();
    await h.drain();

    const record = await h.record(hook.id);
    expect(record.status).toBe('pending');
    expect(record.attempts).toEqual([]);
    expect(record.leaseUntil).toBe(0);
    expect(h.calls).toHaveLength(0);
  });

  it('is driven when the secret is saved, with no restart, and is delivered after one attempt', async () => {
    const gate = availabilityGate(false);
    const h = harness({ gate });
    const hook = await h.hook();
    await h.open();
    h.dispatch();
    await h.drain();
    expect(await h.status(hook.id)).toBe('pending');

    gate.set(true);
    await waitUntil(async () => (await h.status(hook.id)) === 'delivered', {
      message: 'the waiting delivery to be made',
    });
    await h.drain();

    const delivery = await h.only(hook.id);
    expect(outcomes(delivery)).toEqual(['completed']);
    expect(h.calls).toHaveLength(1);
  });

  it('waits, and does not fail, when the secret is removed again', async () => {
    const gate = availabilityGate(true);
    const h = harness({ gate });
    const hook = await h.hook();
    await h.open();
    h.dispatch();
    await h.drain();

    gate.set(false);
    h.dispatch();
    await h.drain();

    const deliveries = await h.deliveries(hook.id);
    expect(deliveries.map((delivery) => delivery.status)).toEqual(['delivered', 'pending']);
    expect(deliveries[1]?.attempts).toEqual([]);
    expect(h.audits).not.toContain('hook.delivery.exhausted');
  });
});
