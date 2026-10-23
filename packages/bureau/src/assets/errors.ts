/**
 * Asset errors. Every message is built from identifiers and codes only —
 * never from bytes, URLs, or port error text — so an error can be logged or
 * rethrown across a boundary without leaking what the asset contained or
 * where it came from.
 */
import type { AssetLifecycleState, AssetRejection, AssetRejectionCode } from './types';

/** Admission refused the asset. Thrown by `admit()` before persistence, and carried inside a failed work result after. */
export class AssetAdmissionError extends Error {
  readonly code: AssetRejectionCode;

  constructor(code: AssetRejectionCode, message: string) {
    super(message);
    this.name = 'AssetAdmissionError';
    this.code = code;
  }

  get rejection(): AssetRejection {
    return { code: this.code, message: this.message };
  }
}

/**
 * The asset does not exist, or the caller's persisted authorization does not
 * reach it — the two are deliberately indistinguishable (the same rule
 * `principalAllows` documents for children and goals).
 */
export class AssetNotFoundError extends Error {
  readonly assetId: string;

  constructor(assetId: string) {
    super(`Asset "${assetId}" was not found.`);
    this.name = 'AssetNotFoundError';
    this.assetId = assetId;
  }
}

/** The caller may read the asset but lacks the privileged capability the operation needs. */
export class AssetAccessDeniedError extends Error {
  readonly assetId: string;

  constructor(assetId: string, operation: string) {
    super(`The privileged capability is required to ${operation} asset "${assetId}".`);
    this.name = 'AssetAccessDeniedError';
    this.assetId = assetId;
  }
}

/** The asset exists and the caller may see it, but its state does not allow the operation. */
export class AssetUnavailableError extends Error {
  readonly assetId: string;
  readonly state: AssetLifecycleState;

  constructor(assetId: string, state: AssetLifecycleState) {
    super(`Asset "${assetId}" is ${state}.`);
    this.name = 'AssetUnavailableError';
    this.assetId = assetId;
    this.state = state;
  }
}

/**
 * A stored asset record cannot be read as an {@link AssetRecord}: its JSON does not parse, or a
 * parsed record lacks a member the service reads or has one of the wrong type. The bytes and the
 * record's content stay out of the message; it names the asset and the member only. The asset is
 * not lost, but nothing can claim, inspect or resolve it until the record is repaired, which is
 * why the session outbox drain treats this one failure as permanent (COR-1581).
 */
export class AssetRecordCorruptError extends Error {
  readonly assetId: string;
  /** What is wrong, as a member name or a stable code; never any of the record's content. */
  readonly reason: string;

  constructor(assetId: string, reason: string) {
    super(`The stored record of asset "${assetId}" is corrupt: ${reason}.`);
    this.name = 'AssetRecordCorruptError';
    this.assetId = assetId;
    this.reason = reason;
  }
}

/** A legal or audit hold forbids the requested deletion or expiry. */
export class AssetHeldError extends Error {
  readonly assetId: string;

  constructor(assetId: string) {
    super(`Asset "${assetId}" is under a hold.`);
    this.name = 'AssetHeldError';
    this.assetId = assetId;
  }
}

/** Stored bytes no longer match the asset's recorded digest, or are missing. */
export class AssetIntegrityError extends Error {
  readonly assetId: string;

  constructor(assetId: string) {
    super(`Stored bytes for asset "${assetId}" do not match its recorded digest.`);
    this.name = 'AssetIntegrityError';
    this.assetId = assetId;
  }
}

/** A compare-and-swap write lost to a concurrent writer (another process sharing durable storage). */
export class AssetConflictError extends Error {
  readonly key: string;

  constructor(key: string) {
    super(`A concurrent write changed "${key}" first.`);
    this.name = 'AssetConflictError';
    this.key = key;
  }
}

/** A public `retain` named a holder id Bureau reserves for its own row claims (COR-1664). */
export class AssetReservedHolderError extends Error {
  readonly holderId: string;

  constructor(holderId: string) {
    super(`The holder id "${holderId}" is reserved for Bureau's own claims.`);
    this.name = 'AssetReservedHolderError';
    this.holderId = holderId;
  }
}

/** The bounded in-memory backend refused a write that would exceed its capacity. */
export class AssetStorageCapacityError extends Error {
  readonly maxBytes: number;

  constructor(maxBytes: number) {
    super(`Asset storage capacity of ${maxBytes} bytes would be exceeded.`);
    this.name = 'AssetStorageCapacityError';
    this.maxBytes = maxBytes;
  }
}

/** A started-work handle was aborted. Carries the caller's reason. */
export class AssetWorkAbortedError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`Asset work aborted: ${reason}`);
    this.name = 'AssetWorkAbortedError';
    this.reason = reason;
  }
}

/** The service has shut down and accepts no new work. */
export class AssetServiceClosedError extends Error {
  constructor() {
    super('The asset service has shut down.');
    this.name = 'AssetServiceClosedError';
  }
}
