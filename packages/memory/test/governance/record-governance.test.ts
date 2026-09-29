import { sha256HexSync } from '@lostgradient/cryptography';
import { describe, expect, it } from 'bun:test';

import { createMemoryAuthority } from '../../src/governance/authority';
import {
  MEMORY_GOVERNANCE_METADATA_KEY,
  type RecordGovernance,
  attributionFor,
  collectionNamespace,
  describeResource,
  projectRecord,
  readRecordGovernance,
  withoutReservedMetadata,
} from '../../src/governance/record-governance';
import type { MemoryRecord } from '../../src/memory-record-storage';

const authority = createMemoryAuthority({
  principal: { kind: 'run', id: 'run-1' },
  tenantId: 'tenant-a',
  ownerId: 'owner:a',
  purpose: 'conversation-memory',
  capabilities: ['memory:write'],
  policyRevision: 'authorization:1',
  projection: 'bureau',
});

const attribution = attributionFor(authority, {
  governanceRevision: 'governance:1',
  operationId: 'op-1',
  at: 100,
});

function governanceFor(content: string, overrides: Partial<RecordGovernance> = {}) {
  return {
    version: 1,
    tenantId: 'tenant-a',
    ownerId: 'owner:a',
    collection: 'session/1',
    visibility: 'private',
    memoryClass: 'episodic',
    source: 'conversation',
    trust: 'untrusted',
    state: 'active',
    legalHold: 'none',
    sharedWith: [],
    contentDigest: sha256HexSync(content),
    eventAt: 100,
    retrievalWeight: 1,
    indexInvalidated: false,
    attribution,
    ...overrides,
  } satisfies RecordGovernance;
}

function recordWith(content: string, governance: unknown, overrides: Partial<MemoryRecord> = {}) {
  return {
    id: 'record-1',
    tenantId: 'tenant-a',
    namespace: collectionNamespace('private', 'owner:a', 'session/1'),
    content,
    vector: new Float32Array([1, 0]),
    metadata: { tags: ['x'], [MEMORY_GOVERNANCE_METADATA_KEY]: governance },
    createdAt: 100,
    updatedAt: 100,
    version: 1,
    status: 'active',
    ...overrides,
  } satisfies MemoryRecord;
}

describe('collectionNamespace', () => {
  it('derives an owner-partitioned private namespace no collection string can escape', () => {
    expect(collectionNamespace('private', 'owner:a', 'session/1')).toBe(
      'private:owner%3Aa:session%2F1',
    );
    // A collection that imitates another owner's partition stays inside this owner's.
    expect(collectionNamespace('private', 'owner-a', 'x:private:owner-b')).toBe(
      'private:owner-a:x%3Aprivate%3Aowner-b',
    );
    expect(collectionNamespace('shared', 'ignored', 'team')).toBe('shared:team');
  });
});

describe('attributionFor', () => {
  it('persists principal, tenant, owner, purpose, capabilities, chain, and both revisions', () => {
    expect(attribution).toEqual({
      principal: { kind: 'run', id: 'run-1' },
      tenantId: 'tenant-a',
      ownerId: 'owner:a',
      purpose: 'conversation-memory',
      capabilities: ['memory:write'],
      delegationChain: [
        { principal: { kind: 'run', id: 'run-1' }, capabilities: ['memory:write'] },
      ],
      policyRevision: 'authorization:1',
      projection: 'bureau',
      governanceRevision: 'governance:1',
      operationId: 'op-1',
      at: 100,
    });
  });
});

describe('readRecordGovernance', () => {
  it('reads an intact envelope', () => {
    const governance = governanceFor('a fact');
    const read = readRecordGovernance(recordWith('a fact', governance));
    expect(read).toEqual({ governance, integrity: 'intact' });
  });

  it('marks content that no longer matches its admission digest as tampered', () => {
    const read = readRecordGovernance(recordWith('edited', governanceFor('a fact')));
    expect(read?.integrity).toBe('tampered');
  });

  it.each([
    ['a missing envelope', recordWith('a fact', undefined)],
    ['a malformed envelope', recordWith('a fact', { version: 1 })],
    ['a tenant mismatch', recordWith('a fact', governanceFor('a fact'), { tenantId: 'tenant-b' })],
    [
      'a pending-derivation marker that is not `true`',
      recordWith('a fact', governanceFor('a fact', { pendingDerivation: false as never })),
    ],
    [
      'a namespace outside the owner partition',
      recordWith('a fact', governanceFor('a fact'), { namespace: 'private:owner-b:session%2F1' }),
    ],
  ])('treats %s as ungoverned', (_label, record) => {
    expect(readRecordGovernance(record)).toBeUndefined();
  });
});

describe('describeResource', () => {
  it('lifts the access-deciding facts out of the envelope', () => {
    const governance = governanceFor('a fact', { sharedWith: ['owner-b'], state: 'quarantined' });
    expect(describeResource({ governance, integrity: 'intact' })).toEqual({
      tenantId: 'tenant-a',
      ownerId: 'owner:a',
      visibility: 'private',
      state: 'quarantined',
      sharedWith: ['owner-b'],
      integrity: 'intact',
      pendingDerivation: false,
    });
  });

  it('marks a derived record still awaiting its source check as pending', () => {
    const governance = governanceFor('a fact', {
      lineage: { kind: 'summary', sources: [{ id: 'record-0', namespace: 'private:owner%3Aa:x' }] },
      pendingDerivation: true,
    });
    expect(readRecordGovernance(recordWith('a fact', governance))?.governance).toEqual(governance);
    expect(describeResource({ governance, integrity: 'intact' }).pendingDerivation).toBe(true);
  });
});

describe('projectRecord and withoutReservedMetadata', () => {
  const governance = governanceFor('a fact');
  const record = recordWith('a fact', governance);

  it('strips governance metadata under standard redaction', () => {
    const projected = projectRecord(record, { governance, integrity: 'intact' }, 'standard');
    expect(projected).toEqual({
      id: 'record-1',
      content: 'a fact',
      collection: 'session/1',
      visibility: 'private',
      memoryClass: 'episodic',
      source: 'conversation',
      trust: 'untrusted',
      metadata: { tags: ['x'] },
      createdAt: 100,
    });
  });

  it('returns the full envelope under privileged redaction', () => {
    const projected = projectRecord(record, { governance, integrity: 'intact' }, 'privileged');
    expect(projected.governance).toEqual(governance);
    expect(projected.integrity).toBe('intact');
  });

  it('removes caller-supplied reserved keys from write metadata', () => {
    expect(
      withoutReservedMetadata({ tags: ['y'], [MEMORY_GOVERNANCE_METADATA_KEY]: { forged: true } }),
    ).toEqual({ tags: ['y'] });
  });
});
