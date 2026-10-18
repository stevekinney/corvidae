import { sha256HexSync } from '@lostgradient/cryptography';
import { describe, expect, it } from 'bun:test';

import {
  decodeEvidenceRecord,
  decodeEvidenceSupersession,
  encodeEvidenceRecord,
  EVIDENCE_KINDS,
  MemoryEvidenceValidationError,
  type MemoryEvidenceRejectionCode,
} from '../src/evidence-schema';

const TENANT = 'tenant-a';

function digestOf(text: string): string {
  return `sha256:${sha256HexSync(text)}`;
}

/** A well-formed inline evidence record, as the wire shape `decodeEvidenceRecord` receives. */
function validEvidence(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const text = 'The user prefers metric units.';
  return {
    schemaVersion: 1,
    id: 'evidence-1',
    tenantId: TENANT,
    ownerId: 'owner-1',
    kind: 'conversation',
    sourceLocator: 'run:run-1/message:3',
    content: { kind: 'inline', text },
    digest: digestOf(text),
    producer: { kind: 'agent', id: 'agent-1' },
    principal: { kind: 'user', id: 'user-1' },
    trustTier: 'untrusted',
    eventAt: 1_700_000_000_000,
    observedAt: 1_700_000_000_100,
    writtenAt: 1_700_000_000_200,
    classification: 'internal',
    authorizationScope: { visibility: 'private', sharedWith: [] },
    retention: { kind: 'subject-deletable' },
    causation: { runId: 'run-1' },
    ...overrides,
  };
}

function rejectionCodeOf(raw: unknown): MemoryEvidenceRejectionCode {
  try {
    decodeEvidenceRecord(raw, { tenantId: TENANT });
  } catch (error) {
    if (error instanceof MemoryEvidenceValidationError) return error.code;
    throw error;
  }
  throw new Error('Expected decodeEvidenceRecord to reject, but it accepted the record.');
}

describe('evidence schema rejection', () => {
  it('accepts a well-formed record', () => {
    const record = decodeEvidenceRecord(validEvidence(), { tenantId: TENANT });
    expect(record.id).toBe('evidence-1');
    expect(record.tenantId).toBe(TENANT);
  });

  it('rejects a malformed record before it reaches an index', () => {
    expect(rejectionCodeOf(validEvidence({ trustTier: 'trusted-ish' }))).toBe('malformed');
    expect(rejectionCodeOf(validEvidence({ writtenAt: 'yesterday' }))).toBe('malformed');
    expect(rejectionCodeOf('not an object')).toBe('malformed');
  });

  it('rejects a record that belongs to another tenant', () => {
    expect(rejectionCodeOf(validEvidence({ tenantId: 'tenant-b' }))).toBe('cross-tenant');
  });

  it('rejects a source-less record', () => {
    expect(rejectionCodeOf(validEvidence({ sourceLocator: '' }))).toBe('source-less');
    const withoutLocator = validEvidence();
    delete withoutLocator['sourceLocator'];
    expect(rejectionCodeOf(withoutLocator)).toBe('source-less');
  });

  it('rejects inline content whose digest does not match its bytes', () => {
    expect(rejectionCodeOf(validEvidence({ digest: digestOf('different content') }))).toBe(
      'digest-mismatch',
    );
  });

  it('rejects a record written under an unsupported schema revision', () => {
    expect(rejectionCodeOf(validEvidence({ schemaVersion: 2 }))).toBe('unsupported-revision');
    expect(rejectionCodeOf(validEvidence({ schemaVersion: 0 }))).toBe('unsupported-revision');
  });
});

