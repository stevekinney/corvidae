import type { EvidenceProjectionRecord } from '../src/evidence-projection-schema';
import { digestOfText, type EvidenceRecord } from '../src/evidence-schema';
import { createMemoryAuthority, type MemoryAuthority } from '../src/governance/authority';

/** A fixed instant: tests stamp every record with it and never read the real clock. */
export const FIXED_AT = Date.parse('2026-01-01T00:00:00.000Z');
export const TENANT = 'tenant-a';
export const OTHER_TENANT = 'tenant-b';
export const OWNER = 'owner-1';
export const NAMESPACE = 'notes';

export function makeInlineEvidence(
  id: string,
  overrides: Partial<EvidenceRecord> & { text?: string } = {},
): EvidenceRecord {
  const { text = `Evidence text for ${id}.`, ...rest } = overrides;
  return {
    schemaVersion: 1,
    id,
    tenantId: TENANT,
    ownerId: OWNER,
    kind: 'conversation',
    sourceLocator: `run:run-1/message:${id}`,
    content: { kind: 'inline', text },
    digest: digestOfText(text),
    producer: { kind: 'agent', id: 'agent-1' },
    principal: { kind: 'user', id: 'user-1' },
    trustTier: 'untrusted',
    eventAt: FIXED_AT,
    observedAt: FIXED_AT + 1,
    writtenAt: FIXED_AT + 2,
    classification: 'internal',
    authorizationScope: { visibility: 'private', sharedWith: [] },
    retention: { kind: 'subject-deletable' },
    causation: { runId: 'run-1' },
    ...rest,
  };
}

export function makeAssetEvidence(
  id: string,
  overrides: Partial<EvidenceRecord> & { bytes?: string } = {},
): EvidenceRecord {
  const { bytes = `asset bytes for ${id}`, ...rest } = overrides;
  return {
    ...makeInlineEvidence(id),
    kind: 'ingested-document',
    sourceLocator: `asset:${id}`,
    content: { kind: 'managed-asset', assetId: `asset-${id}` },
    digest: digestOfText(bytes),
    ...rest,
  };
}

export function sourceOf(evidence: EvidenceRecord): { evidenceId: string; digest: string } {
  return { evidenceId: evidence.id, digest: evidence.digest };
}

/** A revision-1 `fact` projection resting on `sources`. */
export function makeFact(
  id: string,
  sources: readonly EvidenceRecord[],
  overrides: Record<string, unknown> = {},
): EvidenceProjectionRecord {
  return {
    schemaVersion: 1,
    id,
    tenantId: TENANT,
    namespace: NAMESPACE,
    kind: 'fact',
    revision: 1,
    projectorRevision: 'projector:1',
    policyRevision: 'policy:1',
    sources: sources.map(sourceOf),
    validity: { validFrom: FIXED_AT },
    confidence: 0.9,
    status: 'active',
    transition: { kind: 'created', at: FIXED_AT },
    payload: { statement: `Statement of ${id}.`, entities: [`entity-${id}`] },
    ...overrides,
  };
}

/** The next revision of `current`, with `changes` laid over it. */
export function nextRevision(
  current: EvidenceProjectionRecord,
  changes: Record<string, unknown>,
): EvidenceProjectionRecord {
  return { ...current, revision: current.revision + 1, ...changes };
}

export function supersededRevision(
  current: EvidenceProjectionRecord,
  successor: { id: string; revision: number },
): EvidenceProjectionRecord {
  return nextRevision(current, {
    status: 'superseded',
    transition: { kind: 'superseded', at: FIXED_AT + 10, supersededBy: successor },
  });
}

export function makeAuthority(
  options: {
    ownerId?: string;
    tenantId?: string;
    capabilities?: readonly ('memory:search' | 'memory:get')[];
  } = {},
): MemoryAuthority {
  const capabilities = options.capabilities ?? ['memory:search'];
  return createMemoryAuthority({
    principal: { kind: 'user', id: 'user-1' },
    tenantId: options.tenantId ?? TENANT,
    ownerId: options.ownerId ?? OWNER,
    purpose: 'test',
    capabilities,
    policyRevision: 'authorization:1',
    projection: 'bureau',
  });
}
