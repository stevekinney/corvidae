import { MemoryStorage } from '@lostgradient/storage';
import { describe, expect, it } from 'bun:test';

import { createInMemoryEvidenceProjectionStorage } from '../src/create-in-memory-evidence-projection-storage';
import { createWeftEvidenceProjectionStorage } from '../src/create-weft-evidence-projection-storage';
import type { EvidenceProjectionStorage } from '../src/evidence-projection-storage';
import type {
  ApplyPlannedBatch,
  PlannedBatch,
  WrapApply,
} from '../src/evidence-projection-store-core';
import { createMemoryAuthority } from '../src/governance/authority';
import { createTransitionEngine } from '../src/transition-engine';
import type { TransitionEvent } from '../src/transition-events';
import { transitionDigest, type TransitionProposal } from '../src/transition-proposal';
import { FIXED_AT, makeInlineEvidence, OWNER, TENANT } from './evidence-projection-fixtures';

/**
 * Exact retry: one proposal submitted twice, under two different clocks, is
 * one commit and two equal receipts. The digest covers every proposal field
 * except the fields the engine stamps from its own `now()`, so the second clock
 * cannot make the second submission look like a different proposal.
 */

const FIRST_INSTANT = FIXED_AT + 1_000;
const SECOND_INSTANT = FIXED_AT + 3_600_000;

const writeAuthority = createMemoryAuthority({
  principal: { kind: 'user', id: 'user-1' },
  tenantId: TENANT,
  ownerId: OWNER,
  purpose: 'test',
  capabilities: ['memory:write'],
  policyRevision: 'authorization:1',
  projection: 'bureau',
});

/** The evidence as proposed: everything a stored record has except `writtenAt`. */
function proposedEvidence(id: string) {
  const { writtenAt: _writtenAt, ...proposed } = makeInlineEvidence(id);
  return proposed;
}

function appendProposal(operationId: string): TransitionProposal {
  return {
    kind: 'append-evidence',
    operationId,
    tenantId: TENANT,
    authority: writeAuthority,
    evidence: [proposedEvidence('e1')],
  };
}

/** Counts the batches the store applies, which is the number of commits. */
function countingWrapper(): { wrapApply: WrapApply; batches: PlannedBatch[] } {
  const batches: PlannedBatch[] = [];
  const wrapApply: WrapApply = (apply: ApplyPlannedBatch) => async (batch) => {
    batches.push(batch);
    return apply(batch);
  };
  return { wrapApply, batches };
}

const BACKENDS: ReadonlyArray<
  readonly [string, (wrapApply: WrapApply) => EvidenceProjectionStorage]
> = [
  ['in-memory', (wrapApply) => createInMemoryEvidenceProjectionStorage({ wrapApply })],
  ['weft', (wrapApply) => createWeftEvidenceProjectionStorage(new MemoryStorage(), { wrapApply })],
];

for (const [label, makeBackend] of BACKENDS) {
  describe(`exact retry (${label})`, () => {
    it('returns the original receipt for the same proposal under a later clock, applying nothing twice', async () => {
      const { wrapApply, batches } = countingWrapper();
      const storage = makeBackend(wrapApply);
      const events: TransitionEvent[] = [];
      let instant = FIRST_INSTANT;
      const engine = createTransitionEngine({
        storage,
        sink: (event) => {
          events.push(event);
        },
        now: () => instant,
      });

      const first = await engine.submit(appendProposal('operation-1'));
      instant = SECOND_INSTANT;
      const second = await engine.submit(appendProposal('operation-1'));

      expect(first.outcome).toBe('committed');
      expect(second.outcome).toBe('committed');
      if (first.outcome !== 'committed' || second.outcome !== 'committed') {
        throw new Error('both submissions must commit');
      }
      expect(first.replayed).toBe(false);
      expect(second.replayed).toBe(true);

      // Two equal receipts, and the replay returned the stored one unchanged.
      expect(second.receipt).toEqual(first.receipt);
      expect(first.receipt.committedAt).toBe(FIRST_INSTANT);
      expect(await engine.getReceipt(TENANT, 'operation-1')).toEqual(first.receipt);

      // One commit: the store applied exactly one batch, and it holds the first clock's stamps.
      expect(batches).toHaveLength(1);
      const stored = await storage.getEvidence(TENANT, 'e1');
      expect(stored?.writtenAt).toBe(FIRST_INSTANT);
      expect(await storage.listEvidence({ tenantId: TENANT })).toHaveLength(1);

      // The digest ignores the clock, so the replay recognized the proposal as the same one.
      expect(first.receipt.digest).toBe(transitionDigest(appendProposal('operation-1')));

      // The replay reconciled against the stored receipt instead of validating again.
      expect(events.map((event) => event.kind)).toEqual([
        'requested',
        'validation-started',
        'committed',
        'requested',
        'recovery-reconciled',
      ]);
      expect(events.every((event) => event.operationId === 'operation-1')).toBe(true);
    });
  });
}
