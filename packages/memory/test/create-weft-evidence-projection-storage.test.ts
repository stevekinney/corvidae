import {
  encodeStorageKeyComponent,
  MAX_BATCH_OPERATIONS,
  MemoryStorage,
  WEFT_RESERVED_KEY_PREFIXES,
} from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import { createWeftEvidenceProjectionStorage } from '../src/create-weft-evidence-projection-storage';
import { assertDisjointKeyPrefixes } from '../src/create-weft-evidence-projection-storage-helpers';
import { DEFAULT_MEMORY_KEY_PREFIX } from '../src/create-weft-memory-record-storage';
import { validateMemoryKeyPrefix } from '../src/create-weft-memory-record-storage-helpers';
import {
  buildDerivedIndexes,
  type DerivedIndexes,
  rebuildDerivedIndexes,
} from '../src/derived-indexes';
import {
  createEvidenceProjectionKeys,
  DEFAULT_EVIDENCE_KEY_PREFIX,
  DEFAULT_PROJECTION_KEY_PREFIX,
} from '../src/evidence-projection-keys';
import type { EvidenceProjectionRecord } from '../src/evidence-projection-schema';
import { MAX_COMMIT_BATCH_OPERATIONS } from '../src/evidence-projection-store-core';
import { digestOfText } from '../src/evidence-schema';
import { DEFAULT_MEMORY_GOVERNANCE_KEY_PREFIX } from '../src/governance/ledger';
import { DEFAULT_TRANSITION_KEY_PREFIX } from '../src/transition-receipt';
import {
  FIXED_AT,
  makeAssetEvidence,
  makeAuthority,
  makeFact,
  makeInlineEvidence,
  NAMESPACE,
  nextRevision,
  TENANT,
} from './evidence-projection-fixtures';

/**
 * Weft-backend-specific behavior. The generic contract runs against both
 * backends in `evidence-projection-storage-contract.test.ts`; this file covers
 * the key families, the restart, and ownership of the underlying storage.
 */

const FAMILIES = [DEFAULT_EVIDENCE_KEY_PREFIX, DEFAULT_PROJECTION_KEY_PREFIX] as const;

