/**
 * Engine ownership-lease health from `weft.system.lease` (`system:read`),
 * read by the System route's Health tab (COR-124). This is the
 * serving engine process's last-known lease state: `disabled` when lease
 * ownership is off, `no-lease` before it is held, `healthy` while held, and
 * `contested` once ownership is lost (with the confirmed `deposed` or
 * `renewal-unconfirmable` reason when Weft reports one).
 *
 * The response is validated here, at the dashboard's trust boundary, so a
 * drifted payload surfaces as an explicit malformed-response state rather
 * than a misleading "healthy" reading. Lease instants must also fall inside
 * the ECMAScript Date range, so formatting one can never throw.
 *
 * @module
 */
import type { HttpClient } from '@lostgradient/weft';

export type SystemLease = Awaited<ReturnType<HttpClient['operations']['weft.system.lease']>>;
export type SystemLeaseStatus = SystemLease['status'];

const LEASE_STATUSES: ReadonlySet<string> = new Set<SystemLeaseStatus>([
  'disabled',
  'healthy',
  'no-lease',
  'contested',
]);

/** A `weft.system.lease` response the dashboard refuses to render. */
export class MalformedSystemLeaseError extends Error {
  constructor() {
    super('Weft returned a malformed engine lease response.');
    this.name = 'MalformedSystemLeaseError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOptionalNumber(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value));
}

const HOLDER_TIMING_FIELDS = ['heldSince', 'expiresAt', 'lastRenewedAt', 'fencingEpoch'] as const;
const LEASE_INSTANT_FIELDS = ['heldSince', 'expiresAt', 'lastRenewedAt'] as const;

/** The ECMAScript time value range: a larger magnitude makes `new Date(t).toISOString()` throw. */
const MAX_DATE_TIME_VALUE = 8.64e15;

function isOptionalInstant(value: unknown): boolean {
  return (
    value === undefined || (typeof value === 'number' && Math.abs(value) <= MAX_DATE_TIME_VALUE)
  );
}

function hasHolderEvidence(value: Record<string, unknown>): boolean {
  return (
    typeof value['holderId'] === 'string' &&
    HOLDER_TIMING_FIELDS.every(
      (field) => typeof value[field] === 'number' && Number.isFinite(value[field]),
    )
  );
}

function hasNoHolderEvidence(value: Record<string, unknown>): boolean {
  return (
    value['holderId'] === undefined && HOLDER_TIMING_FIELDS.every((f) => value[f] === undefined)
  );
}

/**
 * The wire schema is flat, but Weft builds it from the `EngineLeaseHealth`
 * union, so only these combinations are coherent:
 * - `disabled` ⇔ `mode: 'none'`, not held, no holder evidence;
 * - `no-lease`: `mode: 'lease'`, not held, no holder evidence;
 * - `healthy`: `mode: 'lease'`, held, with the holder and its four instants;
 * - `contested`: `mode: 'lease'`, not held, with either the holder evidence
 *   (and an optional loss reason) or only the confirmed `deposed` reason.
 * A loss reason is only coherent on `contested`.
 */
function isCoherentLease(value: Record<string, unknown>): boolean {
  const { mode, status, holdsLease, lossReason } = value;
  if (status !== 'contested' && lossReason !== undefined) return false;
  switch (status) {
    case 'disabled':
      return mode === 'none' && holdsLease === false && hasNoHolderEvidence(value);
    case 'no-lease':
      return mode === 'lease' && holdsLease === false && hasNoHolderEvidence(value);
    case 'healthy':
      return mode === 'lease' && holdsLease === true && hasHolderEvidence(value);
    case 'contested':
      return (
        mode === 'lease' &&
        holdsLease === false &&
        (hasHolderEvidence(value) || (lossReason === 'deposed' && hasNoHolderEvidence(value)))
      );
    default:
      return false;
  }
}

function isSystemLease(value: unknown): value is SystemLease {
  return (
    isRecord(value) &&
    (value['mode'] === 'none' || value['mode'] === 'lease') &&
    typeof value['status'] === 'string' &&
    LEASE_STATUSES.has(value['status']) &&
    typeof value['holdsLease'] === 'boolean' &&
    (value['holderId'] === undefined || typeof value['holderId'] === 'string') &&
    (value['lossReason'] === undefined ||
      value['lossReason'] === 'deposed' ||
      value['lossReason'] === 'renewal-unconfirmable') &&
    HOLDER_TIMING_FIELDS.every((field) => isOptionalNumber(value[field])) &&
    LEASE_INSTANT_FIELDS.every((field) => isOptionalInstant(value[field])) &&
    isCoherentLease(value)
  );
}

/** Validates a `weft.system.lease` response. */
export function parseSystemLease(value: unknown): SystemLease {
  if (!isSystemLease(value)) throw new MalformedSystemLeaseError();
  return value;
}

/** Reads and validates the serving engine's lease health. */
export async function loadSystemLease(
  client: Pick<HttpClient, 'operations'>,
): Promise<SystemLease> {
  return parseSystemLease(await client.operations['weft.system.lease']({}));
}

export type LeaseStatusVariant = 'success' | 'warning' | 'danger' | 'neutral';

export interface LeaseStatusPresentation {
  readonly label: string;
  readonly variant: LeaseStatusVariant;
  readonly description: string;
}

const LOSS_REASON_TEXT: Readonly<Record<NonNullable<SystemLease['lossReason']>, string>> = {
  deposed: 'another holder deposed this engine',
  'renewal-unconfirmable': 'storage failures outlasted the last confirmed lease expiry',
};

/** Text-first presentation for a lease status; the variant only adds color. */
export function leaseStatusPresentation(lease: SystemLease): LeaseStatusPresentation {
  switch (lease.status) {
    case 'healthy':
      return {
        label: 'Healthy',
        variant: 'success',
        description: 'This engine holds the ownership lease.',
      };
    case 'no-lease':
      return {
        label: 'No lease held',
        variant: 'warning',
        description: 'Lease ownership is enabled, but this engine does not hold the lease yet.',
      };
    case 'contested':
      return {
        label: 'Contested',
        variant: 'danger',
        description: lease.lossReason
          ? `This engine lost the ownership lease: ${LOSS_REASON_TEXT[lease.lossReason]}.`
          : 'This engine lost the ownership lease.',
      };
    case 'disabled':
      return {
        label: 'Disabled',
        variant: 'neutral',
        description: 'Lease ownership is not configured for this engine.',
      };
  }
}
