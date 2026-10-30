/**
 * The validators `createBureau` applies to the options `bureau.settings` can also set (COR-1710).
 * They live here so the settings run the same checks on a stored or patched value that
 * construction runs on the code option, and refuse what the consumer would refuse.
 *
 * @module option-validators
 */

import type { CheckpointRetentionOption } from './audit-trail.ts';
import { MAXIMUM_WORKFLOW_LOG_LINES_PER_RUN } from './settings/settings-schema.ts';
import type {
  BureauChildrenOptions,
  BureauRetentionOptions,
  RetentionWindowOption,
} from './types.ts';

/** Throws the caller's bad-request error. */
export type BadRequest = (message: string) => never;

/**
 * AB-194 — `BureauOptions.sessionInput`'s `sessionBacklogLimit`/
 * `principalBacklogLimit` must each be a positive integer when supplied.
 * Throws `BureauError('...', 'BAD_REQUEST')` for 0, a negative number, or a
 * non-integer; a `undefined` value (option omitted) passes through untouched.
 */
export function validateSessionInputBacklogLimit(
  value: number | undefined,
  optionName: string,
  badRequest: BadRequest,
): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value <= 0) {
    badRequest(`"options.sessionInput.${optionName}" must be a positive integer`);
  }
}

/**
 * AB-388 (Codex review, PR #597, "Reject non-finite and negative retention
 * durations"): `BureauRetentionOptions.audit`'s `{ olderThan }` form feeds
 * `pruneAuditTrail`'s cutoff arithmetic (`now - retention.olderThan`)
 * directly — TypeScript's `number` type permits `NaN`, `Infinity`, and
 * negative values, none of which are safe here. `NaN` makes every
 * `record.timestampMs >= cutoffMs` comparison in `AuditTrail.prune` false,
 * deleting the ENTIRE trail even when a fleet retention floor exists;
 * `-Infinity` (or any negative value large enough) moves the cutoff into
 * the future and can remove records that were just written. Validated here
 * (BAD_REQUEST at construction time), the same boundary
 * `validateSessionInputBacklogLimit` above already uses for a different
 * destructive-if-malformed option.
 */
export function validateAuditRetentionOption(
  value: { olderThan: number } | 'forever' | undefined,
  badRequest: BadRequest,
): void {
  if (value === undefined || value === 'forever') return;
  if (!Number.isFinite(value.olderThan) || value.olderThan < 0) {
    badRequest('"options.retention.audit.olderThan" must be a finite, non-negative number');
  }
}

/**
 * COR-1477 — `BureauRetentionOptions.events` and `retention.tasks` feed a cutoff
 * (`now - olderThan`) that decides what maintenance deletes, so they get the
 * same finite, non-negative rule `retention.audit` gets: `NaN` would compare
 * false against every timestamp, and a negative value moves the cutoff into
 * the future.
 */
export function validateRetentionWindowOption(
  value: RetentionWindowOption | undefined,
  optionName: string,
  badRequest: BadRequest,
): void {
  if (value === undefined || value === 'forever') return;
  if (!Number.isFinite(value.olderThan) || value.olderThan < 0) {
    badRequest(`"options.${optionName}.olderThan" must be a finite, non-negative number`);
  }
}

/**
 * COR-625 — `BureauRetentionOptions.checkpoints`'s `{ keepLast }` form feeds
 * weft's `Engine.pruneCheckpoints` (COR-11), whose own contract requires a
 * non-negative integer. Bureau narrows that further to a POSITIVE integer:
 * `keepLast: 0` would discard a terminal run's entire checkpoint history,
 * including the newest entry a postmortem needs, which is a destructive
 * default no operator means to configure — an operator who genuinely wants
 * nothing retained is asking to delete the run, not to retain zero of it.
 * `timeoutMilliseconds` bounds the step's own wait and its abort signal, so
 * `NaN` or a negative value would arm a timer that fires immediately (or
 * never), turning every step into a spurious `'timed-out'`. Validated here at
 * construction time, the same boundary `validateAuditRetentionOption` above
 * uses for the other destructive-if-malformed retention option.
 */
export function validateCheckpointRetentionOption(
  value: CheckpointRetentionOption | undefined,
  badRequest: BadRequest,
): void {
  if (value === undefined || value === 'keep-all') return;
  if (!Number.isInteger(value.keepLast) || value.keepLast <= 0) {
    badRequest('"options.retention.checkpoints.keepLast" must be a positive integer');
  }
  const timeout = value.timeoutMilliseconds;
  if (timeout !== undefined && (!Number.isFinite(timeout) || timeout < 0)) {
    badRequest(
      '"options.retention.checkpoints.timeoutMilliseconds" must be a finite, non-negative number',
    );
  }
}

