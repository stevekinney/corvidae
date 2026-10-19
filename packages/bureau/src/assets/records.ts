/**
 * The persisted asset record, its key schema, compare-and-swap persistence,
 * authorization, and the two descriptor projections (COR-794).
 *
 * Key schema (all under `asset:v1:`):
 *
 * - `record:<assetId>` — the {@link AssetRecord} JSON, the single source of
 *   truth for an asset's identity, authorization, and lifecycle state.
 * - `blob:<digest>` — the bytes, base64, stored once per digest.
 * - `owner:<digest>:<assetId>` — one key per asset that owns a blob; a blob
 *   with no owner keys (and no live lease) is garbage.
 * - `digest:<owner>:<digest>` — the asset id an owner's duplicate policy
 *   compares against.
 * - `upload:<uploadId>` / `upload-chunk:<uploadId>:<sequence>` — upload
 *   sessions and their chunks.
 * - `audit:<sequence>` — durable audit records.
 *
 * Every record transition is one `conditionalBatch` guarded by the record's
 * previous JSON, so the record and the owner/digest keys it implies change
 * together or not at all.
 */
import {
  AssetAccessDeniedError,
  AssetConflictError,
  AssetNotFoundError,
  AssetRecordCorruptError,
} from './errors';
import { mimeFamilyOf, modalityOf } from './media-inspection';
import type { AssetStorage, AssetStorageOperation } from './storage';
import type {
  AssetCustody,
  AssetDescriptor,
  AssetHold,
  AssetLifecycleState,
  AssetMediaFacts,
  AssetPrincipal,
  AssetProjection,
  AssetProvenance,
  AssetProviderCopy,
  AssetReference,
  AssetRejection,
  AssetSafetyVerdict,
  GeneralAssetDescriptor,
  ManagedAssetSource,
  PrivilegedAssetDescriptor,
} from './types';

const PREFIX = 'asset:v1:';

export const KEYS = {
  recordPrefix: `${PREFIX}record:`,
  blobPrefix: `${PREFIX}blob:`,
  uploadPrefix: `${PREFIX}upload:`,
  auditPrefix: `${PREFIX}audit:`,
  record: (assetId: string) => `${PREFIX}record:${assetId}`,
  blob: (digest: string) => `${PREFIX}blob:${digest}`,
  ownerPrefix: (digest: string) => `${PREFIX}owner:${digest}:`,
  owner: (digest: string, assetId: string) => `${PREFIX}owner:${digest}:${assetId}`,
  digestIndex: (ownerId: string, digest: string) =>
    `${PREFIX}digest:${encodeURIComponent(ownerId)}:${digest}`,
  upload: (uploadId: string) => `${PREFIX}upload:${uploadId}`,
  chunkRootPrefix: `${PREFIX}upload-chunk:`,
  chunkPrefix: (uploadId: string) => `${PREFIX}upload-chunk:${uploadId}:`,
  chunk: (uploadId: string, sequence: number) =>
    `${PREFIX}upload-chunk:${uploadId}:${String(sequence).padStart(8, '0')}`,
  audit: (sequence: number) => `${PREFIX}audit:${String(sequence).padStart(12, '0')}`,
} as const;

/** The persisted form of one asset. Never leaves this package except through a projection. */
export interface AssetRecord {
  readonly version: 1;
  readonly assetId: string;
  readonly revision: number;
  readonly state: AssetLifecycleState;
  readonly custody: AssetCustody;
  readonly ownerId: string;
  readonly readers: readonly string[];
  readonly declaredMediaType?: string | undefined;
  readonly mediaType?: string | undefined;
  readonly byteLength?: number | undefined;
  readonly digest?: string | undefined;
  readonly media: AssetMediaFacts;
  readonly provenance: AssetProvenance;
  /** A provider-fetch declaration's URL — a secret, returned only by `resolve()`. */
  readonly providerFetchUrl?: string | undefined;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly retainUntil?: string | undefined;
  readonly references: readonly AssetReference[];
  readonly holds: readonly AssetHold[];
  readonly safety: readonly AssetSafetyVerdict[];
  readonly providerCopies: readonly AssetProviderCopy[];
  readonly rejection?: AssetRejection | undefined;
  readonly duplicateOf?: string | undefined;
  readonly expiredAt?: string | undefined;
  readonly deletedAt?: string | undefined;
  /** When a terminal record (rejected, quarantined, expired, deleted) may be purged. */
  readonly tombstoneUntil?: string | undefined;
}

export interface LoadedRecord {
  readonly record: AssetRecord;
  readonly raw: string;
}

/** The members every record carries, and the top-level type each one must have. */
const REQUIRED_MEMBERS: ReadonlyArray<
  readonly [member: keyof AssetRecord, type: 'string' | 'number' | 'array' | 'object']
> = [
  ['assetId', 'string'],
  ['revision', 'number'],
  ['state', 'string'],
  ['custody', 'string'],
  ['ownerId', 'string'],
  ['readers', 'array'],
  ['media', 'object'],
  ['provenance', 'object'],
  ['createdAt', 'string'],
  ['updatedAt', 'string'],
  ['references', 'array'],
  ['holds', 'array'],
  ['safety', 'array'],
  ['providerCopies', 'array'],
];

