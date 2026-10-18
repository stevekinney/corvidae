import { describe, expect, it } from 'bun:test';

import {
  type MemoryEvidenceRejectionCode,
  MemoryEvidenceValidationError,
} from '../src/evidence-schema';
import { transitionEventSchema } from '../src/transition-events';
import {
  createTransitionKeys,
  decodeTransitionReceipt,
  DEFAULT_TRANSITION_KEY_PREFIX,
  digestOfBytes,
  encodeTransitionReceipt,
  TRANSITION_RECEIPT_SCHEMA_VERSION,
  type TransitionReceipt,
} from '../src/transition-receipt';
import { TRANSITION_BACKENDS } from './transition-backends';
import { appendProposal, createHarness, expectCommitted, TENANT } from './transition-test-support';

const authority = appendProposal('operation-1').authority;
const digest = `sha256:${'a'.repeat(64)}`;

function receipt(overrides: Partial<TransitionReceipt> = {}): TransitionReceipt {
  return {
    schemaVersion: TRANSITION_RECEIPT_SCHEMA_VERSION,
    operationId: 'operation-1',
    tenantId: TENANT,
    kind: 'append-evidence',
    digest,
    authority,
    outcome: 'committed',
    requestedAt: 10,
    committedAt: 11,
    validation: { checks: ['authorization'], policyRevision: authority.policyRevision },
    evidence: [{ id: 'e1', digest, outcome: 'appended' }],
    projections: [],
    ...overrides,
  };
}

const decode = (value: unknown, tenantId: string = TENANT) =>
  decodeTransitionReceipt(value, { tenantId });

describe('transition receipt record', () => {
  it('round-trips through its canonical bytes', () => {
    const bytes = encodeTransitionReceipt(receipt());
    expect(decode(JSON.parse(new TextDecoder().decode(bytes)))).toEqual(receipt());
    expect(encodeTransitionReceipt(receipt())).toEqual(bytes);
  });

  it('refuses a receipt of another tenant as cross-tenant', () => {
    try {
      decode(receipt(), 'tenant-b');
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(MemoryEvidenceValidationError);
      expect((error as MemoryEvidenceValidationError).code).toBe('cross-tenant');
      expect((error as MemoryEvidenceValidationError).record).toBe('receipt');
    }
  });

  function withoutSchemaVersion(): unknown {
    const { schemaVersion: _schemaVersion, ...rest } = receipt();
    return rest;
  }

  const refused: ReadonlyArray<readonly [string, unknown, MemoryEvidenceRejectionCode]> = [
    ['another schema version', { ...receipt(), schemaVersion: 2 }, 'unsupported-revision'],
    ['no schema version', withoutSchemaVersion(), 'malformed'],
    ['an unknown key', { ...receipt(), summary: 'content' }, 'malformed'],
    ['an uncommitted outcome', { ...receipt(), outcome: 'rejected' }, 'malformed'],
    [
      'a consolidation on a non-consolidate receipt',
      {
        ...receipt(),
        consolidation: {
          candidates: [],
          outcome: 'supersede',
          projectorRevision: 'p',
          promptRevision: 'q',
          summary: { id: 's', revision: 1, recordDigest: digest, textDigest: digest },
          retired: [],
        },
      },
      'malformed',
    ],
    [
      "a validation policy that is not the authority's",
      {
        ...receipt(),
        validation: { checks: [], policyRevision: 'other' },
      },
      'malformed',
    ],
    ['a malformed digest', { ...receipt(), digest: 'sha256:short' }, 'malformed'],
    ['a non-object', 'receipt', 'malformed'],
  ];
  it.each(refused)('refuses %s', (_label, value, code) => {
    try {
      decode(value);
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(MemoryEvidenceValidationError);
      expect((error as MemoryEvidenceValidationError).code).toBe(code);
    }
  });

  it('digests canonical bytes with the evidence digest convention', () => {
    expect(digestOfBytes(new TextEncoder().encode('abc'))).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(digestOfBytes(new TextEncoder().encode('abc'))).not.toBe(
      digestOfBytes(new TextEncoder().encode('abd')),
    );
  });
});

describe('transition receipt keys', () => {
  const keys = createTransitionKeys();

  it('keys a receipt per tenant, then per operation id', () => {
    expect(keys.receipt('tenant-a', 'operation-1')).toBe(
      `${DEFAULT_TRANSITION_KEY_PREFIX}t:tenant-a:r:operation-1`,
    );
    expect(keys.receipt('tenant-a', 'operation-1').startsWith(keys.receiptScan('tenant-a'))).toBe(
      true,
    );
    expect(keys.receipt('tenant-b', 'operation-1').startsWith(keys.receiptScan('tenant-a'))).toBe(
      false,
    );
  });

  it('encodes separators so ids cannot collide across tenants or operations', () => {
    expect(keys.receipt('a:r:b', 'c')).not.toBe(keys.receipt('a', 'b:c'));
    const scan = keys.receiptScan('tenant a');
    expect(keys.operationIdOfKey(keys.receipt('tenant a', 'op/1:x'), scan)).toBe('op/1:x');
  });

  it('honors a custom prefix', () => {
    expect(createTransitionKeys('app:custom:').receipt('t', 'o')).toBe('app:custom:t:t:r:o');
  });
});

describe('transition event schema', () => {
  const base = {
    operationId: 'operation-1',
    tenantId: TENANT,
    proposalKind: 'append-evidence',
    principal: { kind: 'user', id: 'user-1' },
    ownerId: 'owner-1',
    at: 1,
  };

  it('refuses an event that carries any key it does not declare, which is how content would leak', () => {
    expect(transitionEventSchema.safeParse({ ...base, kind: 'canceled' }).success).toBe(true);
    expect(
      transitionEventSchema.safeParse({ ...base, kind: 'canceled', content: 'secret' }).success,
    ).toBe(false);
    expect(
      transitionEventSchema.safeParse({
        ...base,
        kind: 'requested',
        digest,
        sources: [{ kind: 'evidence', id: 'e1', digest, text: 'secret' }],
      }).success,
    ).toBe(false);
  });

  it('records a failure by name and code only', () => {
    expect(
      transitionEventSchema.safeParse({
        ...base,
        kind: 'failed',
        error: { name: 'Error', code: 'x', message: 'ids and more' },
      }).success,
    ).toBe(false);
  });
});

for (const [label, makeBackend] of TRANSITION_BACKENDS) {
  describe(`a committed receipt (${label})`, () => {
    it('is stored under the tenant-scoped key and decodes from storage bytes', async () => {
      const harness = createHarness(makeBackend);
      const { receipt: committed } = expectCommitted(
        await harness.engine.submit(appendProposal('operation-1')),
      );
      const bytes = await harness.storage.getReceipt(
        createTransitionKeys().receipt(TENANT, 'operation-1'),
      );
      expect(bytes).not.toBeNull();
      expect(decode(JSON.parse(new TextDecoder().decode(bytes!)))).toEqual(committed);
      expect(committed.evidence).toEqual([
        { id: 'e1', digest: committed.evidence[0]!.digest, outcome: 'appended' },
      ]);
      expect(committed.requestedAt).toBe(harness.clock.current);
      expect(committed.committedAt).toBe(harness.clock.current);
    });
  });
}
