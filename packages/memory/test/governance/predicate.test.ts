import { describe, expect, it } from 'bun:test';

import {
  MEMORY_OPERATIONS,
  MEMORY_PROJECTIONS,
  type MemoryAuthority,
  type MemoryCapability,
  type MemoryPrincipalKind,
  attenuateMemoryAuthority,
  createMemoryAuthority,
} from '../../src/governance/authority';
import { type MemoryResourceDescriptor, decideMemoryAccess } from '../../src/governance/predicate';

const ALL_OPERATION_CAPABILITIES = MEMORY_OPERATIONS.map(
  (operation): MemoryCapability => `memory:${operation}`,
);

function authorityFor(
  overrides: {
    ownerId?: string;
    tenantId?: string;
    kind?: MemoryPrincipalKind;
    capabilities?: readonly MemoryCapability[];
    projection?: (typeof MEMORY_PROJECTIONS)[number];
  } = {},
): MemoryAuthority {
  return createMemoryAuthority({
    principal: {
      kind: overrides.kind ?? 'user',
      id: `${overrides.ownerId ?? 'owner-a'}-principal`,
    },
    tenantId: overrides.tenantId ?? 'tenant-a',
    ownerId: overrides.ownerId ?? 'owner-a',
    purpose: 'test',
    capabilities: overrides.capabilities ?? ALL_OPERATION_CAPABILITIES,
    policyRevision: 'authorization:1',
    projection: overrides.projection ?? 'bureau',
  });
}

const privateRecord: MemoryResourceDescriptor = {
  tenantId: 'tenant-a',
  ownerId: 'owner-a',
  visibility: 'private',
  state: 'active',
  sharedWith: [],
  integrity: 'intact',
  pendingDerivation: false,
};

describe('decideMemoryAccess: one predicate for every projection', () => {
  const resources: readonly MemoryResourceDescriptor[] = [
    privateRecord,
    { ...privateRecord, ownerId: 'owner-b' },
    { ...privateRecord, tenantId: 'tenant-b' },
    { ...privateRecord, visibility: 'shared' },
    { ...privateRecord, state: 'quarantined' },
    { ...privateRecord, state: 'revoked' },
    { ...privateRecord, ownerId: 'owner-b', sharedWith: ['owner-a'] },
    { ...privateRecord, integrity: 'tampered' },
    { ...privateRecord, visibility: 'shared', pendingDerivation: true },
  ];

  it('returns the identical decision and redaction for every projection', () => {
    for (const resource of resources) {
      for (const operation of MEMORY_OPERATIONS) {
        const decisions = MEMORY_PROJECTIONS.map((projection) =>
          decideMemoryAccess(authorityFor({ projection }), operation, resource),
        );
        for (const decision of decisions) expect(decision).toEqual(decisions[0]!);
      }
    }
  });
});

