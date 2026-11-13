import { describe, expect, it } from 'bun:test';

import { type BackendDescriptor, createModelCatalog } from '@lostgradient/operative';

import { allowedDescriptorsOfFileAgent, resolveModelDescriptor } from '../agent-file-catalog';
import { findCatalogRow, findDecisionRow, isOfferedCatalogRow } from './create-models';

const seed = createModelCatalog().descriptors.find((row) => row.provider === 'anthropic')!;

function row(model: string, lifecycle?: 'retired'): BackendDescriptor {
  return {
    ...seed,
    model,
    aliases: [{ alias: `${model}-alias` } as BackendDescriptor['aliases'][number]],
    ...(lifecycle === undefined ? {} : { lifecycle }),
  };
}

function decisionOnly(model: string): BackendDescriptor {
  return { ...row(model), decisions: { kinds: ['boolean'], only: true } };
}

describe('a row that only decides (COR-2156)', () => {
  const rows = [row('live'), decisionOnly('jev')];

  it('is not offered to agents, and an agent file naming it is told the row only decides', () => {
    expect(isOfferedCatalogRow(rows[1]!)).toBe(false);
    const problem = resolveModelDescriptor(`${seed.provider}/jev`, rows);
    expect(problem).toMatchObject({ code: 'unknown-model' });
    expect('message' in problem && problem.message).toContain('only decides');
    expect(allowedDescriptorsOfFileAgent(undefined, rows)).toEqual([rows[0]!]);
    expect(findCatalogRow(rows, `${seed.provider}/jev`)).toBeUndefined();
  });

  it('is still found for decisions.model, and a row that also generates stays offered', () => {
    expect(findDecisionRow(rows, `${seed.provider}/jev`)).toBe(rows[1]);
    expect(findDecisionRow(rows, `${seed.provider}/jev-alias`)).toBe(rows[1]);
    const both = { ...rows[1]!, decisions: { kinds: ['boolean' as const], only: false } };
    expect(isOfferedCatalogRow(both)).toBe(true);
  });

  it('is not what a model the catalog lacks reads as', () => {
    const missing = resolveModelDescriptor(`${seed.provider}/nope`, rows);
    expect('message' in missing && missing.message).toContain("not in the deployment's");
  });
});

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
