import { describe, expect, it } from 'bun:test';

import { A2UI_BASIC_CATALOG_ID, A2UI_CINDER_CATALOG_ID, supportedCatalogIdsOf } from './catalogs';

describe('reading a client’s declared catalogs', () => {
  it('returns the listed ids from the v0.9 entry', () => {
    expect(
      supportedCatalogIdsOf({
        'v0.9': { supportedCatalogIds: [A2UI_BASIC_CATALOG_ID, A2UI_CINDER_CATALOG_ID] },
      }),
    ).toEqual([A2UI_BASIC_CATALOG_ID, A2UI_CINDER_CATALOG_ID]);
    expect(supportedCatalogIdsOf({ 'v0.9': { supportedCatalogIds: [] } })).toEqual([]);
  });

  it('reads anything else as no declaration', () => {
    const malformed = [
      undefined,
      null,
      'v0.9',
      [],
      {},
      { 'v0.9': 'x' },
      { 'v0.9': null },
      { 'v0.9': {} },
      { 'v0.9': { supportedCatalogIds: 'basic' } },
      { 'v0.9': { supportedCatalogIds: [A2UI_BASIC_CATALOG_ID, 7] } },
      { 'v0.9.1': { supportedCatalogIds: [A2UI_BASIC_CATALOG_ID] } },
    ];
    for (const capabilities of malformed) {
      expect(supportedCatalogIdsOf(capabilities)).toBeUndefined();
    }
  });
});
