import { MemoryStorage } from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import { createInMemoryEvidenceProjectionStorage } from '../src/create-in-memory-evidence-projection-storage';
import { createWeftEvidenceProjectionStorage } from '../src/create-weft-evidence-projection-storage';
import {
  buildDerivedIndexes,
  DEMOTED_SCORE_WEIGHT,
  DerivedIndexConsistencyError,
  type DerivedIndexes,
  EmbeddingMismatchError,
  rebuildDerivedIndexes,
} from '../src/derived-indexes';
import { createEvidenceProjectionKeys } from '../src/evidence-projection-keys';
import type { EvidenceProjectionRecord } from '../src/evidence-projection-schema';
import type { EvidenceProjectionStorage } from '../src/evidence-projection-storage';
import { digestOfText, MemoryEvidenceValidationError } from '../src/evidence-schema';
import { rejectionOf } from '../src/testing/promise-outcome.test-support.ts';
import {
  FIXED_AT,
  makeAssetEvidence,
  makeAuthority,
  makeFact,
  makeInlineEvidence,
  NAMESPACE,
  nextRevision,
  OTHER_TENANT,
  supersededRevision,
  TENANT,
} from './evidence-projection-fixtures';

/**
 * The five indexes are derived projections: this file drops each and rebuilds
 * it from storage, then compares its fingerprint, entry count, and the results
 * of a fixed set of queries, on both backends. Every comparison also pins the
 * expected content, so a pair of empty snapshots cannot pass.
 */

const e1 = makeInlineEvidence('e1', { text: 'Ana prefers green tea. Boston winters are cold.' });
const asset = makeAssetEvidence('doc1');

function embedded(vector: number[]): { model: string; vector: number[] } {
  return { model: 'test-model', vector };
}

const f1 = makeFact('f1', [e1], {
  payload: { statement: 'Ana prefers green tea', entities: ['Ana', 'tea'] },
  embedding: embedded([1, 0, 0]),
});
const f2 = makeFact('f2', [e1], {
  payload: { statement: 'Boston winters are cold', entities: ['Boston'] },
  embedding: embedded([0, 1, 0]),
  validity: { validFrom: FIXED_AT, validUntil: FIXED_AT + 100 },
});
const preference = {
  ...makeFact('pref1', [e1]),
  kind: 'preference',
  payload: { subject: 'Ana', statement: 'likes tea' },
  embedding: embedded([0.5, 0.5, 0]),
} as EvidenceProjectionRecord;
const episode = {
  ...makeFact('ep1', [e1]),
  kind: 'episode',
  payload: { summary: 'A trip to Boston', occurredFrom: FIXED_AT },
} as EvidenceProjectionRecord;
const chunk = {
  ...makeFact('c1', [asset]),
  kind: 'chunk',
  payload: {
    text: 'Chunk of the scanned page.',
    ordinal: 0,
    startLine: 0,
    endLine: 1,
    steps: [
      {
        step: 'chunk',
        producer: { kind: 'service', id: 'chunker', version: '1' },
        inputDigest: asset.digest,
        outputDigest: digestOfText('Chunk of the scanned page.'),
      },
    ],
  },
} as EvidenceProjectionRecord;
const summary = {
  ...makeFact('s1', [e1]),
  kind: 'summary',
  payload: { text: 'Weather and tea notes', covers: [{ id: 'f2', revision: 1 }] },
} as EvidenceProjectionRecord;

async function seed(storage: EvidenceProjectionStorage): Promise<void> {
  await storage.commit({
    tenantId: TENANT,
    evidence: [e1, asset],
    projections: [f1, f2, preference, episode, chunk],
  });
  await storage.commit({ tenantId: TENANT, projections: [summary] });
}

function rebuild(storage: EvidenceProjectionStorage): Promise<DerivedIndexes> {
  return rebuildDerivedIndexes({
    storage,
    tenantId: TENANT,
    namespace: NAMESPACE,
    authority: makeAuthority(),
  });
}

