/**
 * COR-424 — durable external command receipts and retry-safe run creation.
 *
 * ## The ledger
 *
 * A command ledger entry is keyed by `(callerId, target, requestId,
 * operationVersion)`: the authenticated caller, the published agent the
 * command addresses, the idempotency key that caller supplied on the request
 * itself, and the version of the operation's contract. One request id sent to
 * two agents is therefore two commands, not a conflict. Each entry stores a
 * digest of the command's payload beside it.
 *
 * - An exact retry (same identity, same digest) returns the existing entry
 *   and writes nothing, so the original stays untouched and, while it is
 *   still pending, completable.
 * - A retry whose identity matches but whose digest does not is a
 *   {@link BureauLedgerConflictError} with `reason: 'payload-mismatch'`. The
 *   conflicting attempt is recorded under its own key as a separate failed
 *   entry; the original is never read-modify-written by it.
 *
 * Entries live in the same conditional text-value store the Bureau keeps its
 * sessions in, so they share that store's durability. Every write is a
 * compare-and-swap, so two attempts racing for one identity cannot both
 * claim it.
 *
 * **Retention.** A binding is held for `terminalRetentionMs` (24 hours by
 * default, the same as Weft's mailbox `terminalRetentionMs`) after its
 * command settles, measured on the injected runtime clock. A command still in
 * progress holds its binding however old it is. Once the window has passed,
 * {@link CommandLedger.locate} reports the binding `expired`, and the next
 * claim of the same identity, with any payload, replaces it with a fresh
 * pending entry and deletes its conflict records in the same compare-and-swap.
 * Until then those conflict records are ignored: they belong to a binding
 * that no longer holds. {@link CommandLedger.prune} deletes expired bindings
 * and their conflict records, after which a query reports `not-found`. Every
 * rule below holds only while a binding is retained.
 *
 * An unreadable entry fails closed. Treating it as absent would let a retry
 * claim the identity afresh and create the very duplicate this ledger exists
 * to prevent.
 *
 * ## Run creation
 *
 * {@link createRunCreationLedger} applies the ledger to `tasks.start`. The
 * identity's target is the published agent the run is for, and its request
 * id is the caller-supplied `commandId`, because no run exists to
 * key on until the command has run. A claim carries the run and session
 * identifiers minted for the attempt, so a retry that finds a pending entry
 * knows which run to look for instead of starting another:
 *
 * - In the process that claimed it, a retry waits for the in-flight attempt
 *   and receives its outcome, including its failure.
 * - Anywhere else (after a restart), a retry observes the run. When the run
 *   exists, live in this process or in the durable engine, the retry
 *   completes the entry with a receipt carrying the status it observed, so
 *   every later retry receives that same receipt. When the run never
 *   started, the retry reports it as `pending` and writes nothing: without
 *   a lease, a crashed claimant cannot be told apart from a slow one, so the
 *   request id stays bound to the claimed run until its retention window,
 *   measured from the claim, has passed. A caller that needs the run sooner
 *   uses a new request id.
 *
 * A completed entry carries the {@link RunCreationReceipt} and the summary
 * returned to the original caller. A retry receives that original receipt
 * unchanged, alongside the run as it stands now.
 *
 * A run-creation binding's retention window starts when its run settles, so
 * a delayed retry of a long-running run never starts a second one: a run
 * still in progress, or a claim this process is still settling, holds the
 * binding however old it is. The settlement time is the run's own: the
 * runtime-clock timestamp of its terminal action, which this process's run
 * store keeps for every run it ran or reattached. Nobody has to observe the
 * run in time for its window to start there. Only a run that settled where
 * this process cannot see when, one that ran before a restart and was not
 * reattached, is anchored at the first retry, receipt query
 * ({@link RunCreationLedger.locate}), or prune that observes it settled, and
 * that moment is recorded as `settledAt`. A claim whose run never started,
 * or whose run no longer exists, is measured from its own latest timestamp.
 */
import { sha256HexSync } from '@lostgradient/cryptography';
import type { RuntimeClock, RuntimeIdentifiers, RuntimeServices } from '@lostgradient/lifecycle';
import {
  type ConditionalTextValueStore,
  encodeStorageKeyComponent,
  type TextValueStoreBatchOperation,
  type WorkflowState,
} from '@lostgradient/weft';

import type { RunSummary } from './types';

/**
 * The version of the task-start command contract the ledger keys on. It is part of the ledger key,
 * so a receipt recorded under an earlier version (`bureau.run-creation.v1`, whose digest covered
 * the request's message, rows, session, system prompt, and step and token caps) is never read: a
 * retry of such a request starts a fresh task.
 */
export const RUN_CREATION_OPERATION_VERSION = 'bureau.task-start.v2';

/** Key prefix for every command-ledger record in the Bureau's text-value store. */
const COMMAND_LEDGER_KEY_PREFIX = 'command-ledger:v1';

/** Bounds the compare-and-swap loop against concurrent claimants of one identity. */
const COMMAND_LEDGER_MAX_CAS_ATTEMPTS = 10;

/**
 * How long a settled command's binding is retained by default: 24 hours, the
 * same as Weft's mailbox and outbox `terminalRetentionMs`.
 */
export const COMMAND_LEDGER_DEFAULT_TERMINAL_RETENTION_MS = 86_400_000;

/** Who issued a command, which command it was, and under which contract version. */
export interface CommandLedgerIdentity {
  readonly callerId: string;
  /** The resource the command addresses: for run creation, the published agent's name. */
  readonly target: string;
  readonly requestId: string;
  readonly operationVersion: string;
}

/** An entry whose command has been claimed but not yet acknowledged. */
export interface CommandLedgerPendingEntry<TClaim> {
  readonly state: 'pending';
  readonly identity: CommandLedgerIdentity;
  readonly payloadDigest: string;
  readonly claimedAt: string;
  readonly claim: TClaim;
}

/** An entry whose command completed and whose result is recorded for retries. */
export interface CommandLedgerCompletedEntry<TClaim, TResult> {
  readonly state: 'completed';
  readonly identity: CommandLedgerIdentity;
  readonly payloadDigest: string;
  readonly claimedAt: string;
  readonly claim: TClaim;
  readonly completedAt: string;
  readonly result: TResult;
  /**
   * When the command's effect settled, once the ledger has recorded it. The
   * retention window of a command whose effect outlives its acknowledgement,
   * such as a run, starts here.
   */
  readonly settledAt?: string | undefined;
}

/** The entry an identity resolves to. */
export type CommandLedgerEntry<TClaim, TResult> =
  CommandLedgerPendingEntry<TClaim> | CommandLedgerCompletedEntry<TClaim, TResult>;

