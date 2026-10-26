/**
 * The Bureau-scoped extension of `@lostgradient/operative`'s fault-plan
 * vocabulary (AB-263 / AB-94's tst-03d child).
 *
 * `packages/operative/src/test/fault-plan.ts` (AB-257) fixes `FaultBoundary`,
 * `FaultOperation`, `FaultOccurrence`, `FaultPlanEntry`, `FaultPlan`, and
 * `FiredFault` for boundaries operative itself can see. Three boundaries
 * AB-92's Decision (2026-09-01) names are Bureau-owned resources invisible
 * from operative — webhook delivery and audit write — so
 * this file widens `FaultOperation` into `BureauFaultOperation` and mirrors
 * `FaultPlanEntry`/`FaultPlan` with that widened operation, re-exporting
 * every operative fault type verbatim rather than redeclaring one, so there
 * is exactly one `FaultBoundary` union in the repository.
 *
 * Every plan entry still only NAMES a target — no engine exists yet to
 * execute a `BureauFaultPlan` at a boundary (AB-95/tst-04a is that engine).
 * What this file adds beyond the type vocabulary is the selector
 * functions a future engine (and, today, a test asserting a plan entry's
 * addressing) uses to resolve a Bureau-scoped target to exactly one
 * concrete resource: a webhook delivery by its `WebhookDeliveryRecord.id`
 * (from `WebhookNotifier.listDeliveries()`), an audit write by its audit
 * entry key (`audit-trail.ts`'s own `encodeKey` encoding, reused here —
 * never reimplemented).
 */
import type {
  FaultBoundary,
  FaultOccurrence,
  FaultOperation,
  FaultPlan,
  FaultPlanEntry,
  FiredFault,
} from '@lostgradient/operative';

import type { AssetWorkKind, AssetWorkSnapshot } from '../assets/types';
import type { AuditRecord } from '../audit-trail';
import { encodeKey } from '../audit-trail';
import type { WebhookDeliveryRecord } from '../webhook-notifier';

// Re-exported verbatim (never redeclared) — see this file's module doc.
export type {
  FaultBoundary,
  FaultOccurrence,
  FaultOperation,
  FaultPlan,
  FaultPlanEntry,
  FiredFault,
};

/**
 * `FaultOperation` widened with the two Bureau-owned boundaries AB-92
 * names that operative cannot see: webhook delivery and audit write.
 */
export type BureauFaultOperation =
  | FaultOperation
  | 'webhook-delivery'
  | 'audit-write'
  // COR-794: every managed-asset started-work kind, addressed by its work id.
  | `asset:${AssetWorkKind}`;

/** The selector operations a {@link BureauFaultSelectorResolutionError} can name. */
type SelectorOperation = 'webhook-delivery' | 'audit-write' | 'asset-work';

/** Mirrors operative's `FaultPlanEntry` with the widened {@link BureauFaultOperation}. */
export interface BureauFaultPlanEntry {
  readonly id: string;
  readonly boundary: FaultBoundary;
  readonly operation: BureauFaultOperation;
  readonly occurrence: FaultOccurrence;
  readonly effect: unknown;
}

/** An ordered, immutable set of Bureau-scoped fault-plan entries. */
export type BureauFaultPlan = readonly BureauFaultPlanEntry[];

/** Raised by a selector when a target identifier resolves to zero or more than one candidate. */
export class BureauFaultSelectorResolutionError extends Error {
  readonly operation: SelectorOperation;
  readonly matchCount: number;

  constructor(operation: SelectorOperation, targetDescription: string, matchCount: number) {
    super(
      `Bureau fault selector for "${operation}" must resolve to exactly one resource for ` +
        `${targetDescription}, found ${matchCount}.`,
    );
    this.name = 'BureauFaultSelectorResolutionError';
    this.operation = operation;
    this.matchCount = matchCount;
  }
}

/**
 * Single-pass resolution shared by every selector below: walks `candidates`
 * once, tracking at most the first two matches (never allocating a full
 * `matches` array via `filter`), and stops scanning the instant a second
 * match proves the resolution ambiguous. Throws
 * {@link BureauFaultSelectorResolutionError} unless exactly one candidate
 * satisfies `isMatch`.
 */
function resolveExactlyOne<TCandidate>(
  operation: SelectorOperation,
  targetDescription: string,
  candidates: readonly TCandidate[],
  isMatch: (candidate: TCandidate) => boolean,
): TCandidate {
  let match: TCandidate | undefined;
  let matchCount = 0;
  for (const candidate of candidates) {
    if (!isMatch(candidate)) continue;
    matchCount++;
    if (matchCount === 1) {
      match = candidate;
    } else {
      // A second match already makes this ambiguous — no need to keep
      // scanning to find a precise final count for the error message.
      throw new BureauFaultSelectorResolutionError(operation, targetDescription, matchCount);
    }
  }
  if (matchCount !== 1 || !match) {
    throw new BureauFaultSelectorResolutionError(operation, targetDescription, matchCount);
  }
  return match;
}

/**
 * Resolves a webhook-delivery fault target to exactly one
 * {@link WebhookDeliveryRecord} by its `id` (as listed by
 * `WebhookNotifier.listDeliveries()`). Throws
 * {@link BureauFaultSelectorResolutionError} when `deliveries` contains zero
 * or more than one record with that id.
 */
export function selectWebhookDeliveryFaultTarget(
  deliveries: readonly WebhookDeliveryRecord[],
  deliveryId: string,
): WebhookDeliveryRecord {
  return resolveExactlyOne(
    'webhook-delivery',
    `delivery id "${deliveryId}"`,
    deliveries,
    (delivery) => delivery.id === deliveryId,
  );
}

/**
 * Resolves an audit-write fault target to exactly one {@link AuditRecord} by
 * its audit entry key — `audit-trail.ts`'s own `encodeKey(timestampMs,
 * sequence, runId)` encoding, reconstructed here from each candidate
 * record's own public fields rather than reimplemented. Throws
 * {@link BureauFaultSelectorResolutionError} when `records` contains zero or
 * more than one record whose key matches.
 */
export function selectAuditWriteFaultTarget(
  records: readonly AuditRecord[],
  auditEntryKey: string,
): AuditRecord {
  return resolveExactlyOne(
    'audit-write',
    `audit entry key "${auditEntryKey}"`,
    records,
    (record) =>
      // AB-370: `sequence` is optional on `AuditRecord` (absent only on a
      // record written before the field existed), but every record THIS
      // trail's own write paths produce today always sets it — a genuine
      // fault-plan target is always a freshly-written record, never a
      // legacy one, so `?? 0` is a safe, honest fallback rather than a cast.
      encodeKey(record.timestampMs, record.sequence ?? 0, record.runId) === auditEntryKey,
  );
}

/**
 * Resolves an asset fault target (COR-794) to exactly one
 * {@link AssetWorkSnapshot} by its started-work id, as listed by
 * `AssetService.activeWork()` — the same public surface
 * `assertBureauQuiescent` reads. Throws
 * {@link BureauFaultSelectorResolutionError} when `active` contains zero or
 * more than one snapshot with that id.
 */
export function selectAssetWorkFaultTarget(
  active: readonly AssetWorkSnapshot[],
  workId: string,
): AssetWorkSnapshot {
  return resolveExactlyOne(
    'asset-work',
    `work id "${workId}"`,
    active,
    (work) => work.id === workId,
  );
}