const BACKENDS: ReadonlyArray<readonly [string, () => EvidenceProjectionStorage]> = [
  ['in-memory', () => createInMemoryEvidenceProjectionStorage()],
  ['weft', () => createWeftEvidenceProjectionStorage(new MemoryStorage())],
];

for (const [label, makeBackend] of BACKENDS) {
  describe(`drop and rebuild each derived index (${label})`, () => {
    async function dropAndRebuild(): Promise<[DerivedIndexes, DerivedIndexes]> {
      const storage = makeBackend();
      await seed(storage);
      return [await rebuild(storage), await rebuild(storage)];
    }

    it('rebuilds the lexical index with the same fingerprint, count, and results', async () => {
      const [before, after] = await dropAndRebuild();
      const queries = ['tea', 'Boston winters', 'scanned page', 'nothing matches this'];
      const run = (indexes: DerivedIndexes) =>
        queries.map((query) => indexes.lexical.query(query, { limit: 10 }));
      expect(run(after)).toEqual(run(before));
      expect(after.lexical.entryCount).toBe(6);
      expect(after.lexical.inputFingerprint).toBe(before.lexical.inputFingerprint);
      expect(before.lexical.query('tea', { limit: 10 }).map((hit) => hit.id)).toContain('f1');
      expect(before.lexical.query('scanned page', { limit: 1 })[0]?.id).toBe('c1');
      expect(before.lexical.query('nothing matches this', { limit: 10 })).toEqual([]);
    });

    it('rebuilds the vector index with the same results', async () => {
      const [before, after] = await dropAndRebuild();
      const run = (indexes: DerivedIndexes) =>
        [
          [1, 0, 0],
          [0, 1, 0],
        ].map((vector) => indexes.vector.query(vector, { limit: 10 }));
      expect(run(after)).toEqual(run(before));
      expect(after.vector.entryCount).toBe(3);
      expect(after.vector.model).toBe('test-model');
      expect(before.vector.query([1, 0, 0], { limit: 1 })[0]?.id).toBe('f1');
      expect(before.vector.query([0, 1, 0], { limit: 1 })[0]?.id).toBe('f2');
      expect(
        before.vector.query([1, 0, 0], { limit: 10, threshold: 0.99 }).map((hit) => hit.id),
      ).toEqual(['f1']);
    });

    it('rebuilds the temporal index with the same intervals', async () => {
      const [before, after] = await dropAndRebuild();
      const instants = [FIXED_AT - 1, FIXED_AT + 50, FIXED_AT + 100, FIXED_AT + 1_000];
      const run = (indexes: DerivedIndexes) =>
        instants.map((asOf) => indexes.temporal.query({ asOf }));
      expect(run(after)).toEqual(run(before));
      expect(before.temporal.query({ asOf: FIXED_AT - 1 })).toEqual([]);
      expect(before.temporal.query({ asOf: FIXED_AT + 50 }).map((entry) => entry.id)).toContain(
        'f2',
      );
      // The interval is half-open: f2 is no longer valid at its own validUntil.
      expect(
        before.temporal.query({ asOf: FIXED_AT + 100 }).map((entry) => entry.id),
      ).not.toContain('f2');
    });

    it('rebuilds the entity index, including a preference subject', async () => {
      const [before, after] = await dropAndRebuild();
      const run = (indexes: DerivedIndexes) =>
        ['Ana', 'Boston', 'tea', 'nobody'].map((entity) => indexes.entity.query(entity));
      expect(run(after)).toEqual(run(before));
      expect(before.entity.query('Ana')).toEqual(['f1', 'pref1']);
      expect(before.entity.query('Boston')).toEqual(['f2']);
      expect(before.entity.query('nobody')).toEqual([]);
      expect(after.entity.entryCount).toBe(3);
    });

    it('rebuilds the graph index: lineage and covers edges', async () => {
      const [before, after] = await dropAndRebuild();
      const run = (indexes: DerivedIndexes) => [
        indexes.graph.query({ from: 'projection:s1' }),
        indexes.graph.query({ to: 'evidence:e1' }),
        indexes.graph.query({ to: 'evidence:doc1' }),
      ];
      expect(run(after)).toEqual(run(before));
      expect(before.graph.query({ from: 'projection:s1' })).toEqual([
        { from: 'projection:s1', to: 'projection:f2', kind: 'covers' },
        { from: 'projection:s1', to: 'evidence:e1', kind: 'lineage' },
      ]);
      expect(before.graph.query({ to: 'evidence:doc1' })).toEqual([
        { from: 'projection:c1', to: 'evidence:doc1', kind: 'lineage' },
      ]);
    });

    it('changes the fingerprint when a projection is added', async () => {
      const storage = makeBackend();
      await seed(storage);
      const before = await rebuild(storage);
      await storage.writeProjectionRevision(makeFact('f3', [e1]));
      const after = await rebuild(storage);
      expect(after.inputFingerprint).not.toBe(before.inputFingerprint);
      expect(after.lexical.entryCount).toBe(before.lexical.entryCount + 1);
    });
  });
}