/** A conflicting attempt, recorded beside — never over — the entry it conflicted with. */
export interface CommandLedgerConflictEntry {
  readonly state: 'failed';
  readonly identity: CommandLedgerIdentity;
  readonly conflictId: string;
  readonly reason: 'payload-mismatch';
  /** The digest of the payload the conflicting attempt carried. */
  readonly payloadDigest: string;
  /** The digest recorded on the original entry. */
  readonly originalPayloadDigest: string;
  /** When the original entry was claimed: which binding of the identity this conflicted with. */
  readonly originalClaimedAt: string;
  readonly recordedAt: string;
}

/**
 * Where an identity's binding stands: `retained` while it still binds the
 * identity, `expired` once its retention window has passed (until a claim
 * replaces it or a prune deletes it), and `not-found` when there is none.
 */
export type CommandLedgerLocation<TClaim, TResult> =
  | { readonly state: 'not-found' }
  | { readonly state: 'retained'; readonly entry: CommandLedgerEntry<TClaim, TResult> }
  | {
      readonly state: 'expired';
      readonly entry: CommandLedgerEntry<TClaim, TResult>;
      /** When the retention window closed. */
      readonly expiredAt: string;
    };

/** What one {@link CommandLedger.prune} pass deleted. */
export interface CommandLedgerPruneResult {
  readonly entries: number;
  readonly conflicts: number;
}

/** What a claim found: a fresh entry this call wrote, or the entry already there. */
export type CommandLedgerClaimOutcome<TClaim, TResult> =
  | { readonly outcome: 'claimed'; readonly entry: CommandLedgerPendingEntry<TClaim> }
  | { readonly outcome: 'existing'; readonly entry: CommandLedgerEntry<TClaim, TResult> };

/**
 * A command reused an identity with a different payload. Deliberately not a
 * `BureauError`: that class's `CONFLICT` code reports unrelated state
 * conflicts, and a caller handling a reused idempotency key needs the key and
 * the reason rather than a generic code.
 */
export class BureauLedgerConflictError extends Error {
  /** The caller-supplied idempotency key that was reused. */
  readonly requestId: string;
  readonly reason: 'payload-mismatch';
  /** Identifies the failed entry recording this attempt. */
  readonly conflictId: string;
  /**
   * When the entry this attempt conflicted with was claimed: which binding of
   * the identity it conflicted with.
   */
  readonly originalClaimedAt: string | undefined;
  /**
   * The receipt the original command was issued, when it has one. A
   * run-creation conflict carries it once the original entry is completed;
   * an original still pending has issued no receipt yet.
   */
  readonly originalReceipt: RunCreationReceipt | undefined;

  constructor(
    requestId: string,
    conflictId: string,
    options: {
      readonly originalClaimedAt?: string | undefined;
      readonly originalReceipt?: RunCreationReceipt | undefined;
    } = {},
  ) {
    super(
      `Request "${requestId}" was already used for a command with a different payload; ` +
        'retry with the original payload or use a new request id.',
    );
    this.name = 'BureauLedgerConflictError';
    this.requestId = requestId;
    this.reason = 'payload-mismatch';
    this.conflictId = conflictId;
    this.originalClaimedAt = options.originalClaimedAt;
    this.originalReceipt = options.originalReceipt;
  }
}

/**
 * A run was created and durably started, but the ledger could not record its
 * receipt. Unlike any other start failure, the run exists: `runId` names it.
 * Bureau's `tasks.start` aborts it, since the caller that receives this error
 * holds no handle to it, and retrying the same request observes it and
 * records its receipt rather than creating another run.
 */
export class RunCreationReceiptUnrecordedError extends Error {
  /** The caller-supplied idempotency key whose receipt was not recorded. */
  readonly requestId: string;
  /** The run the request created. */
  readonly runId: string;

  constructor(requestId: string, runId: string, cause: unknown) {
    super(
      `Run "${runId}" was created for request "${requestId}", but its receipt was not ` +
        'recorded; retry the request to obtain it.',
      { cause },
    );
    this.name = 'RunCreationReceiptUnrecordedError';
    this.requestId = requestId;
    this.runId = runId;
  }
}

/** The ledger's operations over one store. */
export interface CommandLedger<TClaim, TResult> {
  /**
   * Claim `identity` for a command whose payload digests to `payloadDigest`.
   * Resolves `claimed` when this call wrote a new pending entry, replacing an
   * expired binding if there was one, and `existing` when a retained entry
   * with the same digest was already there. Rejects with
   * {@link BureauLedgerConflictError}, after recording the attempt, when a
   * retained entry's digest differs.
   */
  claim(
    identity: CommandLedgerIdentity,
    payloadDigest: string,
    claim: TClaim,
  ): Promise<CommandLedgerClaimOutcome<TClaim, TResult>>;
  /**
   * Record `result` on the pending entry this ledger handed back from `claim`.
   * Resolves with the completed entry as stored: the one this call wrote, or,
   * when another attempt already completed the same claim, that one, whose
   * result then wins. Rejects when the stored entry is neither.
   */
  complete(
    entry: CommandLedgerPendingEntry<TClaim>,
    result: TResult,
    options?: { readonly settledAt?: string | undefined },
  ): Promise<CommandLedgerCompletedEntry<TClaim, TResult>>;
  /**
   * Record, once, that a completed command's effect settled at `settledAt`,
   * so its retention window starts there. Resolves with the entry as stored;
   * an entry already settled keeps its first `settledAt`. Resolves
   * `undefined`, writing nothing, when the stored entry is no longer this
   * completed claim.
   */
  settle(
    entry: CommandLedgerCompletedEntry<TClaim, TResult>,
    settledAt: string,
  ): Promise<CommandLedgerCompletedEntry<TClaim, TResult> | undefined>;
  /**
   * Remove a pending entry whose command produced no effect, so a retry claims
   * afresh. Resolves `false`, removing nothing, when the stored entry is no
   * longer exactly `entry`.
   */
  release(entry: CommandLedgerPendingEntry<TClaim>): Promise<boolean>;
  /** The stored entry, retained or expired, without applying retention. */
  read(identity: CommandLedgerIdentity): Promise<CommandLedgerEntry<TClaim, TResult> | undefined>;
  /** Where the identity's binding stands, with retention applied. */
  locate(identity: CommandLedgerIdentity): Promise<CommandLedgerLocation<TClaim, TResult>>;
  /** The conflicts recorded against the identity's binding while it is retained; none once it has expired. */
  listConflicts(identity: CommandLedgerIdentity): Promise<readonly CommandLedgerConflictEntry[]>;
  /**
   * Delete every expired binding with its conflict records, and conflict
   * records whose binding is gone and whose own window has passed.
   */
  prune(): Promise<CommandLedgerPruneResult>;
  /**
   * The claim of every binding the ledger still stores, expired ones
   * included: an expired binding stays stored until {@link prune} deletes it,
   * and so still names its claim. Rejects when a stored entry is unreadable,
   * because its claim cannot be ruled out.
   */
  listClaims(): Promise<readonly TClaim[]>;
}