describe('key families', () => {
  it('keeps the three memory prefixes pairwise disjoint in both directions', () => {
    const prefixes = [
      DEFAULT_EVIDENCE_KEY_PREFIX,
      DEFAULT_PROJECTION_KEY_PREFIX,
      DEFAULT_MEMORY_KEY_PREFIX,
    ];
    for (const prefix of prefixes) {
      for (const other of prefixes) {
        if (prefix !== other) expect(prefix.startsWith(other)).toBe(false);
      }
    }
  });

  it('keeps both families disjoint from every reserved Weft prefix in both directions', () => {
    for (const family of FAMILIES) {
      for (const reserved of WEFT_RESERVED_KEY_PREFIXES) {
        expect(family.startsWith(reserved)).toBe(false);
        expect(reserved.startsWith(family)).toBe(false);
      }
    }
  });

  it('keeps the transition receipt family disjoint from the four other memory families and from Weft', () => {
    const memoryPrefixes = [
      DEFAULT_EVIDENCE_KEY_PREFIX,
      DEFAULT_PROJECTION_KEY_PREFIX,
      DEFAULT_MEMORY_KEY_PREFIX,
      DEFAULT_MEMORY_GOVERNANCE_KEY_PREFIX,
      DEFAULT_TRANSITION_KEY_PREFIX,
    ];
    expect(() => assertDisjointKeyPrefixes(memoryPrefixes)).not.toThrow();
    expect(() => validateMemoryKeyPrefix(DEFAULT_TRANSITION_KEY_PREFIX)).not.toThrow();
    for (const reserved of WEFT_RESERVED_KEY_PREFIXES) {
      expect(DEFAULT_TRANSITION_KEY_PREFIX.startsWith(reserved)).toBe(false);
      expect(reserved.startsWith(DEFAULT_TRANSITION_KEY_PREFIX)).toBe(false);
    }
  });

  it('asserts disjointness itself, rejecting a colliding pair', () => {
    expect(() => assertDisjointKeyPrefixes(['app:a:', 'app:a:b:'])).toThrow(/not disjoint/);
    expect(() => assertDisjointKeyPrefixes(['app:a:b:', 'app:a:'])).toThrow(/not disjoint/);
    expect(() => assertDisjointKeyPrefixes(['app:a:', ''])).toThrow(/non-empty/);
    expect(() => assertDisjointKeyPrefixes([...FAMILIES, DEFAULT_MEMORY_KEY_PREFIX])).not.toThrow();
  });

  it('rejects custom prefixes that collide with each other, the record store, or Weft', () => {
    const storage = new MemoryStorage();
    expect(() =>
      createWeftEvidenceProjectionStorage(storage, {
        evidenceKeyPrefix: 'app:x:',
        projectionKeyPrefix: 'app:x:projection:',
      }),
    ).toThrow(/not disjoint/);
    expect(() =>
      createWeftEvidenceProjectionStorage(storage, {
        evidenceKeyPrefix: DEFAULT_MEMORY_KEY_PREFIX,
      }),
    ).toThrow(/not disjoint/);
    expect(() =>
      createWeftEvidenceProjectionStorage(storage, { evidenceKeyPrefix: 'wf:evidence:' }),
    ).toThrow(/reserved Weft prefix/);
  });

  it('writes every key under one of the two families and none under another prefix', async () => {
    const underlying = new MemoryStorage();
    const storage = createWeftEvidenceProjectionStorage(underlying);
    const e1 = makeInlineEvidence('e1');
    const e2 = makeInlineEvidence('e2', { supersedes: ['e1'] });
    await storage.commit({
      tenantId: TENANT,
      evidence: [e1],
      projections: [makeFact('p1', [e1])],
    });
    await storage.commit({ tenantId: TENANT, evidence: [e2] });

    const keys = [...underlying.snapshot().keys()];
    // e1, e2, marker for e1, current + history of p1.
    expect(keys).toHaveLength(5);
    for (const key of keys) {
      expect(FAMILIES.some((family) => key.startsWith(family))).toBe(true);
      expect(key.startsWith(DEFAULT_MEMORY_KEY_PREFIX)).toBe(false);
      expect(WEFT_RESERVED_KEY_PREFIXES.some((reserved) => key.startsWith(reserved))).toBe(false);
    }
  });

  it('honors custom prefixes', async () => {
    const underlying = new MemoryStorage();
    const storage = createWeftEvidenceProjectionStorage(underlying, {
      evidenceKeyPrefix: 'app:custom:evidence:',
      projectionKeyPrefix: 'app:custom:projection:',
    });
    await storage.appendEvidence(makeInlineEvidence('e1'));
    expect(
      [...underlying.snapshot().keys()].every((key) => key.startsWith('app:custom:evidence:')),
    ).toBe(true);
  });

  it('[item 13] percent-encodes a tenant so one holding the key delimiters cannot reach another', async () => {
    const underlying = new MemoryStorage();
    const storage = createWeftEvidenceProjectionStorage(underlying);
    const hostile = makeInlineEvidence('w', { tenantId: `${TENANT}:e:z` });
    await storage.appendEvidence(hostile);
    expect(await storage.getEvidence(`${TENANT}:e:z`, 'w')).toEqual(hostile);
    expect(await storage.getEvidence(TENANT, 'z')).toBeUndefined();
    expect(await storage.listEvidence({ tenantId: TENANT })).toEqual([]);
    expect(await storage.listEvidenceSupersessions({ tenantId: TENANT })).toEqual(new Map());
  });

  it('[item 10] builds keys exactly as Weft encodes a storage key component', () => {
    const keys = createEvidenceProjectionKeys();
    const hostile = 'a:b/c d%e?f#g\u00e9\u{1f600}';
    const tenant = `${TENANT}:e:z`;
    expect(keys.evidence(tenant, hostile)).toBe(
      `${DEFAULT_EVIDENCE_KEY_PREFIX}t:${encodeStorageKeyComponent(tenant)}:e:${encodeStorageKeyComponent(hostile)}`,
    );
    expect(keys.supersession(tenant, hostile)).toBe(
      `${DEFAULT_EVIDENCE_KEY_PREFIX}t:${encodeStorageKeyComponent(tenant)}:x:${encodeStorageKeyComponent(hostile)}`,
    );
    expect(keys.current(tenant, hostile, hostile)).toBe(
      `${DEFAULT_PROJECTION_KEY_PREFIX}t:${encodeStorageKeyComponent(tenant)}:n:${encodeStorageKeyComponent(hostile)}:c:${encodeStorageKeyComponent(hostile)}`,
    );
    expect(keys.history(tenant, hostile, hostile, 3)).toBe(
      `${DEFAULT_PROJECTION_KEY_PREFIX}t:${encodeStorageKeyComponent(tenant)}:n:${encodeStorageKeyComponent(hostile)}:h:${encodeStorageKeyComponent(hostile)}:0000000003`,
    );
  });

  it("[item 19] mirrors Weft's batch cap", () => {
    expect(MAX_COMMIT_BATCH_OPERATIONS).toBe(MAX_BATCH_OPERATIONS);
  });

  it('orders history numerically past revision 9', async () => {
    const storage = createWeftEvidenceProjectionStorage(new MemoryStorage());
    const e1 = makeInlineEvidence('e1');
    let current: EvidenceProjectionRecord = makeFact('p1', [e1]);
    await storage.commit({ tenantId: TENANT, evidence: [e1], projections: [current] });
    for (let revision = 2; revision <= 12; revision++) {
      current = nextRevision(current, {
        transition: { kind: 'rebuilt', at: FIXED_AT + revision, rebuiltFromRevision: revision - 1 },
      });
      await storage.writeProjectionRevision(current);
    }
    const history = await storage.listProjectionHistory(TENANT, NAMESPACE, 'p1');
    expect(history.map((record) => record.revision)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
    expect(createEvidenceProjectionKeys().history(TENANT, NAMESPACE, 'p1', 10)).toMatch(
      /:h:p1:0000000010$/,
    );
  });
});

describe('restart over the same storage', () => {
  function snapshot(indexes: DerivedIndexes) {
    return {
      fingerprint: indexes.inputFingerprint,
      counts: [
        indexes.lexical.entryCount,
        indexes.vector.entryCount,
        indexes.temporal.entryCount,
        indexes.entity.entryCount,
        indexes.graph.entryCount,
      ],
      lexical: indexes.lexical.query('tea', { limit: 10 }),
      vector: indexes.vector.query([1, 0], { limit: 10 }),
      temporal: indexes.temporal.query({ asOf: FIXED_AT + 5 }),
      entity: indexes.entity.query('Ana'),
      graph: indexes.graph.query({ to: 'evidence:doc1' }),
    };
  }

  it('rebuilds from a fresh handle exactly the indexes the first handle produced', async () => {
    const underlying = new MemoryStorage();
    const first = createWeftEvidenceProjectionStorage(underlying);
    const asset = makeAssetEvidence('doc1');
    const e1 = makeInlineEvidence('e1', { text: 'Ana prefers green tea.' });
    const chunk = {
      ...makeFact('c1', [asset]),
      kind: 'chunk',
      payload: {
        text: 'A chunk of tea notes.',
        ordinal: 0,
        startLine: 0,
        endLine: 0,
        steps: [
          {
            step: 'chunk',
            producer: { kind: 'service', id: 'chunker' },
            inputDigest: asset.digest,
            outputDigest: digestOfText('A chunk of tea notes.'),
          },
        ],
      },
    } as EvidenceProjectionRecord;
    await first.commit({
      tenantId: TENANT,
      evidence: [e1, asset],
      projections: [
        makeFact('f1', [e1], {
          payload: { statement: 'Ana prefers green tea', entities: ['Ana'] },
          embedding: { model: 'm', vector: [1, 0] },
        }),
        chunk,
      ],
    });
    const options = { tenantId: TENANT, namespace: NAMESPACE, authority: makeAuthority() };
    const before = snapshot(await rebuildDerivedIndexes({ storage: first, ...options }));
    await first.close();

    const second = createWeftEvidenceProjectionStorage(underlying);
    await second.init();
    const after = snapshot(await rebuildDerivedIndexes({ storage: second, ...options }));

    expect(after).toEqual(before);
    expect(before.counts.every((count) => count > 0)).toBe(true);
    expect(before.lexical.map((hit) => hit.id).toSorted()).toEqual(['c1', 'f1']);
    expect(await second.getEvidence(TENANT, 'e1')).toBeDefined();
    expect(await second.listProjectionHistory(TENANT, NAMESPACE, 'f1')).toHaveLength(1);
  });

  it('keeps authorized projections and source lineage identical across a restart', async () => {
    const underlying = new MemoryStorage();
    const first = createWeftEvidenceProjectionStorage(underlying);
    const e1 = makeInlineEvidence('e1');
    const fact = makeFact('f1', [e1]);
    await first.commit({ tenantId: TENANT, evidence: [e1], projections: [fact] });
    const second = createWeftEvidenceProjectionStorage(underlying);
    const listed = await second.listProjections({ tenantId: TENANT, namespace: NAMESPACE });
    expect(listed).toEqual([fact]);
    expect(listed[0]?.sources).toEqual([{ evidenceId: 'e1', digest: e1.digest }]);
    const direct = buildDerivedIndexes({
      evidence: await second.listEvidence({ tenantId: TENANT, includeSuperseded: true }),
      supersessions: await second.listEvidenceSupersessions({ tenantId: TENANT }),
      projections: listed,
      authority: makeAuthority(),
    });
    expect(direct.graph.query({ from: 'projection:f1' })).toEqual([
      { from: 'projection:f1', to: 'evidence:e1', kind: 'lineage' },
    ]);
  });
});

describe('ownership of the underlying storage', () => {
  it('does not dispose shared storage by default', async () => {
    const underlying = new MemoryStorage();
    const storage = createWeftEvidenceProjectionStorage(underlying);
    await storage.appendEvidence(makeInlineEvidence('e1'));
    await storage.close();
    expect(underlying.size).toBeGreaterThan(0);
  });

  it('disposes shared storage when configured to own it', async () => {
    const underlying = new MemoryStorage();
    const storage = createWeftEvidenceProjectionStorage(underlying, {
      disposeUnderlyingStorage: true,
    });
    await storage.appendEvidence(makeInlineEvidence('e1'));
    await storage.close();
    expect(underlying.size).toBe(0);
  });
});

describe('corrupt stored bytes are refused at the read boundary', () => {
  it('refuses a record stored under a key that disagrees with its id', async () => {
    const underlying = new MemoryStorage();
    const storage = createWeftEvidenceProjectionStorage(underlying);
    const e1 = makeInlineEvidence('e1');
    await storage.appendEvidence(e1);
    const keys = createEvidenceProjectionKeys();
    await underlying.put(
      keys.evidence(TENANT, 'e9'),
      (await underlying.get(keys.evidence(TENANT, 'e1')))!,
    );
    let failure: unknown;
    try {
      await storage.getEvidence(TENANT, 'e9');
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as { code?: string }).code).toBe('malformed');
  });
});
