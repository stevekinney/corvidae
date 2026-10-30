/**
 * COR-772 — the durable half of Bureau's parent-child topology.
 *
 * Four record families share Bureau's conditional key-value store
 * (`BureauOptions.persistence`/`storage`, or an in-memory store for an
 * ephemeral bureau):
 *
 * - **Child records** — one per child run, keyed by the child's stable run
 *   identifier, plus a parent index so a parent's children list without a
 *   scan. Registration is create-if-absent, so a second registration of the
 *   same child is refused rather than silently starting a second workflow.
 *   Every later write is a compare-and-swap against the exact stored text
 *   and must name the revision it read, so a stale writer — a monitor from
 *   a process that lost the race, or a replay after a restart — is rejected
 *   instead of overwriting a newer transition.
 * - **Delegation grants** (COR-336) — the signed authority record for each
 *   child. Accept, revoke, expire, and policy change are durable transitions
 *   by COR-336's durability classes, so the grant itself lives here.
 * - **The budget ledger** — one append-only entry per reserve or release of
 *   a grant's `concurrentChildren`/`totalDescendants` budget, keyed by the
 *   dispatch attempt that made it, so the same reservation or release can
 *   never be recorded twice and one attempt can never release another's.
 *   Live counters are process-local (COR-336: use and exhaustion are
 *   ephemeral); this ledger is what a restarted process reconciles them
 *   from.
 *
 * - **Peer call records** (COR-1670) — one per durable A2A peer call, keyed by
 *   the calling run and the tool call's operation key. It names the peer task
 *   the call started, so a replay of the same tool call after a restart follows
 *   that task instead of sending again. Create-if-absent; deleted with the run.
 *
 * Every read fails closed: a record, grant, or ledger entry that does not
 * decode to its exact shape is treated as absent and reported through
 * `onCorrupt`, never trusted as a partial value.
 */

import {
  type DelegationGrant,
  isDelegationGrant,
  validateStoredResponseParts,
} from '@lostgradient/operative';
import type { ConditionalTextValueStore } from '@lostgradient/storage';
import type { MultiModalContent } from 'conversationalist';

// ---------------------------------------------------------------------------
// Record shapes
// ---------------------------------------------------------------------------

/** A child's lifecycle status. Every status but `'running'` is terminal and absorbing. */
export type BureauChildStatus = 'running' | 'completed' | 'failed' | 'aborted';

export type BureauChildTerminalStatus = Exclude<BureauChildStatus, 'running'>;

/**
 * What Bureau does to a still-running child when its parent is cancelled.
 * `'cascade'` cancels the child (and, through the child's own policy, its
 * descendants); `'detach'` leaves it running, still addressable by the
 * parent's run identifier. Neither is implemented by sharing the parent's
 * abort signal: a Bureau-dispatched child never receives it.
 */
export type BureauChildParentCancellation = 'cascade' | 'detach';

/**
 * Where the child actually runs. A `'durable'` child is a Weft workflow a
 * restarted process can find and reattach to; a `'process-local'` child
 * dies with its process, and recovery records it as failed.
 */
export type BureauChildWorkflowIdentity =
  | { readonly kind: 'durable'; readonly workflowType: string; readonly workflowId: string }
  | { readonly kind: 'process-local' };

/** How a terminal child ended. Every field is optional because not every end has one. */
export interface BureauChildOutcome {
  /** The child run's own `finishReason`, when it produced a result. */
  readonly finishReason?: string | undefined;
  /** The child's final text, when it produced a result. */
  readonly content?: string | undefined;
  /**
   * The child's run-wide output parts (COR-713), when it produced a result; generated media is a
   * managed-asset reference, never inline bytes.
   */
  readonly parts?: readonly MultiModalContent[] | undefined;
  /** Why the child ended without a clean result (an error, an abort reason, recovery). */
  readonly reason?: string | undefined;
}

/**
 * The persisted child record's schema version. Version 2 (COR-713) adds `outcome.parts`; a
 * version 1 record fails with {@link UnsupportedChildRecordVersionError}.
 */
