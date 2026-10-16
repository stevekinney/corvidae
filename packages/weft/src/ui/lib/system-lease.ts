/**
 * Engine ownership-lease health from `weft.system.lease` (`system:read`),
 * shared by the Dashboard's critical-alerts band and the System route's
 * Health & lease tab (COR-124). This is the serving engine process's
 * last-known lease state: `disabled` when lease ownership is off, `no-lease`
 * before it is held, `healthy` while held, and `contested` once ownership is
 * lost (with the confirmed `deposed` or `renewal-unconfirmable` reason when
 * Weft reports one).
 *
 * The response is validated here, at the dashboard's trust boundary, so a
 * drifted payload surfaces as an explicit malformed-response state rather
 * than a misleading "healthy" reading.
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

const HELD_LEASE_NUMBER_FIELDS = ['heldSince', 'expiresAt', 'lastRenewedAt', 'fencingEpoch'];

/**
 * The status, mode, and `holdsLease` must agree the way Weft's
 * `EngineLeaseHealth` union says they do: `disabled` only with mode `none`,
 * every other status only with mode `lease`, and `healthy` exactly when this
 * engine holds the lease, with its holder and lease instants present. A
 * `contested` reading may omit the holder fields (a confirmed `deposed` loss
 * can arrive without them).
 */
function isCoherentLeaseStatus(value: Record<string, unknown>): boolean {
  const status = value['status'];
  if ((status === 'disabled') !== (value['mode'] === 'none')) return false;
  if ((status === 'healthy') !== (value['holdsLease'] === true)) return false;
  if (status !== 'healthy') return true;
  return (
    typeof value['holderId'] === 'string' &&
    HELD_LEASE_NUMBER_FIELDS.every((field) => typeof value[field] === 'number')
  );
}

function isSystemLease(value: unknown): value is SystemLease {
  return (
    isRecord(value) &&
    (value['mode'] === 'none' || value['mode'] === 'lease') &&
    typeof value['status'] === 'string' &&
    LEASE_STATUSES.has(value['status']) &&
    typeof value['holdsLease'] === 'boolean' &&
    isCoherentLeaseStatus(value) &&
    (value['holderId'] === undefined || typeof value['holderId'] === 'string') &&
    (value['lossReason'] === undefined ||
      value['lossReason'] === 'deposed' ||
      value['lossReason'] === 'renewal-unconfirmable') &&
    HELD_LEASE_NUMBER_FIELDS.every((field) => isOptionalNumber(value[field]))
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
