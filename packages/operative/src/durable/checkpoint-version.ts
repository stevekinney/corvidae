import { validateStoredResponseParts } from '../stored-parts';

/**
 * The version of the cursor and step records a durable run persists (COR-713).
 *
 * Both records were versionless before this: the store cast whatever JSON it found and defaulted
 * the fields that were missing. Version 2 adds the response parts (`StepRecord.parts`,
 * `RunCursor.lastParts`), and an older record is not read as a record with empty parts. It fails
 * with {@link UnsupportedCheckpointRecordVersionError}, in strict and tolerant reads alike, rather
 * than silently dual-reading or deriving parts from `content`. The version is stamped on every
 * write, so a record's absence of one identifies it as written by an older build.
 */
export const CHECKPOINT_RECORD_SCHEMA_VERSION = 2 as const;

export type CheckpointRecordKind = 'cursor' | 'step';

/**
 * Raised when a persisted cursor or step record is not at the current version: an in-flight
 * durable run written by an older build cannot be resumed or read as if it were current.
 */
export class UnsupportedCheckpointRecordVersionError extends Error {
  readonly record: CheckpointRecordKind;
  /** The stored `schemaVersion`; `undefined` for a record written before records were versioned. */
  readonly version: unknown;

  constructor(record: CheckpointRecordKind, version: unknown) {
    super(
      `Unsupported durable ${record} record version ${version === undefined ? '(none)' : JSON.stringify(version)}: ` +
        `this build reads version ${CHECKPOINT_RECORD_SCHEMA_VERSION}. A durable run written by an ` +
        `older build cannot be resumed; start a new run.`,
    );
    this.name = 'UnsupportedCheckpointRecordVersionError';
    this.record = record;
    this.version = version;
  }
}

/**
 * Checks a parsed record is at the current version and carries valid parts: an array whose elements
 * are content parts without inline bytes (COR-1581, through {@link validateStoredResponseParts}). A
 * record at another version throws {@link UnsupportedCheckpointRecordVersionError}; a current-version
 * record whose parts are missing or invalid is malformed, which is reported as `false` so the caller
 * applies its own strict or tolerant rule.
 */
export function isCurrentCheckpointRecord(
  kind: CheckpointRecordKind,
  value: unknown,
): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record['schemaVersion'] !== CHECKPOINT_RECORD_SCHEMA_VERSION) {
    throw new UnsupportedCheckpointRecordVersionError(kind, record['schemaVersion']);
  }
  const partsField = kind === 'cursor' ? 'lastParts' : 'parts';
  return validateStoredResponseParts(record[partsField]).valid;
}

/** Throws unless a record about to be written is at the current version and carries valid parts. */
export function assertWritableCheckpointRecord(kind: CheckpointRecordKind, value: unknown): void {
  if (!isCurrentCheckpointRecord(kind, value)) {
    const record = (value ?? {}) as Record<string, unknown>;
    throw new UnsupportedCheckpointRecordVersionError(
      kind,
      `${String(record['schemaVersion'])} without valid parts`,
    );
  }
}

/**
 * Throws unless a step memo Weft replayed is at the current shape (COR-713). A memo is replayed
 * from its recorded result without running the step again, so the write-side assertion in the
 * checkpoint store never runs for it: an in-flight run written by an older build carries a step
 * record without its version or parts and accumulators without the part fields, and reading them
 * would fail with a `TypeError` (or, for a step that recorded nothing, resume silently).
 */
export function assertCurrentStepMemo(memo: {
  readonly record: unknown;
  readonly nextAccumulators: object;
}): void {
  if (memo.record !== null) assertWritableCheckpointRecord('step', memo.record);
  const { lastParts, finalRowIsReplacement } = memo.nextAccumulators as Record<string, unknown>;
  if (!validateStoredResponseParts(lastParts).valid || typeof finalRowIsReplacement !== 'boolean') {
    throw new UnsupportedCheckpointRecordVersionError('cursor', undefined);
  }
}
