import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { createInMemoryEvidenceProjectionStorage } from '../src/create-in-memory-evidence-projection-storage';
import { EvidenceProjectionCapacityError } from '../src/evidence-projection-storage';
import {
  FIXED_AT,
  makeFact,
  makeInlineEvidence,
  NAMESPACE,
  nextRevision,
  TENANT,
} from './evidence-projection-fixtures';

/** In-memory-specific behavior: the capacity bound, and independence from Weft. */

describe('capacity', () => {
  it('refuses a commit that would exceed maxEvidence and applies nothing', async () => {
    const storage = createInMemoryEvidenceProjectionStorage({ maxEvidence: 2 });
    await storage.appendEvidence(makeInlineEvidence('e1'));
    const error = await rejectionOf(
      storage.commit({
        tenantId: TENANT,
        evidence: [makeInlineEvidence('e2'), makeInlineEvidence('e3')],
      }),
    );
    expect(error).toBeInstanceOf(EvidenceProjectionCapacityError);
    expect((error as EvidenceProjectionCapacityError).bound).toBe('maxEvidence');
    expect(await storage.getEvidence(TENANT, 'e2')).toBeUndefined();
    expect(await storage.getEvidence(TENANT, 'e3')).toBeUndefined();
    expect(await storage.listEvidence({ tenantId: TENANT })).toHaveLength(1);
  });

  it('counts a replayed record as free, and a superseded record as still stored', async () => {
    const storage = createInMemoryEvidenceProjectionStorage({ maxEvidence: 2 });
    const e1 = makeInlineEvidence('e1');
    await storage.appendEvidence(e1);
    expect(await storage.appendEvidence(e1)).toBe('duplicate');
    await storage.appendEvidence(makeInlineEvidence('e2', { supersedes: ['e1'] }));
    const error = await rejectionOf(storage.appendEvidence(makeInlineEvidence('e3')));
    expect(error).toBeInstanceOf(EvidenceProjectionCapacityError);
  });

  it('refuses a projection revision past maxProjectionRevisions, history included', async () => {
    const storage = createInMemoryEvidenceProjectionStorage({ maxProjectionRevisions: 2 });
    const e1 = makeInlineEvidence('e1');
    const p1 = makeFact('p1', [e1]);
    await storage.commit({ tenantId: TENANT, evidence: [e1], projections: [p1] });
    const rebuilt = nextRevision(p1, {
      transition: { kind: 'rebuilt', at: FIXED_AT + 1, rebuiltFromRevision: 1 },
    });
    await storage.writeProjectionRevision(rebuilt);
    const third = nextRevision(rebuilt, {
      transition: { kind: 'rebuilt', at: FIXED_AT + 2, rebuiltFromRevision: 2 },
    });
    const error = await rejectionOf(storage.writeProjectionRevision(third));
    expect((error as EvidenceProjectionCapacityError).bound).toBe('maxProjectionRevisions');
    expect(await storage.getProjection(TENANT, NAMESPACE, 'p1')).toEqual(rebuilt);
  });

  it('rejects a bound that is not a positive integer', () => {
    expect(() => createInMemoryEvidenceProjectionStorage({ maxEvidence: 0 })).toThrow(RangeError);
    expect(() => createInMemoryEvidenceProjectionStorage({ maxProjectionRevisions: 1.5 })).toThrow(
      RangeError,
    );
  });
});

describe('independence from Weft', () => {
  const sources = [
    'create-in-memory-evidence-projection-storage.ts',
    'evidence-projection-store-core.ts',
    'evidence-projection-keys.ts',
    'evidence-projection-schema.ts',
    'evidence-projection-storage.ts',
    'evidence-schema.ts',
    'evidence-schema-primitives.ts',
    'derived-indexes.ts',
    'transition-authority.ts',
    'transition-engine.ts',
    'transition-events.ts',
    'transition-invariants.ts',
    'transition-outcome.ts',
    'transition-plan.ts',
    'transition-proposal.ts',
    'transition-reader.ts',
    'transition-receipt-builder.ts',
    'transition-receipt.ts',
    'transition-validator.ts',
    'consolidate-projections.ts',
  ];

  it('imports nothing from @lostgradient/weft in the modules a standalone Agent loads', () => {
    for (const file of sources) {
      const path = fileURLToPath(new URL(`../src/${file}`, import.meta.url));
      expect(readFileSync(path, 'utf8')).not.toContain('@lostgradient/weft');
    }
  });
});