export const CHILD_RECORD_SCHEMA_VERSION = 2 as const;

/** Raised when a stored child record is at a schema version this build does not read. */
export class UnsupportedChildRecordVersionError extends Error {
  readonly version: number;

  constructor(version: number) {
    super(
      `Unsupported child topology record schema version ${version}: this build reads version ${CHILD_RECORD_SCHEMA_VERSION}.`,
    );
    this.name = 'UnsupportedChildRecordVersionError';
    this.version = version;
  }
}

/**
 * COR-1955 — the chat a child's delegation chain started in, stamped on the child's record when it
 * is dispatched, so the child's permission mode is read from the chat itself and never from an
 * ancestor whose task and run records retention may have removed. A child inherits it from its
 * parent's record; a root that belongs to no chat stamps nothing.
 */
export interface BureauChildChat {
  /** The root chat's session identifier. */
  readonly contextId: string;
  /** The incarnation of that session the chain started in: a deleted or recreated chat differs. */
  readonly incarnation: string;
}

/** The durable description of one parent-child relationship. */
export interface BureauChildRecord {
  readonly schemaVersion: typeof CHILD_RECORD_SCHEMA_VERSION;
  readonly parentRunId: string;
  readonly childRunId: string;
  readonly parentAgentName: string;
  readonly childAgentName: string;
  readonly status: BureauChildStatus;
  /** Starts at `1`; every accepted write advances it by exactly one. */
  readonly revision: number;
  /** Epoch milliseconds, from Bureau's runtime clock. */
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly settledAt?: number | undefined;
  /** When boot recovery last reattached this child. */
  readonly reattachedAt?: number | undefined;
  /** How many times boot recovery has reattached this child. */
  readonly recoveries: number;
  readonly workflow: BureauChildWorkflowIdentity;
  readonly parentCancellation: BureauChildParentCancellation;
  /**
   * The principal that owns this child: the parent run's, or the
   * dispatching principal when the parent had none.
   */
  readonly principal?: string | undefined;
  /** This child's own delegation grant. */
  readonly grantId?: string | undefined;
  /** The parent's grant this child's budget was reserved against. */
  readonly parentGrantId?: string | undefined;
  readonly outcome?: BureauChildOutcome | undefined;
  /**
   * The chat the delegation chain started in (COR-1955), absent for a chain whose root belongs to no
   * chat and for a record written before it was stamped. Optional, so the schema version stays.
   */
  readonly chat?: BureauChildChat | undefined;
}

/** The two grant dimensions a child dispatch reserves against its parent's grant. */
export type DelegationLedgerDimension = 'concurrentChildren' | 'totalDescendants';

/** One reserve or release against a grant's budget. */
export interface DelegationLedgerEntry {
  readonly grantId: string;
  /** The child the reservation was made for. */
  readonly childRunId: string;
  /**
   * The dispatch attempt the reservation belongs to: the grant that attempt
   * issued the child, minted afresh by every attempt. Two attempts at the
   * same child identifier — one of which loses the registration race —
   * therefore hold distinct reservations, and each releases only its own.
   */
  readonly childGrantId: string;
  readonly kind: 'reserve' | 'release';
  readonly dimension: DelegationLedgerDimension;
  readonly amount: number;
  readonly at: number;
}

/**
 * The peer task one durable peer call started (COR-1670). The key is the calling run plus the
 * tool call's operation key; the rest is what a replay needs to follow the task.
 */