describe('buildDerivedIndexes', () => {
  it('gives the same fingerprint whatever order its inputs arrive in', () => {
    const projections = [f1, f2, preference];
    const forward = buildDerivedIndexes({
      evidence: [e1],
      supersessions: new Map(),
      projections,
      authority: makeAuthority(),
    });
    const reversed = buildDerivedIndexes({
      evidence: [e1],
      supersessions: new Map(),
      projections: projections.toReversed(),
      authority: makeAuthority(),
    });
    expect(reversed.inputFingerprint).toBe(forward.inputFingerprint);
  });

  it('refuses to mix embedding models in one index', () => {
    const other = { ...f2, embedding: { model: 'another-model', vector: [0, 1, 0] } };
    expect(() =>
      buildDerivedIndexes({
        evidence: [e1],
        supersessions: new Map(),
        projections: [f1, other as EvidenceProjectionRecord],
        authority: makeAuthority(),
      }),
    ).toThrow(/mix embedding models/);
  });

  it('throws digest-mismatch when a projection disagrees with loaded evidence, whatever its status', () => {
    const revoked = {
      ...f1,
      revision: 2,
      status: 'revoked',
      transition: { kind: 'revoked', at: FIXED_AT, reasonCode: 'user-request' },
    } as EvidenceProjectionRecord;
    const drifted = makeAssetEvidence('e1', { bytes: 'bytes that changed' });
    expect(() =>
      buildDerivedIndexes({
        evidence: [drifted],
        supersessions: new Map(),
        projections: [revoked],
        authority: makeAuthority(),
      }),
    ).toThrow(MemoryEvidenceValidationError);
  });

  it('reads a stored evidence record whose bytes were corrupted as a digest mismatch', async () => {
    const underlying = new MemoryStorage();
    const storage = createWeftEvidenceProjectionStorage(underlying);
    await seed(storage);
    const key = createEvidenceProjectionKeys().evidence(TENANT, 'doc1');
    const stored = JSON.parse(new TextDecoder().decode((await underlying.get(key))!)) as Record<
      string,
      unknown
    >;
    stored['digest'] = digestOfText('bytes that were swapped under the key');
    await underlying.put(key, new TextEncoder().encode(JSON.stringify(stored)));
    const error = await rejectionOf(rebuild(storage));
    expect(error).toBeInstanceOf(MemoryEvidenceValidationError);
    expect((error as MemoryEvidenceValidationError).code).toBe('digest-mismatch');
    expect((error as MemoryEvidenceValidationError).record).toBe('projection');
  });
});

describe('tenant-qualified admission', () => {
  it("[item 2] does not admit another tenant's projection that shares an evidence id and digest", () => {
    const foreign = makeFact('f-foreign', [e1], { tenantId: OTHER_TENANT });
    const indexes = buildDerivedIndexes({
      evidence: [e1],
      supersessions: new Map(),
      projections: [foreign],
      authority: makeAuthority(),
    });
    expect(indexes.temporal.query({ asOf: FIXED_AT + 1 })).toEqual([]);
    expect(indexes.lexical.entryCount).toBe(0);
    expect(indexes.graph.entryCount).toBe(0);
  });

  it('[item 2] does not confuse same-id evidence of two tenants when checking digests', () => {
    const theirs = makeInlineEvidence('e1', { tenantId: OTHER_TENANT, text: 'Their text.' });
    const mine = makeFact('f-mine', [e1]);
    expect(() =>
      buildDerivedIndexes({
        evidence: [e1, theirs],
        supersessions: new Map(),
        projections: [mine],
        authority: makeAuthority(),
      }),
    ).not.toThrow();
  });
});