/**
 * COR-424 — `BureauRetentionOptions.receipts` decides when a run-creation request id may create a
 * second run, so a value that is not a positive integer is a construction-time error, as Weft's
 * mailbox treats its own `terminalRetentionMs`. COR-1701: only `{ olderThan }` exists. A receipt
 * is a deduplication ledger entry, and `'forever'` (or any other non-object) is refused rather
 * than silently reading as the default. The parameter is `unknown` because the type already
 * forbids what this refuses, and an untyped caller can still pass it.
 */
export function validateReceiptRetentionOption(value: unknown, badRequest: BadRequest): void {
  if (value === undefined) return;
  if (typeof value !== 'object' || value === null) {
    badRequest(
      '"options.retention.receipts" must be { olderThan: number }; run-creation receipts cannot be kept forever',
    );
  }
  const olderThan = (value as { readonly olderThan?: unknown }).olderThan;
  if (typeof olderThan !== 'number' || !Number.isSafeInteger(olderThan) || olderThan <= 0) {
    badRequest('"options.retention.receipts.olderThan" must be a positive integer');
  }
}

/** COR-1809 — `BureauRetentionOptions.memory` is `{ olderThan }`, a positive integer of milliseconds. */
export function validateMemoryRetentionOption(value: unknown, badRequest: BadRequest): void {
  if (value === undefined) return;
  if (typeof value !== 'object' || value === null) {
    badRequest('"options.retention.memory" must be { olderThan: number }');
  }
  const olderThan = (value as { readonly olderThan?: unknown }).olderThan;
  if (typeof olderThan !== 'number' || !Number.isSafeInteger(olderThan) || olderThan <= 0) {
    badRequest('"options.retention.memory.olderThan" must be a positive integer');
  }
}

/** COR-1811 — `BureauRetentionOptions.logs` is `{ olderThan }`, a positive integer of milliseconds. */
export function validateLogsRetentionOption(value: unknown, badRequest: BadRequest): void {
  if (value === undefined) return;
  if (typeof value !== 'object' || value === null) {
    badRequest('"options.retention.logs" must be { olderThan: number }');
  }
  const olderThan = (value as { readonly olderThan?: unknown }).olderThan;
  if (typeof olderThan !== 'number' || !Number.isSafeInteger(olderThan) || olderThan <= 0) {
    badRequest('"options.retention.logs.olderThan" must be a positive integer');
  }
}

/** COR-1811 — `BureauLogsOptions.maximumLinesPerRun` is a positive integer, at most 5000, when given. */
export function validateLogsMaximumLinesPerRun(value: unknown, badRequest: BadRequest): void {
  if (value === undefined) return;
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > MAXIMUM_WORKFLOW_LOG_LINES_PER_RUN
  ) {
    badRequest(
      `"options.logs.maximumLinesPerRun" must be a positive integer of at most ${MAXIMUM_WORKFLOW_LOG_LINES_PER_RUN}`,
    );
  }
}

export function validateRetentionOptions(
  retention: BureauRetentionOptions | undefined,
  badRequest: BadRequest,
): void {
  if (retention !== undefined && (typeof retention !== 'object' || retention === null)) {
    badRequest('"options.retention" must be an object of retention windows');
  }
  validateAuditRetentionOption(retention?.audit, badRequest);
  validateRetentionWindowOption(retention?.events, 'retention.events', badRequest);
  validateRetentionWindowOption(retention?.tasks, 'retention.tasks', badRequest);
  validateCheckpointRetentionOption(retention?.checkpoints, badRequest);
  validateReceiptRetentionOption(retention?.receipts, badRequest);
  validateMemoryRetentionOption(retention?.memory, badRequest);
  validateLogsRetentionOption(retention?.logs, badRequest);
}

/**
 * COR-772 — `BureauOptions.children.delegation` signs every child's grant, so
 * an empty secret or a lifetime that expires every grant on issue is a
 * construction-time error rather than a silently unusable topology.
 */
export function validateChildrenOption(
  value: BureauChildrenOptions | undefined,
  badRequest: BadRequest,
): void {
  const delegation = value?.delegation;
  if (delegation === undefined) return;
  if (typeof delegation.secret !== 'string' || delegation.secret.length === 0) {
    badRequest('"options.children.delegation.secret" must be a non-empty string');
  }
  validateDelegationTimeToLive(delegation.defaultTimeToLiveMilliseconds, badRequest);
}

/** `children.delegation.defaultTimeToLiveMilliseconds`: a positive, finite number when given. */
export function validateDelegationTimeToLive(timeToLive: unknown, badRequest: BadRequest): void {
  if (timeToLive === undefined) return;
  if (typeof timeToLive !== 'number' || !(Number.isFinite(timeToLive) && timeToLive > 0)) {
    badRequest(
      '"options.children.delegation.defaultTimeToLiveMilliseconds" must be a positive, finite number',
    );
  }
}
