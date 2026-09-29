import { describe, expect, test } from 'bun:test';

import { baselineOptions, evidence, recalledContents } from './baselines.test-support';
import { createFlatHybridBaseline } from './flat-hybrid';

describe('createFlatHybridBaseline', () => {
  test("shares one namespace per tenant's agent, so a co-user's memory reaches the owner", async () => {
    const adapter = createFlatHybridBaseline(baselineOptions());
    await adapter.observe(
      evidence('teammate', 'Phone number: 206-555-0199.', { principal: 'co-user' }),
    );
    await adapter.observe(
      evidence('tenant-b', 'Phone number: 509-555-0100.', { principal: 'other-tenant' }),
    );
    const recall = await adapter.recall({ query: 'phone number', limit: 3 });
    expect(recall.plan).toEqual({
      strategy: 'hybrid-vector-bm25',
      scope: 'tenant-a/support-agent',
      query: 'phone number',
      limit: 3,
    });
    expect(recall.items).toEqual([
      {
        content: 'Phone number: 206-555-0199.',
        observedAt: '2026-01-01T00:00:00.000Z',
        source: 'conversation',
      },
    ]);
    await adapter.close();
  });

  test('keeps each source in a tag, and reports a duplicate write it merged', async () => {
    const adapter = createFlatHybridBaseline(baselineOptions());
    expect(
      await adapter.observe(
        evidence('procedure', 'Router reset procedure: unplug it.', {
          principal: 'operator',
          source: 'operator',
          kind: 'procedure',
        }),
      ),
    ).toBe('admitted');
    expect(await adapter.observe(evidence('again', 'Router reset procedure: unplug it.'))).toBe(
      'duplicate',
    );
    const { items } = await adapter.recall({ query: 'router reset', limit: 3 });
    const [item] = items;
    expect(item!.source).toBe('conversation');
    await adapter.close();
  });

  test('reports a source it does not recognize as unknown', async () => {
    const adapter = createFlatHybridBaseline(baselineOptions());
    await adapter.observe(evidence('odd', 'Seat preference: aisle.', { source: 'rumor' as never }));
    const { items } = await adapter.recall({ query: 'seat preference', limit: 1 });
    const [item] = items;
    expect(item!.source).toBeNull();
    await adapter.close();
  });

  test('deletes by evidence, survives a restart, and rebuilds its index from storage', async () => {
    const adapter = createFlatHybridBaseline(baselineOptions());
    await adapter.observe(evidence('email', 'Billing email: dana@example.test.'));
    await adapter.observe(evidence('cadence', 'Invoice cadence: monthly.'));
    await adapter.observe(
      evidence('tenant-b', 'Billing email: c@example.test.', { principal: 'other-tenant' }),
    );
    await adapter.restart();
    expect(await recalledContents(adapter, 'billing email')).toEqual([
      'Billing email: dana@example.test.',
      'Invoice cadence: monthly.',
    ]);
    expect(await adapter.forget('email')).toEqual({ status: 'completed', receipted: false });
    expect(await adapter.forget('email')).toEqual({ status: 'not-found', receipted: false });
    await adapter.restart();
    expect(await recalledContents(adapter, 'billing email')).toEqual(['Invoice cadence: monthly.']);
    await adapter.close();
    await adapter.close();
  });
});
