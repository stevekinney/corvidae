import { beforeEach, describe, expect, it } from 'bun:test';

import { rebuildDerivedIndexes } from '../src/derived-indexes';
import type {
  EvidenceProjectionRecord,
  TransformationStep,
} from '../src/evidence-projection-schema';
import {
  EvidenceProjectionCommitError,
  type EvidenceProjectionStorage,
  ProjectionRevisionConflictError,
} from '../src/evidence-projection-storage';
import {
  digestOfText,
  type EvidenceRecord,
  MemoryEvidenceValidationError,
} from '../src/evidence-schema';
import { rejectionOf } from '../src/testing/promise-outcome.test-support.ts';
import {
  FIXED_AT,
  makeAssetEvidence,
  makeAuthority,
  makeFact,
  makeInlineEvidence,
  NAMESPACE,
  nextRevision,
  supersededRevision,
  TENANT,
} from './evidence-projection-fixtures';

const PRODUCER = { kind: 'service', id: 'extractor', version: '1' } as const;

function makeChunk(
  evidence: EvidenceRecord,
  overrides: { steps?: TransformationStep[]; text?: string } = {},
): EvidenceProjectionRecord {
  const text = overrides.text ?? 'Chunk body text.';
  const steps = overrides.steps ?? [
    {
      step: 'extract',
      producer: PRODUCER,
      inputDigest: evidence.digest,
      outputDigest: digestOfText('Extracted text.'),
    },
    {
      step: 'chunk',
      producer: PRODUCER,
      inputDigest: digestOfText('Extracted text.'),
      outputDigest: digestOfText(text),
    },
  ];
  return {
    ...makeFact('c1', [evidence]),
    kind: 'chunk',
    payload: { text, ordinal: 0, startLine: 0, endLine: 1, steps },
  };
}

async function rejection<T extends Error>(
  promise: Promise<unknown>,
  type: new (...args: never[]) => T,
): Promise<T> {
  const error = await rejectionOf(promise);
  expect(error).toBeInstanceOf(type);
  return error as T;
}