export interface CreateCommandLedgerOptions<TClaim = unknown, TResult = unknown> {
  readonly kv: ConditionalTextValueStore;
  /**
   * The key prefix this ledger's entries and conflict records live under.
   * Defaults to the run-creation ledger's. A ledger for another command gives
   * its own, so neither ledger's pruning, claim listing, or reads see the
   * other's entries.
   */
  readonly keyPrefix?: string | undefined;
  /** The runtime clock: every timestamp the ledger records, and every expiry it decides. */
  readonly clock: Pick<RuntimeClock, 'now' | 'nowISO'>;
  /** Mints the id of each recorded conflict. */
  readonly nextConflictId: () => string;
  /**
   * How long a binding is retained after its command settles, in
   * milliseconds. A positive integer; default
   * {@link COMMAND_LEDGER_DEFAULT_TERMINAL_RETENTION_MS} (24 hours). A function is read each time
   * a binding's window is measured, so a change applies from then on.
   */
  readonly terminalRetentionMs?: number | (() => number | undefined) | undefined;
  /**
   * When `entry`'s retention window starts, in epoch milliseconds, or
   * `undefined` while its command is still in progress, which holds the
   * binding. Consulted only once the window measured from the entry's latest
   * recorded timestamp has passed, so it must never answer earlier than that.
   * By default the window starts at that timestamp.
   */
  readonly retentionStart?:
    ((entry: CommandLedgerEntry<TClaim, TResult>) => Promise<number | undefined>) | undefined;
}

function identityKeySuffix(identity: CommandLedgerIdentity): string {
  return [identity.callerId, identity.target, identity.requestId, identity.operationVersion]
    .map(encodeStorageKeyComponent)
    .join(':');
}

const ENTRY_KEY_PREFIX = `${COMMAND_LEDGER_KEY_PREFIX}:entry:`;

function entryKey(identity: CommandLedgerIdentity): string {
  return `${ENTRY_KEY_PREFIX}${identityKeySuffix(identity)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIdentity(value: unknown): value is CommandLedgerIdentity {
  return (
    isRecord(value) &&
    typeof value['callerId'] === 'string' &&
    typeof value['target'] === 'string' &&
    typeof value['requestId'] === 'string' &&
    typeof value['operationVersion'] === 'string'
  );
}

/** A stored timestamp the retention arithmetic can use: a string `Date.parse` reads as a finite time. */
function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isWellFormedEntry(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !isIdentity(value['identity']) ||
    typeof value['payloadDigest'] !== 'string' ||
    !isTimestamp(value['claimedAt']) ||
    !('claim' in value)
  ) {
    return false;
  }
  if (value['state'] === 'pending') return true;
  return (
    value['state'] === 'completed' &&
    isTimestamp(value['completedAt']) &&
    'result' in value &&
    (value['settledAt'] === undefined || isTimestamp(value['settledAt']))
  );
}

/** The latest time an entry records: no retention window can start before it. */
function latestTimestamp(entry: CommandLedgerEntry<unknown, unknown>): string {
  if (entry.state === 'pending') return entry.claimedAt;
  return entry.settledAt ?? entry.completedAt;
}

function validateTerminalRetentionMs(value: number | undefined): number {
  if (value === undefined) return COMMAND_LEDGER_DEFAULT_TERMINAL_RETENTION_MS;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError('"terminalRetentionMs" must be a positive integer');
  }
  return value;
}

function parseEntry<TClaim, TResult>(
  key: string,
  raw: string,
): CommandLedgerEntry<TClaim, TResult> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Command-ledger entry at "${key}" is unreadable.`, { cause: error });
  }
  if (!isWellFormedEntry(parsed)) {
    throw new Error(`Command-ledger entry at "${key}" is unreadable.`);
  }
  return parsed as CommandLedgerEntry<TClaim, TResult>;
}

/**
 * A parse that resolves `undefined` for an unreadable record instead of
 * throwing, for pruning, which keeps what it cannot read.
 */
function readable<T>(parse: () => T): T | undefined {
  try {
    return parse();
  } catch {
    return undefined;
  }
}