describe('evidence schema shape', () => {
  it('rejects an unknown top-level or nested key as malformed', () => {
    expect(rejectionCodeOf(validEvidence({ surprise: true }))).toBe('malformed');
    expect(
      rejectionCodeOf(
        validEvidence({ authorizationScope: { visibility: 'private', sharedWith: [], extra: 1 } }),
      ),
    ).toBe('malformed');
    expect(rejectionCodeOf(validEvidence({ producer: { kind: 'agent', id: 'a', extra: 1 } }))).toBe(
      'malformed',
    );
  });

  it('keeps derived content out of evidence', () => {
    expect(EVIDENCE_KINDS).not.toContain('derived');
    expect(rejectionCodeOf(validEvidence({ kind: 'derived' }))).toBe('malformed');
  });

  it('requires a causation object, when present, to name at least one identifier', () => {
    expect(rejectionCodeOf(validEvidence({ causation: {} }))).toBe('malformed');
    const without = validEvidence();
    delete without['causation'];
    expect(decodeEvidenceRecord(without, { tenantId: TENANT }).causation).toBeUndefined();
    const full = validEvidence({
      causation: { runId: 'r', sessionId: 's', toolCallId: 't', externalCommandId: 'c' },
    });
    expect(decodeEvidenceRecord(full, { tenantId: TENANT }).causation?.externalCommandId).toBe('c');
  });

  it('rejects a supersedes list that repeats an id or names the record itself', () => {
    expect(rejectionCodeOf(validEvidence({ supersedes: ['a', 'a'] }))).toBe('malformed');
    expect(rejectionCodeOf(validEvidence({ supersedes: ['evidence-1'] }))).toBe('malformed');
    expect(rejectionCodeOf(validEvidence({ supersedes: [] }))).toBe('malformed');
    expect(
      decodeEvidenceRecord(validEvidence({ supersedes: ['evidence-0'] }), { tenantId: TENANT })
        .supersedes,
    ).toEqual(['evidence-0']);
  });

  it('checks only the format of a managed asset digest, never its bytes', () => {
    const asset = validEvidence({
      kind: 'ingested-document',
      content: { kind: 'managed-asset', assetId: 'asset-1', revision: 2 },
      digest: digestOf('bytes memory never sees'),
    });
    expect(decodeEvidenceRecord(asset, { tenantId: TENANT }).content).toEqual({
      kind: 'managed-asset',
      assetId: 'asset-1',
      revision: 2,
    });
    expect(rejectionCodeOf({ ...asset, digest: 'sha256:abc' })).toBe('malformed');
    expect(rejectionCodeOf({ ...asset, digest: 'a'.repeat(64) })).toBe('malformed');
  });

  it('refuses empty inline content and an inline digest without the prefix', () => {
    expect(rejectionCodeOf(validEvidence({ content: { kind: 'inline', text: '' } }))).toBe(
      'malformed',
    );
    const text = 'The user prefers metric units.';
    expect(rejectionCodeOf(validEvidence({ digest: sha256HexSync(text) }))).toBe('malformed');
  });

  it('names source-less ahead of other failures in the same record', () => {
    expect(rejectionCodeOf(validEvidence({ sourceLocator: '', trustTier: 'bogus' }))).toBe(
      'source-less',
    );
  });

  it('checks the schema version before it parses, and requires one', () => {
    expect(rejectionCodeOf(validEvidence({ schemaVersion: 2, brandNewField: true }))).toBe(
      'unsupported-revision',
    );
    const without = validEvidence();
    delete without['schemaVersion'];
    expect(rejectionCodeOf(without)).toBe('malformed');
  });

  it('encodes the same record to the same bytes whatever the key order', () => {
    const record = decodeEvidenceRecord(validEvidence(), { tenantId: TENANT });
    const reordered = Object.fromEntries(Object.entries(record).toReversed());
    const again = decodeEvidenceRecord(reordered, { tenantId: TENANT });
    expect(encodeEvidenceRecord(again)).toEqual(encodeEvidenceRecord(record));
  });

  it('decodes a supersession marker and rejects a later version', () => {
    expect(decodeEvidenceSupersession({ schemaVersion: 1, supersededBy: 'e2', at: 5 })).toEqual({
      schemaVersion: 1,
      supersededBy: 'e2',
      at: 5,
    });
    expect(() =>
      decodeEvidenceSupersession({ schemaVersion: 2, supersededBy: 'e2', at: 5 }),
    ).toThrow(MemoryEvidenceValidationError);
    expect(() =>
      decodeEvidenceSupersession({ schemaVersion: 1, supersededBy: 'e2', at: 5, x: 1 }),
    ).toThrow(MemoryEvidenceValidationError);
  });
});

describe('evidence encoder parses its input', () => {
  it('[item 16] refuses an invalid record instead of writing it', () => {
    const record = decodeEvidenceRecord(validEvidence(), { tenantId: TENANT });
    expect(() => encodeEvidenceRecord({ ...record, trustTier: 'bogus' } as never)).toThrow();
    expect(() => encodeEvidenceRecord({ ...record, extra: 1 } as never)).toThrow();
  });

  it('[item 16] encodes a caller object with reordered keys to the canonical bytes', () => {
    const record = decodeEvidenceRecord(validEvidence(), { tenantId: TENANT });
    const reordered = Object.fromEntries(Object.entries(record).toReversed()) as typeof record;
    expect(encodeEvidenceRecord(reordered)).toEqual(encodeEvidenceRecord(record));
  });
});
