/**
 * COR-2143 — a row kept for a provider whose key is missing is `unavailable`, and does not make
 * the provider count as connected.
 */
import { describe, expect, test } from 'bun:test';

import { providerAttention } from './provider-attention.ts';

const sources = (
  rows: readonly { readonly availability: 'available' | 'unavailable' | 'unknown' }[],
) => ({
  rows: () => rows,
  auditTrail: () => undefined,
});

describe('the no-provider item', () => {
  test('is reported when the catalog holds only unavailable rows', async () => {
    const items = await providerAttention(
      sources([{ availability: 'unavailable' }, { availability: 'unavailable' }]),
    );
    expect(items).toEqual([{ kind: 'no-provider', area: 'providers', at: null, provider: null }]);
  });

  test('is reported when the catalog holds no row at all', async () => {
    expect(await providerAttention(sources([]))).toHaveLength(1);
  });

  test('is left out while any row can be called', async () => {
    expect(
      await providerAttention(
        sources([{ availability: 'unavailable' }, { availability: 'available' }]),
      ),
    ).toEqual([]);
    expect(await providerAttention(sources([{ availability: 'unknown' }]))).toEqual([]);
  });
});
