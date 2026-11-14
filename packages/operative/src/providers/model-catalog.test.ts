/**
 * AB-64's `BackendDescriptor`/`ModelCatalog` surface, over the neutral fixture rows: Operative holds
 * no row of its own, so these tests check what `createModelCatalog` does with the rows it is given.
 * The rows of each vendor, and what is asserted of them, are tested in that vendor's package.
 */
import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { describe, expect, it } from 'bun:test';

import {
  FIXTURE_PROVIDERS,
  createFixtureCatalog,
  fixtureRows,
} from '../testing/model-catalog.test-support.ts';
import { createModelCatalog } from './model-catalog.ts';

const FIXED_NOW = '2026-09-02T12:00:00.000Z';
const fixedNow = () => FIXED_NOW;

describe('createModelCatalog: the rows it is given', () => {
  it('holds no row of its own', () => {
    expect(createModelCatalog({ now: fixedNow }).descriptors).toEqual([]);
  });

  it('offers exactly the rows it is given, in order, after checking each', () => {
    const rows = fixtureRows(FIXED_NOW);
    const catalog = createModelCatalog({ now: fixedNow, descriptors: rows });
    expect(catalog.descriptors).toEqual(rows);
  });

  it('rejects a repeated (provider, model) and a provider name that is not valid', () => {
    const [first] = fixtureRows(FIXED_NOW);
    expect(() => createModelCatalog({ descriptors: [first!, first!] })).toThrow();
    expect(() =>
      createModelCatalog({ descriptors: [{ ...first!, provider: 'Not A Provider' }] }),
    ).toThrow('not a valid provider name');
  });

  it('gives every fixture provider at least one row, so a capability projection cannot pass vacuously', () => {
    for (const provider of FIXTURE_PROVIDERS) {
      expect(fixtureRows().some((row) => row.provider === provider)).toBe(true);
    }
  });

  it('populates a modalities entry for every Modality key on every row, with sane limits', () => {
    for (const row of fixtureRows()) {
      for (const modality of ['text', 'image', 'audio', 'video', 'document', 'file'] as const) {
        expect(row.modalities[modality]).toBeDefined();
      }
      expect(row.contextWindowTokens).toBeGreaterThan(0);
      expect(row.maxOutputTokens).toBeGreaterThan(0);
    }
  });
});

describe('createModelCatalog: catalog invariants', () => {
  it('is deeply frozen: the catalog, its descriptors array, and each descriptor', () => {
    const catalog = createFixtureCatalog({ now: fixedNow });
    expect(Object.isFrozen(catalog)).toBe(true);
    expect(Object.isFrozen(catalog.descriptors)).toBe(true);
    for (const row of catalog.descriptors) {
      expect(Object.isFrozen(row)).toBe(true);
    }
  });

  it('declares media counts and provider fetch behavior on every row, consistent with the modality matrix', () => {
    const catalog = createFixtureCatalog({ now: fixedNow });
    for (const row of catalog.descriptors) {
      expect(typeof row.providerFetchesRemoteUrls).toBe('boolean');
      expect(Object.isFrozen(row.mediaCounts)).toBe(true);
      // A cap on a modality the backend takes no input for would never apply.
      for (const count of row.mediaCounts) {
        expect(row.modalities[count.modality].input).toBe(true);
        expect(count.maxPerRequest).toBeGreaterThan(0);
      }
      for (const limit of row.mediaLimits) {
        expect(row.modalities[limit.modality].input).toBe(true);
      }
    }
  });

  it("is deeply frozen one level into a descriptor's own nested values", () => {
    const catalog = createFixtureCatalog({ now: fixedNow });
    for (const row of catalog.descriptors) {
      expect(Object.isFrozen(row.aliases)).toBe(true);
      expect(Object.isFrozen(row.mimeFamilies)).toBe(true);
      expect(Object.isFrozen(row.mediaLimits)).toBe(true);
      expect(Object.isFrozen(row.parameterCompatibility)).toBe(true);
      expect(Object.isFrozen(row.effort)).toBe(true);
      expect(Object.isFrozen(row.effort.portable)).toBe(true);
      expect(Object.isFrozen(row.effort.degradesTo)).toBe(true);
      expect(Object.isFrozen(row.modalities)).toBe(true);
      if (row.pricing) expect(Object.isFrozen(row.pricing)).toBe(true);
    }
  });

  it('starts at revision 1', () => {
    expect(createFixtureCatalog({ now: fixedNow }).revision).toBe(1);
  });

  it('reports the privileged projection', () => {
    expect(createFixtureCatalog({ now: fixedNow }).projection).toBe('privileged');
  });

  it('is never stale on construction', () => {
    expect(createFixtureCatalog({ now: fixedNow }).stale).toBe(false);
  });
  it('reads only the injected clock for generatedAt, and keeps the freshness of each row it is given', () => {
    const catalog = createFixtureCatalog({ now: fixedNow });
    expect(catalog.generatedAt).toBe(FIXED_NOW);
    for (const row of catalog.descriptors) expect(row.freshness).toBe(FIXED_NOW);
  });

  it('defaults now to a real ISO timestamp when not injected, without this test reading the wall clock', () => {
    expect(Number.isNaN(Date.parse(createModelCatalog().generatedAt))).toBe(false);
  });

  it('a manual RuntimeServices controls generatedAt when now is not injected (AB-325)', async () => {
    const runtime = createManualRuntimeServices();
    await runtime.advance(54_321);
    expect(createModelCatalog({ runtime }).generatedAt).toBe(runtime.clock.nowISO());
  });

  it('an explicit now still takes precedence over runtime when both are supplied', () => {
    const runtime = createManualRuntimeServices();
    const catalog = createModelCatalog({ now: fixedNow, runtime });

    expect(catalog.generatedAt).toBe(FIXED_NOW);
  });
});
