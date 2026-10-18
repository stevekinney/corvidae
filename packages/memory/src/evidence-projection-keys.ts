import { MAX_PROJECTION_REVISION } from './evidence-projection-schema';

/**
 * Key families for evidence and projections. Neither imports Weft: both
 * backends share one layout, and the standalone in-memory backend keeps its
 * records under the same keys.
 *
 * Disjointness: the three memory prefixes (these two and the record store's
 * `app:agent-bureau:memory:v1:`) share `app:agent-bureau:memory`, then continue
 * `:v1:`, `-evidence:v1:`, and `-projection:v1:`. The next character differs at
 * the same index, so none is a prefix of another. Weft's reserved prefixes that
 * begin `app` continue with a letter (`appcmd:`, `appseq:`, and so on) where
 * these continue with `:`, and every other reserved prefix differs in its first
 * character.
 */
export const DEFAULT_EVIDENCE_KEY_PREFIX = 'app:agent-bureau:memory-evidence:v1:';
export const DEFAULT_PROJECTION_KEY_PREFIX = 'app:agent-bureau:memory-projection:v1:';

/** `encodeURIComponent` is what Weft's `encodeStorageKeyComponent` does: no `:` survives it. */
function component(value: string): string {
  return encodeURIComponent(value);
}

function decodeComponent(value: string): string {
  return decodeURIComponent(value);
}

/** The history key pads a revision to ten digits so a prefix scan returns revisions in order. */
export function padRevision(revision: number): string {
  if (!Number.isInteger(revision) || revision < 1 || revision > MAX_PROJECTION_REVISION) {
    throw new RangeError(
      `Projection revision ${revision} is outside 1..${MAX_PROJECTION_REVISION}.`,
    );
  }
  return String(revision).padStart(10, '0');
}

export interface EvidenceProjectionKeys {
  readonly evidencePrefix: string;
  readonly projectionPrefix: string;
  evidenceScan(tenantId: string): string;
  evidence(tenantId: string, id: string): string;
  supersessionScan(tenantId: string): string;
  supersession(tenantId: string, id: string): string;
  currentScan(tenantId: string, namespace: string): string;
  current(tenantId: string, namespace: string, id: string): string;
  historyScan(tenantId: string, namespace: string, id: string): string;
  history(tenantId: string, namespace: string, id: string, revision: number): string;
  /** The id a key under {@link evidenceScan} or {@link supersessionScan} names. */
  idOfEvidenceKey(key: string, scan: string): string;
  idOfCurrentKey(key: string, scan: string): string;
  revisionOfHistoryKey(key: string, scan: string): number;
}

export function createEvidenceProjectionKeys(
  evidencePrefix: string = DEFAULT_EVIDENCE_KEY_PREFIX,
  projectionPrefix: string = DEFAULT_PROJECTION_KEY_PREFIX,
): EvidenceProjectionKeys {
  const evidenceTenant = (tenantId: string): string => `${evidencePrefix}t:${component(tenantId)}:`;
  const projectionScope = (tenantId: string, namespace: string): string =>
    `${projectionPrefix}t:${component(tenantId)}:n:${component(namespace)}:`;
  return {
    evidencePrefix,
    projectionPrefix,
    evidenceScan: (tenantId) => `${evidenceTenant(tenantId)}e:`,
    evidence: (tenantId, id) => `${evidenceTenant(tenantId)}e:${component(id)}`,
    supersessionScan: (tenantId) => `${evidenceTenant(tenantId)}x:`,
    supersession: (tenantId, id) => `${evidenceTenant(tenantId)}x:${component(id)}`,
    currentScan: (tenantId, namespace) => `${projectionScope(tenantId, namespace)}c:`,
    current: (tenantId, namespace, id) =>
      `${projectionScope(tenantId, namespace)}c:${component(id)}`,
    historyScan: (tenantId, namespace, id) =>
      `${projectionScope(tenantId, namespace)}h:${component(id)}:`,
    history: (tenantId, namespace, id, revision) =>
      `${projectionScope(tenantId, namespace)}h:${component(id)}:${padRevision(revision)}`,
    idOfEvidenceKey: (key, scan) => decodeComponent(key.slice(scan.length)),
    idOfCurrentKey: (key, scan) => decodeComponent(key.slice(scan.length)),
    revisionOfHistoryKey: (key, scan) => Number.parseInt(key.slice(scan.length), 10),
  };
}
