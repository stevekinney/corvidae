import { describe, expect, it } from 'bun:test';

import { type BackendDescriptor, createModelCatalog } from '@lostgradient/operative';

import { allowedDescriptorsOfFileAgent, resolveModelDescriptor } from '../agent-file-catalog';
import { findCatalogRow, isOfferedCatalogRow } from './create-models';

const seed = createModelCatalog().descriptors.find((row) => row.provider === 'anthropic')!;

function row(model: string, lifecycle?: 'retired'): BackendDescriptor {
  return {
    ...seed,
    model,
    aliases: [{ alias: `${model}-alias` } as BackendDescriptor['aliases'][number]],
    ...(lifecycle === undefined ? {} : { lifecycle }),
  };
}

describe('isOfferedCatalogRow', () => {
  const rows = [row('live'), row('old', 'retired')];

  it('rejects a retired row and accepts a live one', () => {
    expect(isOfferedCatalogRow(rows[0]!)).toBe(true);
    expect(isOfferedCatalogRow(rows[1]!)).toBe(false);
  });

  it('is the one decision of every resolver: none resolves a row it rejects', () => {
    for (const candidate of rows) {
      const offered = isOfferedCatalogRow(candidate);
      for (const name of [candidate.model, candidate.aliases[0]!.alias]) {
        const qualified = `${candidate.provider}/${name}`;
        const byResolve = resolveModelDescriptor(qualified, rows);
        expect('provider' in byResolve).toBe(offered);
        expect(findCatalogRow(rows, qualified) !== undefined).toBe(offered);
        expect(allowedDescriptorsOfFileAgent([qualified], rows).length === 1).toBe(offered);
      }
      expect(allowedDescriptorsOfFileAgent(undefined, rows).includes(candidate)).toBe(offered);
    }
  });
});