describe('decideMemoryAccess rules', () => {
  const owner = authorityFor();

  it('allows the owner every operation on an active private record with standard redaction', () => {
    for (const operation of MEMORY_OPERATIONS) {
      expect(decideMemoryAccess(owner, operation, privateRecord)).toEqual({
        allowed: true,
        redaction: 'standard',
      });
    }
  });

  it('requires the operation capability', () => {
    const reader = authorityFor({ capabilities: ['memory:search'] });
    expect(decideMemoryAccess(reader, 'search', privateRecord).allowed).toBe(true);
    expect(decideMemoryAccess(reader, 'get', privateRecord)).toEqual({
      allowed: false,
      reason: 'missing-capability',
    });
  });

  it('never crosses tenants, even for governance principals', () => {
    const governance = authorityFor({ kind: 'governance' });
    for (const operation of MEMORY_OPERATIONS) {
      expect(
        decideMemoryAccess(governance, operation, { ...privateRecord, tenantId: 'tenant-b' }),
      ).toEqual({ allowed: false, reason: 'tenant-mismatch' });
    }
  });

  it("denies another owner's private record for every operation", () => {
    const other = authorityFor({ ownerId: 'owner-b' });
    for (const operation of MEMORY_OPERATIONS) {
      expect(decideMemoryAccess(other, operation, privateRecord)).toEqual({
        allowed: false,
        reason: 'not-owner',
      });
    }
  });

  it('lets an explicit share grantee get, and only get, a private record', () => {
    const grantee = authorityFor({ ownerId: 'owner-b' });
    const shared = { ...privateRecord, sharedWith: ['owner-b'] };
    expect(decideMemoryAccess(grantee, 'get', shared).allowed).toBe(true);
    expect(decideMemoryAccess(grantee, 'search', shared).allowed).toBe(false);
    expect(decideMemoryAccess(grantee, 'delete', shared).allowed).toBe(false);
  });

  it('makes shared memory readable tenant-wide but never directly writable', () => {
    const shared = { ...privateRecord, visibility: 'shared' as const };
    const reader = authorityFor({ ownerId: 'owner-b' });
    for (const operation of ['list', 'get', 'search', 'export'] as const) {
      expect(decideMemoryAccess(reader, operation, shared).allowed).toBe(true);
    }
    expect(decideMemoryAccess(owner, 'write', shared)).toEqual({
      allowed: false,
      reason: 'shared-write-requires-promotion',
    });
    expect(decideMemoryAccess(owner, 'promote', shared)).toEqual({
      allowed: false,
      reason: 'not-private',
    });
    expect(decideMemoryAccess(owner, 'share', shared)).toEqual({
      allowed: false,
      reason: 'not-private',
    });
  });

  it('reserves revoking or deleting shared memory to its promoter or a governance principal', () => {
    const shared = { ...privateRecord, visibility: 'shared' as const };
    const reader = authorityFor({ ownerId: 'owner-b' });
    const governance = authorityFor({ ownerId: 'moderation', kind: 'governance' });
    for (const operation of ['quarantine', 'revoke', 'delete'] as const) {
      expect(decideMemoryAccess(reader, operation, shared)).toEqual({
        allowed: false,
        reason: 'not-owner',
      });
      expect(decideMemoryAccess(owner, operation, shared).allowed).toBe(true);
      expect(decideMemoryAccess(governance, operation, shared).allowed).toBe(true);
    }
  });

  it('grants the governance bypass from the delegation chain, never a self-declared actor kind', () => {
    const agent = attenuateMemoryAuthority(authorityFor({ ownerId: 'moderation' }), {
      principal: { kind: 'agent', id: 'moderation-bot' },
    });
    const principal = { kind: 'governance', id: 'self-appointed' } as const;
    const forged: MemoryAuthority = {
      ...agent,
      principal,
      delegationChain: [...agent.delegationChain, { principal, capabilities: agent.capabilities }],
    };
    for (const operation of ['quarantine', 'revoke', 'delete'] as const) {
      expect(decideMemoryAccess(forged, operation, privateRecord)).toEqual({
        allowed: false,
        reason: 'not-owner',
      });
    }
  });

  it('hides quarantined and revoked records from reads, promotion, and sharing', () => {
    for (const state of ['quarantined', 'revoked'] as const) {
      const record = { ...privateRecord, state };
      for (const operation of ['list', 'get', 'search', 'export', 'promote', 'share'] as const) {
        expect(decideMemoryAccess(owner, operation, record)).toEqual({
          allowed: false,
          reason: 'not-active',
        });
      }
      for (const operation of ['quarantine', 'revoke', 'delete'] as const) {
        expect(decideMemoryAccess(owner, operation, record).allowed).toBe(true);
      }
    }
  });

  it('grants privileged inspection of inactive records only with memory:inspect', () => {
    const inspector = authorityFor({ capabilities: ['memory:get', 'memory:inspect'] });
    expect(decideMemoryAccess(inspector, 'get', { ...privateRecord, state: 'revoked' })).toEqual({
      allowed: true,
      redaction: 'privileged',
    });
  });

  it('reads a derived record awaiting its source check as missing to everyone, privileged or not', () => {
    const inspector = authorityFor({
      kind: 'governance',
      capabilities: [...ALL_OPERATION_CAPABILITIES, 'memory:inspect'],
    });
    const reader = authorityFor({ ownerId: 'owner-b' });
    for (const resource of [
      { ...privateRecord, pendingDerivation: true },
      { ...privateRecord, visibility: 'shared' as const, pendingDerivation: true },
    ]) {
      for (const operation of MEMORY_OPERATIONS) {
        for (const principal of [owner, reader, inspector]) {
          expect(decideMemoryAccess(principal, operation, resource)).toEqual({
            allowed: false,
            reason: 'pending-derivation',
          });
        }
      }
    }
  });

  it('fails closed on tampered records unless the caller holds memory:inspect', () => {
    const tampered = { ...privateRecord, integrity: 'tampered' as const };
    expect(decideMemoryAccess(owner, 'get', tampered)).toEqual({
      allowed: false,
      reason: 'tampered',
    });
    const inspector = authorityFor({ capabilities: ['memory:delete', 'memory:inspect'] });
    expect(decideMemoryAccess(inspector, 'delete', tampered)).toEqual({
      allowed: true,
      redaction: 'privileged',
    });
  });
});