/** Optional members the read path treats as strings: each must be a string when it is present. */
const OPTIONAL_STRING_MEMBERS: ReadonlyArray<keyof AssetRecord> = [
  'declaredMediaType',
  'mediaType',
  'digest',
  'providerFetchUrl',
  'retainUntil',
  'duplicateOf',
  'expiredAt',
  'deletedAt',
  'tombstoneUntil',
];

/** Whether a string parses as a finite date: `computeExpiresAt` throws a `RangeError` for one that does not. */
function parsesAsDate(value: unknown): boolean {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasType(value: unknown, type: 'string' | 'number' | 'array' | 'object'): boolean {
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return isPlainObject(value);
  return typeof value === type;
}

/**
 * Parses a stored record and checks the shape the service reads (COR-1581): `version` is 1, every
 * required member is present with the right top-level type, and each `references` entry carries a
 * string `holderId` and `until`, because `retain` reads both, and every date the claim path parses
 * (`retainUntil`, each `until`) must be a date. Optional members the read path treats as strings
 * must be strings when present. The elements of the other arrays are not checked. A stored `null`
 * is no record at all (`undefined`, reading as not found); anything else that fails throws
 * {@link AssetRecordCorruptError}.
 */
function parseRecord(raw: string, assetId: string): AssetRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AssetRecordCorruptError(assetId, 'the JSON does not parse');
  }
  if (parsed === null) return undefined;
  if (!isPlainObject(parsed)) throw new AssetRecordCorruptError(assetId, 'it is not an object');
  if (parsed['version'] !== 1) throw new AssetRecordCorruptError(assetId, 'version is not 1');
  for (const [member, type] of REQUIRED_MEMBERS) {
    if (!hasType(parsed[member], type)) {
      throw new AssetRecordCorruptError(assetId, `${member} is missing or has the wrong type`);
    }
  }
  // Every member the retain and claim paths read, down to the projection a claim returns: a value
  // that passes the checks above but throws there (`computeExpiresAt` on an unparseable date,
  // `modalityOf` on a non-string media type) would read as a transient failure and stall the drain.
  for (const member of OPTIONAL_STRING_MEMBERS) {
    if (parsed[member] !== undefined && typeof parsed[member] !== 'string') {
      throw new AssetRecordCorruptError(assetId, `${member} is present but is not a string`);
    }
  }
  if (parsed['byteLength'] !== undefined && typeof parsed['byteLength'] !== 'number') {
    throw new AssetRecordCorruptError(assetId, 'byteLength is present but is not a number');
  }
  if (parsed['rejection'] !== undefined && !isPlainObject(parsed['rejection'])) {
    throw new AssetRecordCorruptError(assetId, 'rejection is present but is not an object');
  }
  if (parsed['retainUntil'] !== undefined && !parsesAsDate(parsed['retainUntil'])) {
    throw new AssetRecordCorruptError(assetId, 'retainUntil is not a date');
  }
  if (!isPlainObject(parsed['provenance']) || typeof parsed['provenance']['kind'] !== 'string') {
    throw new AssetRecordCorruptError(assetId, 'provenance has no string kind');
  }
  for (const reference of parsed['references'] as unknown[]) {
    if (
      !isPlainObject(reference) ||
      typeof reference['holderId'] !== 'string' ||
      typeof reference['until'] !== 'string'
    ) {
      throw new AssetRecordCorruptError(assetId, 'a reference lacks a string holderId or until');
    }
    if (!parsesAsDate(reference['until'])) {
      throw new AssetRecordCorruptError(assetId, 'a reference until is not a date');
    }
  }
  return parsed as unknown as AssetRecord;
}

/**
 * Loads an asset's record, or `undefined` when it has none. Throws {@link AssetRecordCorruptError}
 * for a record that is stored but cannot be read as one.
 */
export async function loadRecord(
  storage: Pick<AssetStorage, 'get'>,
  assetId: string,
): Promise<LoadedRecord | undefined> {
  const raw = await storage.get(KEYS.record(assetId));
  if (raw === null) return undefined;
  const record = parseRecord(raw, assetId);
  return record === undefined ? undefined : { record, raw };
}

export async function createRecord(
  storage: Pick<AssetStorage, 'conditionalBatch'>,
  record: AssetRecord,
): Promise<string> {
  const raw = JSON.stringify(record);
  const key = KEYS.record(record.assetId);
  const committed = await storage.conditionalBatch(
    [{ key, expectedValue: null }],
    [{ type: 'set', key, value: raw }],
  );
  if (!committed) throw new AssetConflictError(key);
  return raw;
}