export interface BureauPeerCallRecord {
  readonly parentRunId: string;
  /** The tool call's durable operation key, stable across a replay of the same call. */
  readonly operationKey: string;
  /** The task's identifier on the peer. */
  readonly taskId: string;
  /** The task's context identifier on the peer. */
  readonly contextId: string;
  /**
   * A digest of the request the call sent. The operation key is a position in a run, not a
   * request, so a replay compares this before it follows the task.
   */
  readonly requestDigest: string;
  /** Epoch milliseconds, from Bureau's runtime clock. */
  readonly recordedAt: number;
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

export const CHILD_RECORD_KEY_PREFIX = 'bureau-child:record:';
export const CHILD_PARENT_INDEX_KEY_PREFIX = 'bureau-child:parent:';
export const DELEGATION_GRANT_KEY_PREFIX = 'bureau-delegation:grant:';
export const DELEGATION_LEDGER_KEY_PREFIX = 'bureau-delegation:ledger:';
export const PEER_CALL_KEY_PREFIX = 'bureau-peer-call:record:';

// `encodeURIComponent` escapes `:`, so the separators between encoded
// segments stay unambiguous whatever characters an identifier contains.
const encode = encodeURIComponent;

function recordKey(childRunId: string): string {
  return `${CHILD_RECORD_KEY_PREFIX}${encode(childRunId)}`;
}

function parentIndexPrefix(parentRunId: string): string {
  return `${CHILD_PARENT_INDEX_KEY_PREFIX}${encode(parentRunId)}:`;
}

function parentIndexKey(parentRunId: string, childRunId: string): string {
  return `${parentIndexPrefix(parentRunId)}${encode(childRunId)}`;
}

function grantKey(grantId: string): string {
  return `${DELEGATION_GRANT_KEY_PREFIX}${encode(grantId)}`;
}

function ledgerPrefix(grantId: string): string {
  return `${DELEGATION_LEDGER_KEY_PREFIX}${encode(grantId)}:`;
}

function ledgerKey(entry: DelegationLedgerEntry): string {
  return `${ledgerPrefix(entry.grantId)}${encode(entry.childRunId)}:${encode(entry.childGrantId)}:${entry.kind}:${entry.dimension}`;
}

function peerCallPrefix(parentRunId: string): string {
  return `${PEER_CALL_KEY_PREFIX}${encode(parentRunId)}:`;
}

function peerCallKey(parentRunId: string, operationKey: string): string {
  return `${peerCallPrefix(parentRunId)}${encode(operationKey)}`;
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

const STATUSES: readonly string[] = ['running', 'completed', 'failed', 'aborted'];
const PARENT_CANCELLATIONS: readonly string[] = ['cascade', 'detach'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isOptional(value: unknown, type: 'string' | 'number'): boolean {
  return value === undefined || typeof value === type;
}

function isWorkflowIdentity(value: unknown): value is BureauChildWorkflowIdentity {
  if (!isRecord(value)) return false;
  if (value['kind'] === 'process-local') return true;
  return (
    value['kind'] === 'durable' &&
    typeof value['workflowType'] === 'string' &&
    typeof value['workflowId'] === 'string'
  );
}

function isOutcome(value: unknown): value is BureauChildOutcome {
  return (
    isRecord(value) &&
    isOptional(value['finishReason'], 'string') &&
    isOptional(value['content'], 'string') &&
    (value['parts'] === undefined || validateStoredResponseParts(value['parts']).valid) &&
    isOptional(value['reason'], 'string')
  );
}

function isChildRecord(value: unknown): value is BureauChildRecord {
  if (!isRecord(value)) return false;
  const revision = value['revision'];
  const recoveries = value['recoveries'];
  return (
    value['schemaVersion'] === CHILD_RECORD_SCHEMA_VERSION &&
    ['parentRunId', 'childRunId', 'parentAgentName', 'childAgentName'].every(
      (field) => typeof value[field] === 'string',
    ) &&
    STATUSES.includes(value['status'] as string) &&
    typeof revision === 'number' &&
    Number.isInteger(revision) &&
    revision >= 1 &&
    typeof value['createdAt'] === 'number' &&
    typeof value['updatedAt'] === 'number' &&
    isOptional(value['settledAt'], 'number') &&
    isOptional(value['reattachedAt'], 'number') &&
    typeof recoveries === 'number' &&
    Number.isInteger(recoveries) &&
    recoveries >= 0 &&
    isWorkflowIdentity(value['workflow']) &&
    PARENT_CANCELLATIONS.includes(value['parentCancellation'] as string) &&
    isOptional(value['principal'], 'string') &&
    isOptional(value['grantId'], 'string') &&
    isOptional(value['parentGrantId'], 'string') &&
    (value['outcome'] === undefined || isOutcome(value['outcome'])) &&
    (value['chat'] === undefined || isChildChat(value['chat']))
  );
}

function isChildChat(value: unknown): value is BureauChildChat {
  return (
    isRecord(value) &&
    typeof value['contextId'] === 'string' &&
    typeof value['incarnation'] === 'string'
  );
}

function isLedgerEntry(value: unknown): value is DelegationLedgerEntry {
  return (
    isRecord(value) &&
    typeof value['grantId'] === 'string' &&
    typeof value['childRunId'] === 'string' &&
    typeof value['childGrantId'] === 'string' &&
    (value['kind'] === 'reserve' || value['kind'] === 'release') &&
    (value['dimension'] === 'concurrentChildren' || value['dimension'] === 'totalDescendants') &&
    typeof value['amount'] === 'number' &&
    typeof value['at'] === 'number'
  );
}

function isPeerCallRecord(value: unknown): value is BureauPeerCallRecord {
  return (
    isRecord(value) &&
    typeof value['parentRunId'] === 'string' &&
    typeof value['operationKey'] === 'string' &&
    typeof value['taskId'] === 'string' &&
    value['taskId'] !== '' &&
    typeof value['contextId'] === 'string' &&
    typeof value['requestDigest'] === 'string' &&
    value['requestDigest'] !== '' &&
    typeof value['recordedAt'] === 'number'
  );
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export type ChildRegistration =
  | { readonly status: 'registered' }
  /** `existing` is absent when the record already stored there is unreadable. */
  | { readonly status: 'duplicate'; readonly existing?: BureauChildRecord };

export type ChildRecordUpdate =
  | { readonly status: 'updated'; readonly record: BureauChildRecord }
  /** `current` is absent when no readable record is stored any more. */
  | { readonly status: 'stale'; readonly current?: BureauChildRecord };

export type DelegationGrantLoad =
  | { readonly status: 'found'; readonly grant: DelegationGrant }
  | { readonly status: 'missing' }
  | { readonly status: 'corrupt' };

export type PeerCallRecording =
  | { readonly status: 'recorded' }
  /** `existing` is absent when the record already stored there is unreadable. */
  | { readonly status: 'exists'; readonly existing?: BureauPeerCallRecord };

export interface ChildTopologyStore {
  /** Create-if-absent. Writes the record and its parent index atomically. */
  register(record: BureauChildRecord): Promise<ChildRegistration>;
  get(childRunId: string): Promise<BureauChildRecord | undefined>;
  listByParent(parentRunId: string): Promise<BureauChildRecord[]>;
  listAll(): Promise<BureauChildRecord[]>;
  /**
   * Replaces `expected` with `next`, stamping `next.revision` as
   * `expected.revision + 1`. Accepted only when the stored record is still
   * exactly the one at `expected.revision`; otherwise `stale`, carrying
   * whatever is stored now.
   */
  update(expected: BureauChildRecord, next: BureauChildRecord): Promise<ChildRecordUpdate>;
  /** Create-if-absent. `false` when a grant with this id already exists. */
  issueGrant(grant: DelegationGrant): Promise<boolean>;
  loadGrant(grantId: string): Promise<DelegationGrantLoad>;
  /** Compare-and-swap on the stored grant's signature. */
  replaceGrant(expected: DelegationGrant, next: DelegationGrant): Promise<boolean>;
  /** Idempotent. `false` when this exact reserve or release was already recorded. */
  appendLedgerEntry(entry: DelegationLedgerEntry): Promise<boolean>;
  listLedger(grantId: string): Promise<DelegationLedgerEntry[]>;
  /** Create-if-absent: the record a durable peer call keeps for its operation key. */
  recordPeerCall(record: BureauPeerCallRecord): Promise<PeerCallRecording>;
  /** The record for `operationKey`, or `undefined` when none is stored or it is unreadable. */
  getPeerCall(parentRunId: string, operationKey: string): Promise<BureauPeerCallRecord | undefined>;
  /** Removes every peer call record of `parentRunId`. Idempotent. */
  deletePeerCalls(parentRunId: string): Promise<void>;
  /**
   * COR-1934 — removes a child's record, with its outcome (the child's final text and parts) and its
   * entry in its parent's index. Idempotent. The grant and ledger entries stay: they hold ids and
   * amounts, and no text.
   */
  remove(childRunId: string): Promise<void>;
}

export interface ChildTopologyStoreOptions {
  /** Called once per unreadable key encountered. Defaults to a no-op. */
  readonly onCorrupt?: ((key: string) => void) | undefined;
  /**
   * Called once per record a list skipped because it was written at another schema version
   * (COR-713). A list never fails for one such record, so the rest still load; `get` and `update`
   * still throw {@link UnsupportedChildRecordVersionError} for it. Defaults to a no-op.
   */
  readonly onUnsupported?:
    ((key: string, error: UnsupportedChildRecordVersionError) => void) | undefined;
}

export function createChildTopologyStore(
  kv: ConditionalTextValueStore,
  options: ChildTopologyStoreOptions = {},
): ChildTopologyStore {
  const onCorrupt = options.onCorrupt ?? (() => {});
  const onUnsupported = options.onUnsupported ?? (() => {});

  async function readRecord(
    key: string,
  ): Promise<{ raw: string; record: BureauChildRecord | undefined } | undefined> {
    const raw = await kv.get(key);
    if (raw === null) return undefined;
    const parsed = parseJson(raw);
    // COR-713: a record written at an older schema version is not corrupt and is not read as
    // current; it fails explicitly, so an operator sees the version rather than a vanished child.
    if (isRecord(parsed) && typeof parsed['schemaVersion'] === 'number') {
      if (parsed['schemaVersion'] !== CHILD_RECORD_SCHEMA_VERSION) {
        throw new UnsupportedChildRecordVersionError(parsed['schemaVersion']);
      }
    }
    if (!isChildRecord(parsed)) {
      onCorrupt(key);
      return { raw, record: undefined };
    }
    return { raw, record: parsed };
  }

  async function get(childRunId: string): Promise<BureauChildRecord | undefined> {
    const stored = await readRecord(recordKey(childRunId));
    return stored?.record;
  }

  async function readRecords(keys: readonly string[]): Promise<BureauChildRecord[]> {
    // One record at another schema version is skipped and reported, not allowed to reject the
    // whole list: recovery lists every child, and a single old record would otherwise leave every
    // other child unrecovered for the life of the process.
    const stored = await Promise.all(
      keys.map(async (key) => {
        try {
          return await readRecord(key);
        } catch (error) {
          if (!(error instanceof UnsupportedChildRecordVersionError)) throw error;
          onUnsupported(key, error);
          return undefined;
        }
      }),
    );
    return stored
      .map((entry) => entry?.record)
      .filter((record): record is BureauChildRecord => record !== undefined);
  }

  async function readPeerCall(key: string): Promise<BureauPeerCallRecord | undefined> {
    const raw = await kv.get(key);
    if (raw === null) return undefined;
    const parsed = parseJson(raw);
    if (isPeerCallRecord(parsed)) return parsed;
    onCorrupt(key);
    return undefined;
  }

  return {
    async register(record) {
      const key = recordKey(record.childRunId);
      const committed = await kv.conditionalBatch(
        [{ key, expectedValue: null }],
        [
          { type: 'set', key, value: JSON.stringify(record) },
          { type: 'set', key: parentIndexKey(record.parentRunId, record.childRunId), value: '1' },
        ],
      );
      if (committed) return { status: 'registered' };
      const existing = await get(record.childRunId);
      return existing === undefined ? { status: 'duplicate' } : { status: 'duplicate', existing };
    },
    get,
    async listByParent(parentRunId) {
      const prefix = parentIndexPrefix(parentRunId);
      const indexKeys = await kv.list(prefix);
      const records = await readRecords(
        indexKeys.map((key) => recordKey(decodeURIComponent(key.slice(prefix.length)))),
      );
      // Defense in depth: the index is a lookup aid, never the authority on
      // ownership — only the record itself says who its parent is.
      return records.filter((record) => record.parentRunId === parentRunId);
    },
    async listAll() {
      return readRecords(await kv.list(CHILD_RECORD_KEY_PREFIX));
    },
    async update(expected, next) {
      if (next.childRunId !== expected.childRunId) {
        throw new Error(
          `Bureau child topology: cannot change a child record's identity (${expected.childRunId} → ${next.childRunId}).`,
        );
      }
      const key = recordKey(expected.childRunId);
      const stored = await readRecord(key);
      if (stored?.record === undefined) return { status: 'stale' };
      if (stored.record.revision !== expected.revision) {
        return { status: 'stale', current: stored.record };
      }
      const record: BureauChildRecord = { ...next, revision: expected.revision + 1 };
      const committed = await kv.conditionalBatch(
        [{ key, expectedValue: stored.raw }],
        [{ type: 'set', key, value: JSON.stringify(record) }],
      );
      if (committed) return { status: 'updated', record };
      const current = await get(expected.childRunId);
      return current === undefined ? { status: 'stale' } : { status: 'stale', current };
    },
    async issueGrant(grant) {
      const key = grantKey(grant.id);
      return kv.conditionalBatch(
        [{ key, expectedValue: null }],
        [{ type: 'set', key, value: JSON.stringify(grant) }],
      );
    },
    async loadGrant(grantId) {
      const key = grantKey(grantId);
      const raw = await kv.get(key);
      if (raw === null) return { status: 'missing' };
      const parsed = parseJson(raw);
      if (!isDelegationGrant(parsed)) {
        onCorrupt(key);
        return { status: 'corrupt' };
      }
      return { status: 'found', grant: parsed };
    },
    async replaceGrant(expected, next) {
      const key = grantKey(expected.id);
      const raw = await kv.get(key);
      if (raw === null) return false;
      const parsed = parseJson(raw);
      if (!isDelegationGrant(parsed) || parsed.signature !== expected.signature) return false;
      return kv.conditionalBatch(
        [{ key, expectedValue: raw }],
        [{ type: 'set', key, value: JSON.stringify(next) }],
      );
    },
    async appendLedgerEntry(entry) {
      const key = ledgerKey(entry);
      return kv.conditionalBatch(
        [{ key, expectedValue: null }],
        [{ type: 'set', key, value: JSON.stringify(entry) }],
      );
    },
    async recordPeerCall(record) {
      const key = peerCallKey(record.parentRunId, record.operationKey);
      const committed = await kv.conditionalBatch(
        [{ key, expectedValue: null }],
        [{ type: 'set', key, value: JSON.stringify(record) }],
      );
      if (committed) return { status: 'recorded' };
      const existing = await readPeerCall(key);
      return existing === undefined ? { status: 'exists' } : { status: 'exists', existing };
    },
    getPeerCall: (parentRunId, operationKey) =>
      readPeerCall(peerCallKey(parentRunId, operationKey)),
    async remove(childRunId) {
      const key = recordKey(childRunId);
      // A record this build cannot read names no parent to read, so only the record goes.
      const parentRunId = await readRecord(key).then(
        (stored) => stored?.record?.parentRunId,
        () => undefined,
      );
      await kv.delete(key);
      if (parentRunId !== undefined) await kv.delete(parentIndexKey(parentRunId, childRunId));
    },
    async deletePeerCalls(parentRunId) {
      // The trailing separator keeps `run-1` from matching the records of `run-10`.
      await kv.deletePrefix(peerCallPrefix(parentRunId));
    },
    async listLedger(grantId) {
      const keys = await kv.list(ledgerPrefix(grantId));
      const entries = await Promise.all(
        keys.map(async (key) => {
          const raw = await kv.get(key);
          const parsed = raw === null ? undefined : parseJson(raw);
          if (isLedgerEntry(parsed)) return parsed;
          onCorrupt(key);
          return undefined;
        }),
      );
      return entries.filter((entry): entry is DelegationLedgerEntry => entry !== undefined);
    },
  };
}