describe('embedding consistency', () => {
  it('[item 4] refuses embeddings of different lengths under one model', () => {
    const short = makeFact('short', [e1], { embedding: embedded([1, 0]) });
    let failure: unknown;
    try {
      buildDerivedIndexes({
        evidence: [e1],
        supersessions: new Map(),
        projections: [f1, short],
        authority: makeAuthority(),
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(EmbeddingMismatchError);
    expect((failure as EmbeddingMismatchError).reason).toBe('dimension');
  });

  it('[item 4] keeps refusing mixed models with the same typed error', () => {
    const other = makeFact('other', [e1], {
      embedding: { model: 'another-model', vector: [1, 0, 0] },
    });
    let failure: unknown;
    try {
      buildDerivedIndexes({
        evidence: [e1],
        supersessions: new Map(),
        projections: [f1, other],
        authority: makeAuthority(),
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(EmbeddingMismatchError);
    expect((failure as EmbeddingMismatchError).reason).toBe('model');
  });
});

describe('demotion', () => {
  const statement = { statement: 'Ana prefers green tea', entities: [] };
  const active = makeFact('b-active', [e1], { payload: statement, embedding: embedded([1, 0, 0]) });
  const demotedBase = makeFact('a-demoted', [e1], {
    payload: statement,
    embedding: embedded([1, 0, 0]),
  });
  const demoted = nextRevision(demotedBase, {
    status: 'demoted',
    transition: { kind: 'demoted', at: FIXED_AT + 5, demotedBy: { id: 's9', revision: 1 } },
  });
  const indexes = buildDerivedIndexes({
    evidence: [e1],
    supersessions: new Map(),
    projections: [demoted, active],
    authority: makeAuthority(),
  });

  it('[item 6] ranks a demoted projection below an equivalent active one in the lexical index', () => {
    const hits = indexes.lexical.query('green tea', { limit: 10 });
    expect(hits.map((hit) => hit.id)).toEqual(['b-active', 'a-demoted']);
    expect(hits[1]!.score).toBeLessThan(hits[0]!.score);
    expect(hits[1]!.score).toBeCloseTo(hits[0]!.score * DEMOTED_SCORE_WEIGHT, 10);
  });

  it('[item 6] ranks a demoted projection below an equivalent active one in the vector index', () => {
    const hits = indexes.vector.query([1, 0, 0], { limit: 10 });
    expect(hits.map((hit) => hit.id)).toEqual(['b-active', 'a-demoted']);
    expect(hits[1]!.score).toBeCloseTo(hits[0]!.score * DEMOTED_SCORE_WEIGHT, 10);
  });

  it('[item 6] applies the threshold to the weighted score', () => {
    const hits = indexes.vector.query([1, 0, 0], { limit: 10, threshold: 0.9 });
    expect(hits.map((hit) => hit.id)).toEqual(['b-active']);
  });

  it('[item 6] keeps the order of a negative score when it is weighted', () => {
    const opposed = buildDerivedIndexes({
      evidence: [e1],
      supersessions: new Map(),
      projections: [
        makeFact('b-active', [e1], { embedding: embedded([-1, 0, 0]) }),
        nextRevision(makeFact('a-demoted', [e1], { embedding: embedded([-1, 0, 0]) }), {
          status: 'demoted',
          transition: { kind: 'demoted', at: FIXED_AT + 5, demotedBy: { id: 's9', revision: 1 } },
        }),
      ],
      authority: makeAuthority(),
    });
    expect(opposed.vector.query([1, 0, 0], { limit: 10 }).map((hit) => hit.id)).toEqual([
      'b-active',
      'a-demoted',
    ]);
  });

  it('[item 5] records a demotion as a demotion edge, never as a supersession', () => {
    expect(indexes.graph.query({ from: 'projection:a-demoted' })).toContainEqual({
      from: 'projection:a-demoted',
      to: 'projection:s9',
      kind: 'projection-demotion',
    });
    const kinds = indexes.graph.query({ from: 'projection:a-demoted' }).map((edge) => edge.kind);
    expect(kinds).not.toContain('projection-supersession');
  });
});

describe('fingerprint inputs', () => {
  it("[item 21] changes with a projection's status alone", () => {
    const build = (status: 'active' | 'demoted') =>
      buildDerivedIndexes({
        evidence: [e1],
        supersessions: new Map(),
        // The status is the only field that differs; the builder does not re-validate records.
        projections: [{ ...f1, status }],
        authority: makeAuthority(),
      }).inputFingerprint;
    expect(build('demoted')).not.toBe(build('active'));
  });
});

describe('one consistent read', () => {
  const original = makeInlineEvidence('e1', { text: 'The user lives in Boston.' });
  const correction = makeInlineEvidence('e2', {
    text: 'The user lives in Denver.',
    kind: 'operator',
    supersedes: ['e1'],
  });
  const stale = makeFact('p1', [original], {
    payload: { statement: 'The user lives in Boston.', entities: ['Boston'] },
  });
  const corrected = makeFact('p2', [correction], {
    transition: { kind: 'created', at: FIXED_AT + 10, supersedes: [{ id: 'p1', revision: 1 }] },
    payload: { statement: 'The user lives in Denver.', entities: ['Denver'] },
  });

  /**
   * Wraps a store so `inject` runs once the evidence read has returned, and the
   * marker and projection reads wait for it: the three reads straddle it.
   */
  function straddling(
    inner: EvidenceProjectionStorage,
    inject: () => Promise<void>,
  ): EvidenceProjectionStorage {
    let release!: () => void;
    const injected = new Promise<void>((resolve) => {
      release = resolve;
    });
    let fired = false;
    return {
      ...inner,
      async listEvidence(filter) {
        const read = await inner.listEvidence(filter);
        if (!fired) {
          fired = true;
          await inject();
        }
        release();
        return read;
      },
      async listEvidenceSupersessions(filter) {
        await injected;
        return inner.listEvidenceSupersessions(filter);
      },
      async listProjections(filter) {
        await injected;
        return inner.listProjections(filter);
      },
    };
  }

  for (const [label, makeBackend] of BACKENDS) {
    it(`[item 7] does not drop both projections when a correction lands between the reads (${label})`, async () => {
      const inner = makeBackend();
      await inner.commit({ tenantId: TENANT, evidence: [original], projections: [stale] });
      const storage = straddling(inner, async () => {
        await inner.commit({
          tenantId: TENANT,
          evidence: [correction],
          projections: [corrected, supersededRevision(stale, { id: 'p2', revision: 1 })],
        });
      });
      const indexes = await rebuild(storage);
      expect(indexes.lexical.query('Denver', { limit: 5 }).map((hit) => hit.id)).toEqual(['p2']);
      expect(indexes.lexical.query('Boston', { limit: 5 })).toEqual([]);
    });
  }

  it('[item 7] gives up with a typed error when every read set differs from the last', async () => {
    const inner = createInMemoryEvidenceProjectionStorage();
    await inner.appendEvidence(original);
    let counter = 0;
    const churning: EvidenceProjectionStorage = {
      ...inner,
      async listEvidence(filter) {
        const read = await inner.listEvidence(filter);
        counter += 1;
        await inner.appendEvidence(makeInlineEvidence(`churn-${counter}`));
        return read;
      },
    };
    const error = await rejectionOf(rebuild(churning));
    expect(error).toBeInstanceOf(DerivedIndexConsistencyError);
    expect((error as DerivedIndexConsistencyError).attempts).toBe(3);
  });
});