export function registerProjectionContractTests(options: {
  makeBackend: () => EvidenceProjectionStorage;
}): void {
  let storage: EvidenceProjectionStorage;
  let evidence: EvidenceRecord;
  let p1: EvidenceProjectionRecord;

  beforeEach(async () => {
    storage = options.makeBackend();
    await storage.init();
    evidence = makeInlineEvidence('e1');
    p1 = makeFact('p1', [evidence]);
    await storage.commit({ tenantId: TENANT, evidence: [evidence], projections: [p1] });
  });

  async function expectUnchanged(): Promise<void> {
    expect(await storage.getProjection(TENANT, NAMESPACE, 'p1')).toEqual(p1);
    expect(await storage.listProjectionHistory(TENANT, NAMESPACE, 'p1')).toEqual([p1]);
  }

  describe('projection revisions', () => {
    it('stores a created revision as current and as history, and replays it as a duplicate', async () => {
      expect(await storage.getProjectionRevision(TENANT, NAMESPACE, 'p1', 1)).toEqual(p1);
      expect(await storage.writeProjectionRevision(p1)).toBe('duplicate');
      await expectUnchanged();
    });

    it('keeps every revision in order and reports the latest as current', async () => {
      const rebuilt = nextRevision(p1, {
        transition: { kind: 'rebuilt', at: FIXED_AT + 5, rebuiltFromRevision: 1 },
        confidence: 0.5,
      });
      expect(await storage.writeProjectionRevision(rebuilt)).toBe('written');
      expect(await storage.getProjection(TENANT, NAMESPACE, 'p1')).toEqual(rebuilt);
      expect(await storage.listProjectionHistory(TENANT, NAMESPACE, 'p1')).toEqual([p1, rebuilt]);
    });

    it('rejects a revision-1 write that is not a creation, as malformed', async () => {
      const bad = makeFact('p2', [evidence], {
        transition: { kind: 'rebuilt', at: FIXED_AT, rebuiltFromRevision: 1 },
      });
      const error = await rejection(
        storage.writeProjectionRevision(bad),
        MemoryEvidenceValidationError,
      );
      expect(error.code).toBe('malformed');
      expect(await storage.getProjection(TENANT, NAMESPACE, 'p2')).toBeUndefined();
    });

    it('rejects a created transition at revision 2, as malformed', async () => {
      const bad = { ...p1, revision: 2 } as EvidenceProjectionRecord;
      const error = await rejection(
        storage.writeProjectionRevision(bad),
        MemoryEvidenceValidationError,
      );
      expect(error.code).toBe('malformed');
      await expectUnchanged();
    });

    it('rejects revision 2 for an id that was never created', async () => {
      const orphan = nextRevision(makeFact('p2', [evidence]), {
        transition: { kind: 'rebuilt', at: FIXED_AT, rebuiltFromRevision: 1 },
      });
      await rejection(storage.writeProjectionRevision(orphan), ProjectionRevisionConflictError);
      expect(await storage.getProjection(TENANT, NAMESPACE, 'p2')).toBeUndefined();
    });

    it('rejects revision 3 after revision 1', async () => {
      const skipped = {
        ...p1,
        revision: 3,
        transition: { kind: 'rebuilt', at: FIXED_AT, rebuiltFromRevision: 1 },
      } as EvidenceProjectionRecord;
      await rejection(storage.writeProjectionRevision(skipped), ProjectionRevisionConflictError);
      await expectUnchanged();
    });

    it('rejects a kind change as a new projection', async () => {
      const changed = nextRevision(p1, {
        kind: 'episode',
        payload: { summary: 'An episode.', occurredFrom: FIXED_AT },
        transition: { kind: 'rebuilt', at: FIXED_AT, rebuiltFromRevision: 1 },
      });
      const error = await rejection(
        storage.writeProjectionRevision(changed),
        EvidenceProjectionCommitError,
      );
      expect(error.code).toBe('invalid-commit');
      await expectUnchanged();
    });

    it('rejects a payload change on a superseded transition', async () => {
      const successor = makeFact('p2', [evidence]);
      await storage.writeProjectionRevision(successor);
      const tampered = {
        ...supersededRevision(p1, { id: 'p2', revision: 1 }),
        payload: { statement: 'A different statement.', entities: [] },
      } as EvidenceProjectionRecord;
      const error = await rejection(
        storage.writeProjectionRevision(tampered),
        EvidenceProjectionCommitError,
      );
      expect(error.code).toBe('invalid-commit');
      await expectUnchanged();
    });

    it('lets exactly one of two writers that both read revision 1 write revision 2', async () => {
      const rebuild = (confidence: number): EvidenceProjectionRecord =>
        nextRevision(p1, {
          confidence,
          transition: { kind: 'rebuilt', at: FIXED_AT + 5, rebuiltFromRevision: 1 },
        });
      const outcomes = await Promise.allSettled([
        storage.writeProjectionRevision(rebuild(0.4)),
        storage.writeProjectionRevision(rebuild(0.6)),
      ]);
      const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
      const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
      expect(fulfilled.map((outcome) => outcome.value)).toEqual(['written']);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]?.reason).toBeInstanceOf(ProjectionRevisionConflictError);
      expect(await storage.listProjectionHistory(TENANT, NAMESPACE, 'p1')).toHaveLength(2);
    });
  });

  describe('terminal and non-terminal statuses', () => {
    it('refuses a revision after superseded', async () => {
      await storage.writeProjectionRevision(makeFact('p2', [evidence]));
      const retired = supersededRevision(p1, { id: 'p2', revision: 1 });
      await storage.writeProjectionRevision(retired);
      const again = nextRevision(retired, {
        status: 'active',
        transition: { kind: 'rebuilt', at: FIXED_AT + 20, rebuiltFromRevision: 2 },
      });
      const error = await rejection(
        storage.writeProjectionRevision(again),
        EvidenceProjectionCommitError,
      );
      expect(error.code).toBe('projection-terminal');
    });

    it('stores a revoked revision through commit and refuses anything after it', async () => {
      const revoked = nextRevision(p1, {
        status: 'revoked',
        transition: { kind: 'revoked', at: FIXED_AT + 5, reasonCode: 'user-request' },
      });
      expect(await storage.writeProjectionRevision(revoked)).toBe('written');
      const revokedListing = await storage.listProjections({
        tenantId: TENANT,
        namespace: NAMESPACE,
        status: ['revoked'],
      });
      expect(revokedListing.map((record) => record.id)).toEqual(['p1']);
      const after = nextRevision(revoked, {
        status: 'active',
        transition: { kind: 'rebuilt', at: FIXED_AT + 6, rebuiltFromRevision: 2 },
      });
      const error = await rejection(
        storage.writeProjectionRevision(after),
        EvidenceProjectionCommitError,
      );
      expect(error.code).toBe('projection-terminal');
    });

    it('does not treat demoted as terminal', async () => {
      await storage.writeProjectionRevision(makeFact('p2', [evidence]));
      const demoted = nextRevision(p1, {
        status: 'demoted',
        transition: { kind: 'demoted', at: FIXED_AT + 5, demotedBy: { id: 'p2', revision: 1 } },
      });
      await storage.writeProjectionRevision(demoted);
      const rebuilt = nextRevision(demoted, {
        status: 'active',
        transition: { kind: 'rebuilt', at: FIXED_AT + 6, rebuiltFromRevision: 2 },
      });
      expect(await storage.writeProjectionRevision(rebuilt)).toBe('written');
    });
  });

  describe('source and reference checks at write time', () => {
    it('refuses a source digest that disagrees with the stored evidence and writes nothing', async () => {
      const wrong = makeFact('p2', [evidence], {
        sources: [{ evidenceId: 'e1', digest: digestOfText('some other bytes') }],
      });
      const error = await rejection(
        storage.writeProjectionRevision(wrong),
        MemoryEvidenceValidationError,
      );
      expect(error.code).toBe('digest-mismatch');
      expect(error.record).toBe('projection');
      expect(await storage.getProjection(TENANT, NAMESPACE, 'p2')).toBeUndefined();
    });

    it('refuses a projection of superseded evidence', async () => {
      await storage.appendEvidence(makeInlineEvidence('e2', { supersedes: ['e1'] }));
      const error = await rejection(
        storage.writeProjectionRevision(makeFact('p2', [evidence])),
        EvidenceProjectionCommitError,
      );
      expect(error.code).toBe('evidence-superseded');
    });

    it('refuses a projection of evidence that is not stored', async () => {
      const missing = makeInlineEvidence('e-missing');
      const error = await rejection(
        storage.writeProjectionRevision(makeFact('p2', [missing])),
        EvidenceProjectionCommitError,
      );
      expect(error.code).toBe('evidence-not-found');
    });

    it('refuses a reference to a projection revision that does not exist', async () => {
      const dangling = supersededRevision(p1, { id: 'ghost', revision: 1 });
      const error = await rejection(
        storage.writeProjectionRevision(dangling),
        EvidenceProjectionCommitError,
      );
      expect(error.code).toBe('projection-not-found');
      await expectUnchanged();
    });

    it('accepts a chunk whose digest chain runs from the evidence to its text', async () => {
      const asset = makeAssetEvidence('doc1');
      await storage.appendEvidence(asset);
      expect(await storage.writeProjectionRevision(makeChunk(asset))).toBe('written');
    });

    it('refuses a chunk whose chain does not start at the evidence digest', async () => {
      const asset = makeAssetEvidence('doc1');
      await storage.appendEvidence(asset);
      const broken = makeChunk(asset, {
        steps: [
          {
            step: 'chunk',
            producer: PRODUCER,
            inputDigest: digestOfText('not the asset'),
            outputDigest: digestOfText('Chunk body text.'),
          },
        ],
      });
      const error = await rejection(
        storage.writeProjectionRevision(broken),
        MemoryEvidenceValidationError,
      );
      expect(error.code).toBe('digest-mismatch');
    });

    it('refuses a chunk with a broken link or a last step that is not its own text', async () => {
      const asset = makeAssetEvidence('doc1');
      await storage.appendEvidence(asset);
      const brokenLink = makeChunk(asset, {
        steps: [
          {
            step: 'extract',
            producer: PRODUCER,
            inputDigest: asset.digest,
            outputDigest: digestOfText('Extracted text.'),
          },
          {
            step: 'chunk',
            producer: PRODUCER,
            inputDigest: digestOfText('something else'),
            outputDigest: digestOfText('Chunk body text.'),
          },
        ],
      });
      const wrongText = makeChunk(asset, {
        steps: [
          {
            step: 'chunk',
            producer: PRODUCER,
            inputDigest: asset.digest,
            outputDigest: digestOfText('not the chunk text'),
          },
        ],
      });
      for (const bad of [brokenLink, wrongText]) {
        const error = await rejection(
          storage.writeProjectionRevision(bad),
          MemoryEvidenceValidationError,
        );
        expect(error.code).toBe('digest-mismatch');
      }
    });
  });

  describe('derived-index admission', () => {
    async function searchableIds(
      ownerId: string,
      capabilities?: ('memory:search' | 'memory:get')[],
    ): Promise<string[]> {
      const indexes = await rebuildDerivedIndexes({
        storage,
        tenantId: TENANT,
        namespace: NAMESPACE,
        authority: makeAuthority({ ownerId, ...(capabilities ? { capabilities } : {}) }),
      });
      return indexes.temporal.query({ asOf: FIXED_AT + 1 }).map((entry) => entry.id);
    }

    it('admits an owner, and refuses a non-owner and a sharedWith grantee for search', async () => {
      expect(await searchableIds('owner-1')).toEqual(['p1']);
      expect(await searchableIds('owner-2')).toEqual([]);
      const sharedWith = makeInlineEvidence('e-shared', {
        authorizationScope: { visibility: 'private', sharedWith: ['owner-2'] },
      });
      await storage.commit({
        tenantId: TENANT,
        evidence: [sharedWith],
        projections: [makeFact('p-shared', [sharedWith])],
      });
      expect(await searchableIds('owner-2')).toEqual([]);
    });

    it('admits any authorized principal to shared evidence, and none without the search capability', async () => {
      const shared = makeInlineEvidence('e-public', {
        authorizationScope: { visibility: 'shared', sharedWith: [] },
      });
      await storage.commit({
        tenantId: TENANT,
        evidence: [shared],
        projections: [makeFact('p-public', [shared])],
      });
      expect(await searchableIds('owner-2')).toEqual(['p-public']);
      expect(await searchableIds('owner-2', ['memory:get'])).toEqual([]);
    });

    it('excludes a revoked projection', async () => {
      await storage.writeProjectionRevision(
        nextRevision(p1, {
          status: 'revoked',
          transition: { kind: 'revoked', at: FIXED_AT + 5, reasonCode: 'user-request' },
        }),
      );
      expect(await searchableIds('owner-1')).toEqual([]);
    });

    it('excludes a projection whose source evidence was superseded after it was written', async () => {
      await storage.appendEvidence(makeInlineEvidence('e2', { supersedes: ['e1'] }));
      expect(await searchableIds('owner-1')).toEqual([]);
    });
  });

  describe('listing', () => {
    it('filters current projections by status', async () => {
      await storage.writeProjectionRevision(makeFact('p2', [evidence]));
      await storage.writeProjectionRevision(supersededRevision(p1, { id: 'p2', revision: 1 }));
      const active = await storage.listProjections({
        tenantId: TENANT,
        namespace: NAMESPACE,
        status: ['active'],
      });
      expect(active.map((record) => record.id)).toEqual(['p2']);
      expect(
        await storage.listProjections({ tenantId: TENANT, namespace: NAMESPACE }),
      ).toHaveLength(2);
      expect(await storage.listProjections({ tenantId: TENANT, namespace: 'other' })).toEqual([]);
    });

    it('treats the same id in another namespace as a different projection', async () => {
      const elsewhere = makeFact('p1', [evidence], { namespace: 'elsewhere' });
      await storage.writeProjectionRevision(elsewhere);
      expect(await storage.getProjection(TENANT, 'elsewhere', 'p1')).toEqual(elsewhere);
      expect(await storage.getProjection(TENANT, NAMESPACE, 'p1')).toEqual(p1);
    });
  });
}