/** Replaces `previous` with `next` (and applies `extra`) atomically, or throws {@link AssetConflictError}. */
export async function replaceRecord(
  storage: Pick<AssetStorage, 'conditionalBatch'>,
  previous: LoadedRecord,
  next: AssetRecord,
  extra: readonly AssetStorageOperation[] = [],
): Promise<LoadedRecord> {
  const raw = JSON.stringify(next);
  const key = KEYS.record(next.assetId);
  const committed = await storage.conditionalBatch(
    [{ key, expectedValue: previous.raw }],
    [{ type: 'set', key, value: raw }, ...extra],
  );
  if (!committed) throw new AssetConflictError(key);
  return { record: next, raw };
}

// ── Authorization ─────────────────────────────────────────────────────

export function accessOf(
  record: AssetRecord,
  principal: AssetPrincipal,
): 'owner' | 'reader' | undefined {
  if (principal.id === record.ownerId) return 'owner';
  return record.readers.includes(principal.id) ? 'reader' : undefined;
}

/**
 * The persisted resource authorization every operation and both projections
 * enforce. A principal it does not reach is told the asset does not exist.
 */
export function authorize(
  record: AssetRecord | undefined,
  assetId: string,
  principal: AssetPrincipal,
): AssetRecord {
  if (!record || accessOf(record, principal) === undefined) throw new AssetNotFoundError(assetId);
  return record;
}

/** Owner-only operations (deletion, expiry): a reader is told the asset does not exist, like any stranger. */
export function authorizeOwner(
  record: AssetRecord | undefined,
  assetId: string,
  principal: AssetPrincipal,
): AssetRecord {
  if (!record || accessOf(record, principal) !== 'owner') throw new AssetNotFoundError(assetId);
  return record;
}

/** Authorization first, then the privileged capability — never instead of authorization. */
export function authorizePrivileged(
  record: AssetRecord | undefined,
  assetId: string,
  principal: AssetPrincipal,
  operation: string,
): AssetRecord {
  const authorized = authorize(record, assetId, principal);
  if (principal.privileged !== true) throw new AssetAccessDeniedError(assetId, operation);
  return authorized;
}

// ── Retention ─────────────────────────────────────────────────────────

/** The latest instant the floor or any reference keeps the asset; `undefined` (no floor) never expires. */
export function computeExpiresAt(
  record: Pick<AssetRecord, 'retainUntil' | 'references'>,
): string | undefined {
  if (record.retainUntil === undefined) return undefined;
  let latest = Date.parse(record.retainUntil);
  for (const reference of record.references) latest = Math.max(latest, Date.parse(reference.until));
  return new Date(latest).toISOString();
}

// ── Projections ───────────────────────────────────────────────────────

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

export function managedAssetSourceOf(
  record: Pick<AssetRecord, 'assetId' | 'revision'>,
): ManagedAssetSource {
  return { kind: 'managed-asset', assetId: record.assetId, revision: record.revision };
}

function sharedFields(record: AssetRecord) {
  return {
    assetId: record.assetId,
    revision: record.revision,
    state: record.state,
    custody: record.custody,
    digest: record.digest,
    mediaType: record.mediaType ?? record.declaredMediaType,
    modality: record.mediaType ? modalityOf(record.mediaType) : undefined,
    mimeFamily: record.mediaType ? mimeFamilyOf(record.mediaType) : undefined,
    byteLength: record.byteLength,
    owner: record.ownerId,
    provenanceKind: record.provenance.kind,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    expiresAt: computeExpiresAt(record),
    source: managedAssetSourceOf(record),
    rejection: record.rejection,
  };
}

export function toGeneralDescriptor(
  record: AssetRecord,
  principal: AssetPrincipal,
): GeneralAssetDescriptor {
  return deepFreeze({
    projection: 'general',
    ...sharedFields(record),
    authorization: { access: accessOf(record, principal) ?? 'reader' },
    retention: {
      retainUntil: record.retainUntil,
      referenceCount: record.references.length,
      held: record.holds.length > 0,
    },
  });
}

export function toPrivilegedDescriptor(record: AssetRecord): PrivilegedAssetDescriptor {
  return deepFreeze({
    projection: 'privileged',
    ...sharedFields(record),
    authorization: { ownerId: record.ownerId, readers: [...record.readers] },
    retention: {
      retainUntil: record.retainUntil,
      references: record.references.map((reference) => ({ ...reference })),
      holds: record.holds.map((hold) => ({ ...hold })),
    },
    provenance: { ...record.provenance },
    declaredMediaType: record.declaredMediaType,
    media: { ...record.media },
    safety: record.safety.map((verdict) => ({ ...verdict })),
    providerCopies: record.providerCopies.map((copy) => ({ ...copy })),
    expiredAt: record.expiredAt,
    deletedAt: record.deletedAt,
    tombstoneUntil: record.tombstoneUntil,
  });
}

/** The projection a principal receives from an operation that did not name one: privileged only with the capability. */
export function projectFor(
  record: AssetRecord,
  principal: AssetPrincipal,
  projection: AssetProjection = principal.privileged === true ? 'privileged' : 'general',
): AssetDescriptor {
  return projection === 'privileged'
    ? toPrivilegedDescriptor(record)
    : toGeneralDescriptor(record, principal);
}
