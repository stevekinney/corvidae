import { describe, expect, test } from 'bun:test';

import { BASELINE_REVISIONS, instantOf } from './adapter';
import { baselineOptions, evidence, recalledContents } from './baselines.test-support';
import { createNoMemoryBaseline } from './no-memory';
import { createRawLogSearchBaseline } from './raw-log-search';

describe('createNoMemoryBaseline', () => {
  test('retains nothing, deletes nothing, and recalls nothing', async () => {
    const adapter = createNoMemoryBaseline();
    expect(adapter.revision).toBe(BASELINE_REVISIONS['no-memory']);
    expect(await adapter.observe(evidence('phone', 'Phone number: 555.'))).toBe('not-retained');
    expect(await adapter.forget('phone')).toEqual({ status: 'not-retained', receipted: false });
    await adapter.restart();
    expect(await adapter.recall({ query: 'phone', limit: 3 })).toEqual({
      plan: { strategy: 'none', scope: 'none', query: 'phone', limit: 3 },
      items: [],
      withheld: 0,
    });
    await adapter.close();
  });
});

describe('createRawLogSearchBaseline', () => {
  test("searches only the owner's own entries, most relevant first and newest among equals", async () => {
    const options = baselineOptions();
    const adapter = createRawLogSearchBaseline(options);
    const at = (iso: string) => options.runtime.setTime(Date.parse(iso));
    at('2026-01-01T00:00:00.000Z');
    await adapter.observe(evidence('old', 'Shipping address: 1 Oak Street.'));
    at('2026-02-01T00:00:00.000Z');
    await adapter.observe(evidence('new', 'Shipping address: 2 Elm Street.'));
    await adapter.observe(evidence('lamp', 'Order 12 contains a lamp.'));
    await adapter.observe(
      evidence('teammate', 'Shipping address: 3 Birch Road.', { principal: 'co-user' }),
    );
    await adapter.observe(
      evidence('operator', 'Shipping address: 4 Pine Way.', {
        principal: 'operator',
        source: 'operator',
      }),
    );
    const recall = await adapter.recall({ query: 'shipping address', limit: 5 });
    expect(recall.plan).toEqual({
      strategy: 'bm25-over-raw-log',
      scope: 'tenant-a/owner-a',
      query: 'shipping address',
      limit: 5,
    });
    expect(recall.items).toEqual([
      {
        content: 'Shipping address: 2 Elm Street.',
        observedAt: '2026-02-01T00:00:00.000Z',
        source: 'conversation',
      },
      {
        content: 'Shipping address: 4 Pine Way.',
        observedAt: '2026-02-01T00:00:00.000Z',
        source: 'operator',
      },
      {
        content: 'Shipping address: 1 Oak Street.',
        observedAt: '2026-01-01T00:00:00.000Z',
        source: 'conversation',
      },
    ]);
    expect(await recalledContents(adapter, 'shipping address', 1)).toEqual([
      'Shipping address: 2 Elm Street.',
    ]);
  });

  test("deletes exactly the owner's entries it names, and keeps them across a restart", async () => {
    const adapter = createRawLogSearchBaseline(baselineOptions());
    await adapter.observe(evidence('phone', 'Phone number: 503-555-0142.'));
    await adapter.observe(
      evidence('teammate', 'Phone number: 206-555-0199.', { principal: 'co-user' }),
    );
    expect(await adapter.forget('teammate')).toEqual({ status: 'not-found', receipted: false });
    await adapter.restart();
    expect(await recalledContents(adapter, 'phone number')).toEqual([
      'Phone number: 503-555-0142.',
    ]);
    expect(await adapter.forget('phone')).toEqual({ status: 'completed', receipted: false });
    expect(await adapter.forget('phone')).toEqual({ status: 'not-found', receipted: false });
    expect(await recalledContents(adapter, 'phone number')).toEqual([]);
    await adapter.close();
  });
});

describe('instantOf', () => {
  test('formats an epoch time as an ISO-8601 instant', () => {
    expect(instantOf(0)).toBe('1970-01-01T00:00:00.000Z');
  });
});
