import { beforeEach, describe, expect, it } from 'bun:test';

import { rebuildDerivedIndexes } from '../src/derived-indexes';
import {
  EvidenceProjectionCommitError,
  type EvidenceProjectionStorage,
} from '../src/evidence-projection-storage';
import { rejectionOf } from '../src/testing/promise-outcome.test-support.ts';
import {
  FIXED_AT,
  makeAuthority,
  makeFact,
  makeInlineEvidence,
  NAMESPACE,
  supersededRevision,
  TENANT,
} from './evidence-projection-fixtures';

async function commitCodeOf(promise: Promise<unknown>): Promise<string | undefined> {
  const error = await rejectionOf(promise);
  expect(error).toBeInstanceOf(EvidenceProjectionCommitError);
  return (error as EvidenceProjectionCommitError).code;
}

export function registerSupersessionContractTests(options: {
  makeBackend: () => EvidenceProjectionStorage;
}): void {
  let storage: EvidenceProjectionStorage;
  beforeEach(async () => {
    storage = options.makeBackend();
    await storage.init();
  });

  describe('evidence supersession', () => {
    it('writes a marker with the successor and hides the predecessor from default listings', async () => {
      const original = makeInlineEvidence('e1');
      await storage.appendEvidence(original);
      const successor = makeInlineEvidence('e2', { supersedes: ['e1'], kind: 'operator' });
      expect(await storage.appendEvidence(successor)).toBe('appended');

      expect(await storage.getEvidenceSupersession(TENANT, 'e1')).toEqual({
        schemaVersion: 1,
        supersededBy: 'e2',
        at: successor.writtenAt,
      });
      expect(await storage.getEvidence(TENANT, 'e1')).toEqual(original);
      const visible = await storage.listEvidence({ tenantId: TENANT });
      expect(visible.map((record) => record.id)).toEqual(['e2']);
      const all = await storage.listEvidence({ tenantId: TENANT, includeSuperseded: true });
      expect(all.map((record) => record.id).toSorted()).toEqual(['e1', 'e2']);
      const markers = await storage.listEvidenceSupersessions({ tenantId: TENANT });
      expect([...markers.keys()]).toEqual(['e1']);
    });

    it('refuses a second successor for the same predecessor', async () => {
      await storage.appendEvidence(makeInlineEvidence('e1'));
      await storage.appendEvidence(makeInlineEvidence('e2', { supersedes: ['e1'] }));
      const code = await commitCodeOf(
        storage.appendEvidence(makeInlineEvidence('e3', { supersedes: ['e1'] })),
      );
      expect(code).toBe('evidence-superseded');
      expect(await storage.getEvidence(TENANT, 'e3')).toBeUndefined();
    });

    it('refuses a successor that names a predecessor that is not stored', async () => {
      const code = await commitCodeOf(
        storage.appendEvidence(makeInlineEvidence('e2', { supersedes: ['missing'] })),
      );
      expect(code).toBe('evidence-not-found');
      expect(await storage.getEvidence(TENANT, 'e2')).toBeUndefined();
    });

    it('refuses a commit that appends and supersedes the same record', async () => {
      const code = await commitCodeOf(
        storage.commit({
          tenantId: TENANT,
          evidence: [makeInlineEvidence('e1'), makeInlineEvidence('e2', { supersedes: ['e1'] })],
        }),
      );
      expect(code).toBe('invalid-commit');
    });

    it('refuses two successors for one predecessor in one commit', async () => {
      await storage.appendEvidence(makeInlineEvidence('e1'));
      const code = await commitCodeOf(
        storage.commit({
          tenantId: TENANT,
          evidence: [
            makeInlineEvidence('e2', { supersedes: ['e1'] }),
            makeInlineEvidence('e3', { supersedes: ['e1'] }),
          ],
        }),
      );
      expect(code).toBe('invalid-commit');
      expect(await storage.getEvidenceSupersession(TENANT, 'e1')).toBeUndefined();
    });
  });

  describe('the correction flow', () => {
    it('supersedes evidence and re-projects it in one atomic commit, replayable as a no-op', async () => {
      const original = makeInlineEvidence('e1', { text: 'The user lives in Boston.' });
      const correction = makeInlineEvidence('e2', {
        text: 'The user lives in Denver.',
        kind: 'operator',
        supersedes: ['e1'],
      });
      const stale = makeFact('p1', [original], {
        payload: { statement: 'The user lives in Boston.', entities: ['Boston'] },
      });
      await storage.commit({ tenantId: TENANT, evidence: [original], projections: [stale] });

      const corrected = makeFact('p2', [correction], {
        transition: { kind: 'created', at: FIXED_AT + 10, supersedes: [{ id: 'p1', revision: 1 }] },
        payload: { statement: 'The user lives in Denver.', entities: ['Denver'] },
      });
      const request = {
        tenantId: TENANT,
        evidence: [correction],
        projections: [corrected, supersededRevision(stale, { id: 'p2', revision: 1 })],
      };
      const first = await storage.commit(request);
      expect(first.evidence).toEqual([{ id: 'e2', outcome: 'appended' }]);
      expect(first.projections.map((entry) => entry.outcome)).toEqual(['written', 'written']);

      const indexes = await rebuildDerivedIndexes({
        storage,
        tenantId: TENANT,
        namespace: NAMESPACE,
        authority: makeAuthority(),
      });
      expect(indexes.lexical.query('Denver', { limit: 5 }).map((hit) => hit.id)).toEqual(['p2']);
      expect(indexes.lexical.query('Boston', { limit: 5 })).toEqual([]);
      expect(await storage.getEvidence(TENANT, 'e1')).toEqual(original);
      expect(indexes.graph.query({ from: 'evidence:e2' })).toContainEqual({
        from: 'evidence:e2',
        to: 'evidence:e1',
        kind: 'evidence-supersession',
      });
      expect(indexes.graph.query({ from: 'projection:p2' })).toContainEqual({
        from: 'projection:p2',
        to: 'projection:p1',
        kind: 'projection-supersession',
      });

      const replay = await storage.commit(request);
      expect(replay.evidence.every((entry) => entry.outcome === 'duplicate')).toBe(true);
      expect(replay.projections.every((entry) => entry.outcome === 'duplicate')).toBe(true);
      expect(await storage.listProjectionHistory(TENANT, NAMESPACE, 'p1')).toHaveLength(2);
      expect(await storage.listProjectionHistory(TENANT, NAMESPACE, 'p2')).toHaveLength(1);
    });

    it('never stores a projection of evidence a concurrent correction superseded', async () => {
      const original = makeInlineEvidence('e1');
      await storage.appendEvidence(original);
      const correction = makeInlineEvidence('e2', { supersedes: ['e1'] });
      const [correctionOutcome, projectionOutcome] = await Promise.allSettled([
        storage.commit({ tenantId: TENANT, evidence: [correction] }),
        storage.commit({ tenantId: TENANT, projections: [makeFact('p1', [original])] }),
      ]);
      expect(correctionOutcome.status).toBe('fulfilled');
      const stored = (await storage.getProjection(TENANT, NAMESPACE, 'p1')) !== undefined;
      expect(stored).toBe(projectionOutcome.status === 'fulfilled');
      if (projectionOutcome.status === 'rejected') {
        expect((projectionOutcome.reason as EvidenceProjectionCommitError).code).toBe(
          'evidence-superseded',
        );
      }
    });
  });
}