function parseConflict(key: string, raw: string | null): CommandLedgerConflictEntry | undefined {
  if (raw === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Command-ledger conflict record at "${key}" is unreadable.`, { cause: error });
  }
  if (
    !isRecord(parsed) ||
    parsed['state'] !== 'failed' ||
    !isIdentity(parsed['identity']) ||
    typeof parsed['originalClaimedAt'] !== 'string' ||
    typeof parsed['recordedAt'] !== 'string'
  ) {
    throw new Error(`Command-ledger conflict record at "${key}" is unreadable.`);
  }
  return parsed as unknown as CommandLedgerConflictEntry;
}

/**
 * A command ledger over `options.kv`. See the module doc for the identity,
 * digest, conflict, and retention rules.
 */
export function createCommandLedger<TClaim, TResult>(
  options: CreateCommandLedgerOptions<TClaim, TResult>,
): CommandLedger<TClaim, TResult> {
  const { kv, clock, nextConflictId, retentionStart } = options;
  // Two ledgers over one store (run creation and the AG-UI resume command) must
  // never read each other's entries: prune, listClaims, and the read paths all
  // scan by prefix, and a claim of another shape handed to this ledger's
  // retention and observation callbacks would be misread.
  const keyPrefix = options.keyPrefix ?? COMMAND_LEDGER_KEY_PREFIX;
  const entryPrefix = `${keyPrefix}:entry:`;
  const conflictPrefix = `${keyPrefix}:conflict:`;
  const entryKeyOf = (identity: CommandLedgerIdentity): string =>
    `${entryPrefix}${identityKeySuffix(identity)}`;
  // The trailing delimiter keeps `request-1` from listing `request-10`'s conflicts.
  const conflictKeyPrefixOf = (identity: CommandLedgerIdentity): string =>
    `${conflictPrefix}${identityKeySuffix(identity)}:`;
  const retentionOption = options.terminalRetentionMs;
  // A fixed value is refused at construction; a function is checked each time it is read.
  if (typeof retentionOption !== 'function') validateTerminalRetentionMs(retentionOption);
  const terminalRetention = (): number =>
    validateTerminalRetentionMs(
      typeof retentionOption === 'function' ? retentionOption() : retentionOption,
    );
  type Entry = CommandLedgerEntry<TClaim, TResult>;
  type Completed = CommandLedgerCompletedEntry<TClaim, TResult>;

  /**
   * When `entry`'s retention window closed, in epoch milliseconds, if it has;
   * `undefined` while the binding is retained.
   */
  async function expiredAt(entry: Entry): Promise<number | undefined> {
    const now = clock.now();
    const terminalRetentionMs = terminalRetention();
    const earliest = Date.parse(latestTimestamp(entry)) + terminalRetentionMs;
    if (now < earliest) return undefined;
    if (retentionStart === undefined) return earliest;
    const start = await retentionStart(entry);
    if (start === undefined) return undefined;
    const closes = Math.max(start + terminalRetentionMs, earliest);
    return now < closes ? undefined : closes;
  }

  /** Whether `stored` is still the claim `entry` was made under, in any state. */
  function isSameClaim(stored: Entry | undefined, entry: Entry): boolean {
    return (
      stored !== undefined &&
      stored.claimedAt === entry.claimedAt &&
      JSON.stringify(stored.claim) === JSON.stringify(entry.claim)
    );
  }

  async function readStored(key: string): Promise<{ raw: string; entry: Entry } | undefined> {
    const raw = await kv.get(key);
    return raw === null ? undefined : { raw, entry: parseEntry<TClaim, TResult>(key, raw) };
  }

  /** A delete for each conflict record of `identity`, to commit with a change to its binding. */
  async function conflictDeletions(
    identity: CommandLedgerIdentity,
  ): Promise<TextValueStoreBatchOperation[]> {
    const keys = await kv.list(conflictKeyPrefixOf(identity));
    return keys.map((key) => ({ type: 'delete', key }));
  }

  async function recordConflict(
    identity: CommandLedgerIdentity,
    payloadDigest: string,
    original: Entry,
  ): Promise<string> {
    for (let attempt = 0; attempt < COMMAND_LEDGER_MAX_CAS_ATTEMPTS; attempt += 1) {
      const conflictId = nextConflictId();
      const key = `${conflictKeyPrefixOf(identity)}${encodeStorageKeyComponent(conflictId)}`;
      const record: CommandLedgerConflictEntry = {
        state: 'failed',
        identity,
        conflictId,
        reason: 'payload-mismatch',
        payloadDigest,
        originalPayloadDigest: original.payloadDigest,
        originalClaimedAt: original.claimedAt,
        recordedAt: clock.nowISO(),
      };
      const committed = await kv.conditionalBatch(
        [{ key, expectedValue: null }],
        [{ type: 'set', key, value: JSON.stringify(record) }],
      );
      if (committed) return conflictId;
    }
    throw new Error(
      `Command ledger could not record a conflict for request "${identity.requestId}" ` +
        `within ${COMMAND_LEDGER_MAX_CAS_ATTEMPTS} compare-and-swap attempts.`,
    );
  }

  /**
   * Write `entry` as the identity's binding: into an empty slot, or over the
   * expired binding stored as `expiredRaw`, whose conflict records go with it.
   */
  async function writeClaim(
    key: string,
    entry: CommandLedgerPendingEntry<TClaim>,
    expiredRaw: string | null,
  ): Promise<boolean> {
    const deletions = expiredRaw === null ? [] : await conflictDeletions(entry.identity);
    return kv.conditionalBatch(
      [{ key, expectedValue: expiredRaw }],
      [{ type: 'set', key, value: JSON.stringify(entry) }, ...deletions],
    );
  }

  async function locate(
    identity: CommandLedgerIdentity,
  ): Promise<CommandLedgerLocation<TClaim, TResult>> {
    const stored = await readStored(entryKeyOf(identity));
    if (stored === undefined) return { state: 'not-found' };
    const closed = await expiredAt(stored.entry);
    if (closed === undefined) return { state: 'retained', entry: stored.entry };
    return { state: 'expired', entry: stored.entry, expiredAt: new Date(closed).toISOString() };
  }

  /**
   * Delete the binding stored as `raw` with its conflict records. Resolves how
   * many conflict records went with it, or `undefined` when it changed first.
   */
  async function deleteBinding(
    key: string,
    raw: string,
    entry: Entry,
  ): Promise<number | undefined> {
    const deletions = await conflictDeletions(entry.identity);
    const committed = await kv.conditionalBatch(
      [{ key, expectedValue: raw }],
      [{ type: 'delete', key }, ...deletions],
    );
    return committed ? deletions.length : undefined;
  }

  /** Whether the binding `conflict` was recorded against still exists; an unreadable one counts. */
  async function isBound(conflict: CommandLedgerConflictEntry): Promise<boolean> {
    const key = entryKeyOf(conflict.identity);
    const raw = await kv.get(key);
    if (raw === null) return false;
    const entry = readable(() => parseEntry<TClaim, TResult>(key, raw));
    return entry === undefined || entry.claimedAt === conflict.originalClaimedAt;
  }

  /**
   * Deletes conflict records whose binding is gone: released, replaced, or
   * pruned. An unreadable record is kept.
   */
  async function pruneOrphanedConflicts(): Promise<number> {
    let pruned = 0;
    for (const key of await kv.list(conflictPrefix)) {
      const raw = await kv.get(key);
      const conflict = readable(() => parseConflict(key, raw));
      if (raw === null || conflict === undefined || (await isBound(conflict))) continue;
      if (await kv.conditionalBatch([{ key, expectedValue: raw }], [{ type: 'delete', key }])) {
        pruned += 1;
      }
    }
    return pruned;
  }

  return {
    async claim(identity, payloadDigest, claim) {
      const key = entryKeyOf(identity);
      for (let attempt = 0; attempt < COMMAND_LEDGER_MAX_CAS_ATTEMPTS; attempt += 1) {
        const stored = await readStored(key);
        const entry: CommandLedgerPendingEntry<TClaim> = {
          state: 'pending',
          identity,
          payloadDigest,
          claimedAt: clock.nowISO(),
          claim,
        };
        if (stored !== undefined && (await expiredAt(stored.entry)) === undefined) {
          const existing = stored.entry;
          if (existing.payloadDigest === payloadDigest) {
            return { outcome: 'existing', entry: existing };
          }
          const conflictId = await recordConflict(identity, payloadDigest, existing);
          throw new BureauLedgerConflictError(identity.requestId, conflictId, {
            originalClaimedAt: existing.claimedAt,
          });
        }
        if (await writeClaim(key, entry, stored?.raw ?? null)) return { outcome: 'claimed', entry };
        // Another attempt claimed, completed, or settled the identity between
        // the read and the write. Re-read and resolve against what it wrote.
      }
      throw new Error(
        `Command ledger could not claim request "${identity.requestId}" ` +
          `within ${COMMAND_LEDGER_MAX_CAS_ATTEMPTS} compare-and-swap attempts.`,
      );
    },

    async complete(entry, result, completion = {}) {
      const key = entryKeyOf(entry.identity);
      const completedAt = clock.nowISO();
      const completed: Completed = {
        ...entry,
        state: 'completed',
        completedAt,
        result,
        ...(completion.settledAt === undefined ? {} : { settledAt: completion.settledAt }),
      };
      const committed = await kv.conditionalBatch(
        [{ key, expectedValue: JSON.stringify(entry) }],
        [{ type: 'set', key, value: JSON.stringify(completed) }],
      );
      if (committed) return completed;
      // Another attempt may have completed this same claim first, as a retry
      // that observed the run does. Its record stands; anything else means
      // the claim this call held is gone.
      const stored = await readStored(key);
      if (stored?.entry.state === 'completed' && isSameClaim(stored.entry, entry)) {
        return stored.entry;
      }
      throw new Error(
        `Command-ledger entry for request "${entry.identity.requestId}" is no longer pending ` +
          'as claimed, so its result was not recorded.',
      );
    },

    async settle(entry, settledAt) {
      const key = entryKeyOf(entry.identity);
      for (let attempt = 0; attempt < COMMAND_LEDGER_MAX_CAS_ATTEMPTS; attempt += 1) {
        const stored = await readStored(key);
        if (stored?.entry.state !== 'completed' || !isSameClaim(stored.entry, entry)) {
          return undefined;
        }
        if (stored.entry.settledAt !== undefined) return stored.entry;
        const settled: Completed = { ...stored.entry, settledAt };
        const committed = await kv.conditionalBatch(
          [{ key, expectedValue: stored.raw }],
          [{ type: 'set', key, value: JSON.stringify(settled) }],
        );
        if (committed) return settled;
      }
      throw new Error(
        `Command ledger could not record the settlement of request ` +
          `"${entry.identity.requestId}" within ${COMMAND_LEDGER_MAX_CAS_ATTEMPTS} ` +
          'compare-and-swap attempts.',
      );
    },

    async release(entry) {
      const key = entryKeyOf(entry.identity);
      return kv.conditionalBatch(
        [{ key, expectedValue: JSON.stringify(entry) }],
        [{ type: 'delete', key }, ...(await conflictDeletions(entry.identity))],
      );
    },

    async read(identity) {
      const stored = await readStored(entryKeyOf(identity));
      return stored?.entry;
    },

    locate,

    async listConflicts(identity) {
      const location = await locate(identity);
      if (location.state !== 'retained') return [];
      const conflicts: CommandLedgerConflictEntry[] = [];
      for (const key of await kv.list(conflictKeyPrefixOf(identity))) {
        const conflict = parseConflict(key, await kv.get(key));
        if (conflict?.originalClaimedAt === location.entry.claimedAt) conflicts.push(conflict);
      }
      return conflicts;
    },

    async listClaims() {
      const claims: TClaim[] = [];
      for (const key of await kv.list(entryPrefix)) {
        const raw = await kv.get(key);
        // Deleted between the listing and the read: no longer a binding.
        if (raw !== null) claims.push(parseEntry<TClaim, TResult>(key, raw).claim);
      }
      return claims;
    },

    async prune() {
      let entries = 0;
      let conflicts = 0;
      for (const key of await kv.list(entryPrefix)) {
        const raw = await kv.get(key);
        // An unreadable entry fails closed here too: it is kept, never pruned.
        const entry =
          raw === null ? undefined : readable(() => parseEntry<TClaim, TResult>(key, raw));
        if (raw === null || entry === undefined || (await expiredAt(entry)) === undefined) continue;
        const removedConflicts = await deleteBinding(key, raw, entry);
        if (removedConflicts === undefined) continue;
        entries += 1;
        conflicts += removedConflicts;
      }
      conflicts += await pruneOrphanedConflicts();
      return { entries, conflicts };
    },
  };
}

/** A value a command payload field may carry into its digest. */
export type CommandPayloadValue = string | number | boolean | null | undefined;

/**
 * SHA-256 of a command payload's canonical JSON: keys sorted, `undefined`
 * fields omitted, so a retry that builds the same payload in a different
 * order, or omits a field instead of passing `undefined`, digests the same.
 */
export function digestCommandPayload(
  payload: Readonly<Record<string, CommandPayloadValue>>,
): string {
  for (const [key, value] of Object.entries(payload)) {
    // JSON spells NaN and the infinities as `null`, so they would digest the
    // same as each other and as a `null` field.
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new TypeError(`Command payload field "${key}" must be a finite number`);
    }
  }
  const canonical = Object.keys(payload)
    .filter((key) => payload[key] !== undefined)
    .toSorted()
    .map((key) => [key, payload[key]] as const);
  return sha256HexSync(JSON.stringify(canonical));
}

/**
 * What decides which run a run-creation request creates, with every default
 * already resolved to the value the run will use. The caller, the published
 * agent, and the request id are the identity, not the payload, and the
 * request context carries per-attempt credentials and tracing that
 * legitimately differ between retries, so none of them belong here.
 */
export interface RunCreationPayload {
  /** The agent the task runs as. */
  readonly agentName: string;
  /** The task's input, serialized by {@link serializeTaskInput}. */
  readonly input: string;
  /** The context the start names, trimmed; absent when it asks for a new one. */
  readonly contextId?: string | undefined;
  /** The caller's request context, serialized by {@link serializeTaskRequestContext}. */
  readonly requestContext?: string | undefined;
}

/**
 * A task's input as the string its digest covers. Rows (`append`, and the rows of a seeding
 * `conversation`) are serialized by {@link serializeAppendedMessages}, so two builds of the same
 * row digest alike.
 */
export function serializeTaskInput(input: unknown): string {
  if (typeof input === 'string' || Array.isArray(input)) return canonicalJson({ message: input });
  const record = input as Record<string, unknown>;
  if ('append' in record) {
    return canonicalJson({
      message: record['message'],
      append: serializeAppendedMessages(record['append'] as object[]),
    });
  }
  if ('conversation' in record) {
    const history = record['conversation'] as {
      readonly ids: readonly string[];
      readonly messages: Readonly<Record<string, object>>;
    };
    const rows = history.ids.map((id) => history.messages[id]!);
    return canonicalJson({ conversation: serializeAppendedMessages(rows) });
  }
  return canonicalJson({ continue: true });
}

/**
 * The caller's request context as the string its digest covers: the authority, audience, and
 * locale, which decide what the task may do. The per-attempt fields (`runId` and `sessionId`, which
 * Bureau sets, and the trace context, credentials, deadline, and request id a transport mints for
 * each attempt) are left out, so an exact retry digests the same. Absent when none was given.
 */
export function serializeTaskRequestContext(
  requestContext:
    | {
        readonly authority: object;
        readonly audience?: string | undefined;
        readonly locale?: string | undefined;
      }
    | undefined,
): string | undefined {
  if (requestContext === undefined) return undefined;
  return canonicalJson({
    authority: requestContext.authority,
    audience: requestContext.audience,
    locale: requestContext.locale,
  });
}

/** JSON with every object's keys sorted, so equal values serialize alike. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, nested: unknown) =>
    nested !== null && typeof nested === 'object' && !Array.isArray(nested)
      ? Object.fromEntries(
          Object.entries(nested).toSorted(([left], [right]) => (left < right ? -1 : 1)),
        )
      : nested,
  );
}

/**
 * The rows a run-creation request appends, as the string its digest covers:
 * everything about each row except the `createdAt` and `position` that
 * appending re-stamps, which differ between two builds of the same row. An
 * empty list serializes as absent, the same as no list.
 */
export function serializeAppendedMessages(
  messages: ReadonlyArray<object> | undefined,
): string | undefined {
  if (messages === undefined || messages.length === 0) return undefined;
  return canonicalJson(
    messages.map((message) => {
      const {
        createdAt: _createdAt,
        position: _position,
        ...stable
      } = message as Record<string, unknown>;
      return stable;
    }),
  );
}

/**
 * The digest of a task-start command's payload: its agent, input, context, and request context.
 * Pass the context the caller named, trimmed: an omitted context is minted afresh per attempt, so
 * its minted id cannot be part of it.
 */
export function digestRunCreationPayload(payload: RunCreationPayload): string {
  return digestCommandPayload({
    agentName: payload.agentName,
    input: payload.input,
    contextId: payload.contextId,
    requestContext: payload.requestContext,
  });
}

/**
 * The durable receipt for a run-creation command: which run the request
 * created, the request that created it, when it was claimed, and the run's
 * status when the receipt was recorded. The ledger records it once, so
 * every retry of the same request receives the same receipt.
 */
export interface RunCreationReceipt {
  readonly runId: string;
  readonly requestId: string;
  readonly createdAt: string;
  /**
   * The run's status when the receipt was recorded: a `RunSummary` status,
   * or `pending` for a run that was claimed but has not started.
   */
  readonly status: string;
}

/** What a run-creation claim reserves before the run exists. */
export interface RunCreationClaim {
  readonly runId: string;
  readonly sessionId: string;
}

/** What a completed run-creation entry records for later retries. */
export interface RunCreationLedgerResult {
  readonly receipt: RunCreationReceipt;
  readonly summary: RunSummary;
}

/** The result of starting a run: the run's summary, with its receipt when the request named a request id. */
export type CreatedRunSummary = RunSummary & { readonly receipt?: RunCreationReceipt | undefined };

/** What the Bureau can see of a claimed run when a retry arrives. */
export interface RunCreationObservation {
  /** The run as this process's run store has it, if it does. */
  readonly live: RunSummary | undefined;
  /** The durable engine's status, `null` when it has no such run, `undefined` without an engine. */
  readonly durableStatus: WorkflowState['status'] | null | undefined;
  /**
   * When the run reached its terminal status, in epoch milliseconds on the
   * runtime clock, when the observer knows: the live run's terminal action.
   * `undefined` for a run still in progress, and for one observed only in
   * the durable engine, whose timestamps are not on the runtime clock.
   */
  readonly settledAt?: number | undefined;
}

/** One run-creation request's identity and payload, with what it would claim. */
export interface BeginRunCreationInput {
  readonly callerId: string;
  /** The published agent the run is for: part of the identity, not the payload. */
  readonly agentName: string;
  readonly requestId: string;
  readonly payloadDigest: string;
  readonly claim: RunCreationClaim;
}

/**
 * A run-creation request after it has consulted the ledger: either a replay
 * of an earlier request with the same identity, or a fresh claim the caller
 * must settle exactly once — `complete` with the created run's summary, or
 * `release` when no run was created.
 */
export type RunCreationAttempt =
  | { readonly kind: 'replay'; readonly result: CreatedRunSummary }
  | {
      readonly kind: 'claimed';
      /**
       * Record the created run's receipt. Rejects with
       * {@link RunCreationReceiptUnrecordedError} when the record cannot be
       * written; the run still exists then, and the caller decides its fate.
       */
      complete(summary: RunSummary): Promise<CreatedRunSummary>;
      release(cause: unknown): Promise<void>;
    };

export interface CreateRunCreationLedgerOptions {
  readonly kv: ConditionalTextValueStore;
  readonly clock: Pick<RuntimeClock, 'now' | 'nowISO'>;
  readonly identifiers: RuntimeIdentifiers;
  /** Looks up the run a claim reserved. */
  readonly observe: (claim: RunCreationClaim) => Promise<RunCreationObservation>;
  /**
   * How long a binding is retained after its run settles, in milliseconds.
   * Default {@link COMMAND_LEDGER_DEFAULT_TERMINAL_RETENTION_MS} (24 hours). A function is read
   * each time a binding's window is measured, so a window changed while the Bureau runs applies
   * to the bindings measured from then on (COR-1710).
   */
  readonly terminalRetentionMs?: number | (() => number | undefined) | undefined;
}

/** Which run-creation request a receipt query is for. */
export interface LocateRunCreationReceiptInput {
  readonly callerId: string;
  readonly agentName: string;
  readonly requestId: string;
}

/**
 * Where a run-creation request's receipt stands: `recorded` once the run has
 * started, `pending` while its claim has no started run, `expired` once the
 * binding's retention window has passed (the request id then admits a new
 * run), and `not-found` when the ledger holds no binding for it.
 */
export type RunCreationReceiptLocation =
  | {
      readonly status: 'recorded';
      readonly receipt: RunCreationReceipt;
      /** The session the run was claimed for, so a retry can tell it from another thread's. */
      readonly sessionId: string;
    }
  | {
      readonly status: 'pending';
      readonly receipt: RunCreationReceipt;
      readonly sessionId: string;
    }
  | { readonly status: 'expired'; readonly requestId: string; readonly expiredAt: string }
  | { readonly status: 'not-found'; readonly requestId: string };

export interface RunCreationLedger {
  readonly ledger: CommandLedger<RunCreationClaim, RunCreationLedgerResult>;
  begin(input: BeginRunCreationInput): Promise<RunCreationAttempt>;
  /**
   * Where the request's receipt stands. Like a retry, a query that finds the
   * claimed run started records its receipt, and one that finds the run
   * settled records when it settled.
   */
  locate(input: LocateRunCreationReceiptInput): Promise<RunCreationReceiptLocation>;
  /** Delete expired bindings and their conflict records. */
  prune(): Promise<CommandLedgerPruneResult>;
  /**
   * The run id of every run-creation binding still stored, expired but not
   * yet pruned included: an exact retry finds its run through the binding, so
   * the run must outlive it. Rejects when a stored entry is unreadable.
   */
  boundRunIds(): Promise<ReadonlySet<string>>;
}

/** Maps a durable workflow status onto the `RunSummary` status vocabulary. */
function runStatusFromDurable(
  status: WorkflowState['status'] | null | undefined,
): string | undefined {
  switch (status) {
    case 'pending':
    case 'running':
    case 'suspended':
      return 'running';
    case 'completed':
      return 'completed';
    case 'failed':
    case 'timed-out':
      return 'error';
    case 'cancelled':
      return 'aborted';
    default:
      return undefined;
  }
}

type RunCreationPendingEntry = CommandLedgerPendingEntry<RunCreationClaim>;
type RunCreationCompletedEntry = CommandLedgerCompletedEntry<
  RunCreationClaim,
  RunCreationLedgerResult
>;
type RunCreationEntry = CommandLedgerEntry<RunCreationClaim, RunCreationLedgerResult>;

/** The `RunSummary` statuses a run never leaves. */
const SETTLED_RUN_STATUSES: ReadonlySet<string> = new Set(['completed', 'error', 'aborted']);

/** The run's status as observed: live in this process, else durable; `undefined` when it never started. */
function observedStatus(observation: RunCreationObservation): string | undefined {
  return observation.live?.status ?? runStatusFromDurable(observation.durableStatus);
}

function runCreationIdentity(input: LocateRunCreationReceiptInput): CommandLedgerIdentity {
  return {
    callerId: input.callerId,
    target: input.agentName,
    requestId: input.requestId,
    operationVersion: RUN_CREATION_OPERATION_VERSION,
  };
}

/** The summary of a claimed run that has not started, so has done no work. */
function notStartedSummary(entry: RunCreationPendingEntry): RunSummary {
  return {
    id: entry.claim.runId,
    sessionId: entry.claim.sessionId,
    status: 'pending',
    steps: 0,
    usage: { prompt: 0, completion: 0, total: 0 },
    finishReason: undefined,
    error: undefined,
    actionCount: 0,
    agentName: entry.identity.target,
    principal: entry.identity.callerId,
    startedAt: undefined,
  };
}

function receiptFor(entry: RunCreationPendingEntry, status: string): RunCreationReceipt {
  return {
    runId: entry.claim.runId,
    requestId: entry.identity.requestId,
    createdAt: entry.claimedAt,
    status,
  };
}

/** What `begin` decided while it held the identity's in-process claim lock. */
type ClaimDecision =
  | {
      readonly kind: 'existing';
      readonly entry: CommandLedgerEntry<RunCreationClaim, RunCreationLedgerResult>;
      readonly inFlight: Promise<CreatedRunSummary> | undefined;
    }
  | {
      readonly kind: 'claimed';
      readonly entry: RunCreationPendingEntry;
      readonly settlement: PromiseWithResolvers<CreatedRunSummary>;
    };

/**
 * The run-creation command ledger. See the module doc for how a retry is
 * resolved against a pending or completed entry.
 */
export function createRunCreationLedger(
  options: CreateRunCreationLedgerOptions,
): RunCreationLedger {
  const { clock, identifiers, observe } = options;
  // Attempts this process claimed and has not yet settled, by ledger key.
  const inFlight = new Map<string, Promise<CreatedRunSummary>>();
  const ledger: CommandLedger<RunCreationClaim, RunCreationLedgerResult> = createCommandLedger<
    RunCreationClaim,
    RunCreationLedgerResult
  >({
    kv: options.kv,
    clock,
    nextConflictId: () => identifiers.next('command-ledger-conflict'),
    terminalRetentionMs: options.terminalRetentionMs,
    retentionStart,
  });

  /**
   * When `observation`'s settled run settled, as an ISO timestamp: the run's
   * own terminal time when the observer knows it, otherwise now, the moment
   * this observation proves it settled by. Never before the entry's latest
   * recorded timestamp, nor after now.
   */
  function settlementTime(entry: RunCreationEntry, observation: RunCreationObservation): string {
    const now = clock.now();
    const floor = Date.parse(latestTimestamp(entry));
    const settled = Math.min(Math.max(observation.settledAt ?? now, floor), now);
    return new Date(settled).toISOString();
  }

  /**
   * When a binding's retention window starts: once its run has settled, or,
   * for a run that never started or no longer exists, at the entry's own
   * latest timestamp. A run still in progress, or a claim this process is
   * still settling, holds the binding. A run whose terminal time the
   * observer knows starts the window there, and nothing is written, so a
   * prune deletes an expired binding in one pass. A run settled at a time the
   * observer cannot see starts it now, recorded so later checks agree.
   */
  async function retentionStart(entry: RunCreationEntry): Promise<number | undefined> {
    if (entry.state === 'completed' && entry.settledAt !== undefined) {
      return Date.parse(entry.settledAt);
    }
    if (inFlight.has(entryKey(entry.identity))) return undefined;
    const observation = await observe(entry.claim);
    const status = observedStatus(observation);
    if (status === undefined) return Date.parse(latestTimestamp(entry));
    if (!SETTLED_RUN_STATUSES.has(status)) return undefined;
    const settledAt = settlementTime(entry, observation);
    if (observation.settledAt === undefined) {
      // Recorded so the window does not restart at every later check. When
      // the entry changed under this read, the caller's compare-and-swap
      // fails against it and re-reads.
      if (entry.state === 'completed') await ledger.settle(entry, settledAt);
      else await recordStartedRun(entry, observation, status);
    }
    return Date.parse(settledAt);
  }

  /** Records that a completed entry's run has settled, the first time a retry or query sees it. */
  async function settleIfObserved(
    entry: RunCreationCompletedEntry,
    observation: RunCreationObservation,
  ): Promise<void> {
    const status = observedStatus(observation);
    if (entry.settledAt === undefined && status !== undefined && SETTLED_RUN_STATUSES.has(status)) {
      await ledger.settle(entry, settlementTime(entry, observation));
    }
  }

  // Serializes this process's claims of one identity, so a concurrent retry
  // reads the ledger only after the attempt that claimed it has registered
  // in `inFlight`, and waits for it rather than reporting it not started.
  const claimLocks = new Map<string, Promise<void>>();

  async function withClaimLock<T>(key: string, body: () => Promise<T>): Promise<T> {
    const previous = claimLocks.get(key);
    const released = Promise.withResolvers<void>();
    const current = (previous ?? Promise.resolve()).then(() => released.promise);
    claimLocks.set(key, current);
    if (previous !== undefined) await previous;
    try {
      return await body();
    } finally {
      released.resolve();
      if (claimLocks.get(key) === current) claimLocks.delete(key);
    }
  }

  async function replayCompleted(entry: RunCreationCompletedEntry): Promise<CreatedRunSummary> {
    const observation = await observe(entry.claim);
    const stored = entry.result.summary;
    const summary = observation.live ?? {
      ...stored,
      status: runStatusFromDurable(observation.durableStatus) ?? stored.status,
    };
    await settleIfObserved(entry, observation);
    return { ...summary, receipt: entry.result.receipt };
  }

  /**
   * Records the receipt of a pending entry's run, observed `status`, once, so
   * later retries replay it instead of each building their own. A settled
   * run's entry is recorded settled.
   */
  async function recordStartedRun(
    entry: RunCreationPendingEntry,
    observation: RunCreationObservation,
    status: string,
  ): Promise<CreatedRunSummary> {
    // Without a live run this process has observed none of the run's work,
    // so it reports none.
    const summary: RunSummary = observation.live ?? { ...notStartedSummary(entry), status };
    const settledAt = SETTLED_RUN_STATUSES.has(status)
      ? settlementTime(entry, observation)
      : undefined;
    const recorded = await ledger.complete(
      entry,
      { receipt: receiptFor(entry, status), summary },
      { settledAt },
    );
    return { ...summary, receipt: recorded.result.receipt };
  }

  /**
   * A pending entry nobody in this process is settling: its claimant crashed
   * (or lives elsewhere). When the run exists, its receipt is recorded now.
   */
  async function replayPending(entry: RunCreationPendingEntry): Promise<CreatedRunSummary> {
    const observation = await observe(entry.claim);
    const status = observedStatus(observation);
    if (status === undefined) {
      const summary = notStartedSummary(entry);
      return { ...summary, receipt: receiptFor(entry, summary.status) };
    }
    return recordStartedRun(entry, observation, status);
  }

  async function locate(input: LocateRunCreationReceiptInput): Promise<RunCreationReceiptLocation> {
    const location = await ledger.locate(runCreationIdentity(input));
    if (location.state === 'not-found') return { status: 'not-found', requestId: input.requestId };
    if (location.state === 'expired') {
      return { status: 'expired', requestId: input.requestId, expiredAt: location.expiredAt };
    }
    const { entry } = location;
    if (entry.state === 'completed') {
      await settleIfObserved(entry, await observe(entry.claim));
      return {
        status: 'recorded',
        receipt: entry.result.receipt,
        sessionId: entry.claim.sessionId,
      };
    }
    if (inFlight.has(entryKey(entry.identity))) {
      return {
        status: 'pending',
        receipt: receiptFor(entry, 'pending'),
        sessionId: entry.claim.sessionId,
      };
    }
    const replayed = await replayPending(entry);
    const receipt = replayed.receipt ?? receiptFor(entry, replayed.status);
    return {
      status: replayed.status === 'pending' ? 'pending' : 'recorded',
      receipt,
      sessionId: entry.claim.sessionId,
    };
  }

  /**
   * The original receipt a conflicting attempt reports, once the original has
   * one. A binding released or replaced since the conflict is another run, so
   * only the binding claimed at `originalClaimedAt` answers.
   */
  async function originalReceipt(
    identity: CommandLedgerIdentity,
    originalClaimedAt: string | undefined,
  ): Promise<RunCreationReceipt | undefined> {
    const original = await ledger.read(identity);
    if (original?.state !== 'completed' || original.claimedAt !== originalClaimedAt) {
      return undefined;
    }
    return original.result.receipt;
  }

  async function claimOrObserve(
    identity: CommandLedgerIdentity,
    key: string,
    input: BeginRunCreationInput,
  ): Promise<ClaimDecision> {
    // Taken before the ledger read: an attempt in flight now may settle while
    // the read is outstanding, and a pending entry read then is still its
    // claim, which this retry must wait for rather than report not started.
    const settling = inFlight.get(key);
    let outcome: CommandLedgerClaimOutcome<RunCreationClaim, RunCreationLedgerResult>;
    try {
      outcome = await ledger.claim(identity, input.payloadDigest, input.claim);
    } catch (error) {
      if (!(error instanceof BureauLedgerConflictError)) throw error;
      throw new BureauLedgerConflictError(error.requestId, error.conflictId, {
        originalClaimedAt: error.originalClaimedAt,
        originalReceipt: await originalReceipt(identity, error.originalClaimedAt),
      });
    }
    if (outcome.outcome === 'existing') {
      return { kind: 'existing', entry: outcome.entry, inFlight: inFlight.get(key) ?? settling };
    }
    const settlement = Promise.withResolvers<CreatedRunSummary>();
    // An attempt nobody is waiting on may still fail; its caller sees that
    // failure directly, so it must not also surface as an unhandled rejection.
    settlement.promise.catch(() => {});
    inFlight.set(key, settlement.promise);
    return { kind: 'claimed', entry: outcome.entry, settlement };
  }

  return {
    ledger,
    locate,
    prune: () => ledger.prune(),
    async boundRunIds() {
      const claims = await ledger.listClaims();
      const runIds = new Set<string>();
      for (const claim of claims) {
        // A claim that names no run cannot be ruled out as the binding of a
        // task, so the whole read fails closed rather than omitting it.
        const runId: unknown = isRecord(claim) ? claim['runId'] : undefined;
        if (typeof runId !== 'string' || runId.length === 0) {
          throw new Error('A run-creation binding has no readable run id.');
        }
        runIds.add(runId);
      }
      return runIds;
    },
    async begin(input) {
      const identity = runCreationIdentity(input);
      const key = entryKey(identity);
      const decision = await withClaimLock(key, () => claimOrObserve(identity, key, input));

      if (decision.kind === 'existing') {
        const existing = decision.entry;
        if (existing.state === 'completed') {
          return { kind: 'replay', result: await replayCompleted(existing) };
        }
        return {
          kind: 'replay',
          result:
            decision.inFlight !== undefined
              ? await decision.inFlight
              : await replayPending(existing),
        };
      }

      const { entry, settlement } = decision;
      const settle = () => {
        if (inFlight.get(key) === settlement.promise) inFlight.delete(key);
      };

      return {
        kind: 'claimed',
        async complete(summary) {
          let recorded: CommandLedgerCompletedEntry<RunCreationClaim, RunCreationLedgerResult>;
          try {
            recorded = await ledger.complete(entry, {
              receipt: receiptFor(entry, summary.status),
              summary,
            });
          } catch (error) {
            const failure = new RunCreationReceiptUnrecordedError(
              entry.identity.requestId,
              entry.claim.runId,
              error,
            );
            settlement.reject(failure);
            throw failure;
          } finally {
            settle();
          }
          const created: CreatedRunSummary = { ...summary, receipt: recorded.result.receipt };
          settlement.resolve(created);
          return created;
        },
        async release(cause) {
          try {
            await ledger.release(entry);
          } finally {
            settlement.reject(cause);
            settle();
          }
        },
      };
    },
  };
}

/** How often a {@link createPrunedCommandLedger} drops its expired bindings, at most. */
const PRUNED_LEDGER_INTERVAL_MS = 3_600_000;

/**
 * A command ledger over `kv` under `keyPrefix` that drops its expired bindings at most once an
 * hour, on a claim. A failed prune is ignored: the next one an hour later tries again.
 */
export function createPrunedCommandLedger<Claim, Result>(
  kv: ConditionalTextValueStore,
  keyPrefix: string,
  conflictIdPrefix: string,
  runtime: Pick<RuntimeServices, 'clock' | 'identifiers'>,
): CommandLedger<Claim, Result> {
  const ledger = createCommandLedger<Claim, Result>({
    kv,
    keyPrefix,
    clock: runtime.clock,
    nextConflictId: () => runtime.identifiers.next(conflictIdPrefix),
  });
  let prunedAt = runtime.clock.now();
  return {
    ...ledger,
    async claim(identity, digest, claim) {
      const now = runtime.clock.now();
      if (now - prunedAt >= PRUNED_LEDGER_INTERVAL_MS) {
        prunedAt = now;
        await ledger.prune().catch(() => undefined);
      }
      return ledger.claim(identity, digest, claim);
    },
  };
}
