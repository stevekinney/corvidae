/**
 * COR-424 — durable external command receipts and retry-safe run creation.
 *
 * ## The ledger
 *
 * A command ledger entry is keyed by `(callerId, requestId,
 * operationVersion)`: the authenticated caller, the idempotency key that
 * caller supplied on the request itself, and the version of the operation's
 * contract. Each entry stores a digest of the command's payload beside it.
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
 * sessions in, so they share that store's durability: a persistent backend
 * keeps them across a restart, and the memory backend keeps them for the
 * life of the process. Every write is a compare-and-swap, so two attempts
 * racing for one identity cannot both claim it.
 *
 * An unreadable entry fails closed. Treating it as absent would let a retry
 * claim the identity afresh and create the very duplicate this ledger exists
 * to prevent.
 *
 * ## Run creation
 *
 * {@link createRunCreationLedger} applies the ledger to `createRun`. The
 * identity's target is the caller-supplied `runCreationRequestId`, because
 * no run exists to key on until the command has run. A claim carries the
 * run and session identifiers minted for the attempt, so a retry that finds
 * a pending entry knows which run to look for instead of starting another:
 *
 * - In the process that claimed it, a retry waits for the in-flight attempt
 *   and receives its outcome, including its failure.
 * - Anywhere else (after a restart), a retry observes the run: the live run
 *   when this process has recovered it, the durable engine's status when it
 *   has not, and `pending` when the run never started at all.
 *
 * A completed entry carries the {@link RunCreationReceipt} and the summary
 * returned to the original caller. A retry receives that original receipt
 * unchanged, alongside the run as it stands now.
 */
import { sha256HexSync } from '@lostgradient/cryptography';
import type { RuntimeClock, RuntimeIdentifiers } from '@lostgradient/lifecycle';
import {
  type ConditionalTextValueStore,
  encodeStorageKeyComponent,
  type WorkflowState,
} from '@lostgradient/weft';

import type { CreateRunRequest, RunSummary } from './types';

/** The version of the run-creation command contract the ledger keys on. */
export const RUN_CREATION_OPERATION_VERSION = 'bureau.run-creation.v1';

/** Key prefix for every command-ledger record in the Bureau's text-value store. */
const COMMAND_LEDGER_KEY_PREFIX = 'command-ledger:v1';

/** Bounds the compare-and-swap loop against concurrent claimants of one identity. */
const COMMAND_LEDGER_MAX_CAS_ATTEMPTS = 10;

/** Who issued a command, which command it was, and under which contract version. */
export interface CommandLedgerIdentity {
  readonly callerId: string;
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
  readonly recordedAt: string;
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

  constructor(requestId: string, conflictId: string) {
    super(
      `Request "${requestId}" was already used for a command with a different payload; ` +
        'retry with the original payload or use a new request id.',
    );
    this.name = 'BureauLedgerConflictError';
    this.requestId = requestId;
    this.reason = 'payload-mismatch';
    this.conflictId = conflictId;
  }
}

/** The ledger's operations over one store. */
export interface CommandLedger<TClaim, TResult> {
  /**
   * Claim `identity` for a command whose payload digests to `payloadDigest`.
   * Resolves `claimed` when this call wrote a new pending entry and `existing`
   * when an entry with the same digest was already there. Rejects with
   * {@link BureauLedgerConflictError}, after recording the attempt, when the
   * existing entry's digest differs.
   */
  claim(
    identity: CommandLedgerIdentity,
    payloadDigest: string,
    claim: TClaim,
  ): Promise<CommandLedgerClaimOutcome<TClaim, TResult>>;
  /** Record `result` on the pending entry this ledger handed back from `claim`. */
  complete(
    entry: CommandLedgerPendingEntry<TClaim>,
    result: TResult,
  ): Promise<CommandLedgerCompletedEntry<TClaim, TResult>>;
  /**
   * Remove a pending entry whose command produced no effect, so a retry claims
   * afresh. Resolves `false`, removing nothing, when the stored entry is no
   * longer exactly `entry`.
   */
  release(entry: CommandLedgerPendingEntry<TClaim>): Promise<boolean>;
  read(identity: CommandLedgerIdentity): Promise<CommandLedgerEntry<TClaim, TResult> | undefined>;
  listConflicts(identity: CommandLedgerIdentity): Promise<readonly CommandLedgerConflictEntry[]>;
}

export interface CreateCommandLedgerOptions {
  readonly kv: ConditionalTextValueStore;
  /** The ISO timestamp recorded on claims, completions, and conflicts. */
  readonly now: () => string;
  /** Mints the id of each recorded conflict. */
  readonly nextConflictId: () => string;
}

function identityKeySuffix(identity: CommandLedgerIdentity): string {
  return [identity.callerId, identity.requestId, identity.operationVersion]
    .map(encodeStorageKeyComponent)
    .join(':');
}

function entryKey(identity: CommandLedgerIdentity): string {
  return `${COMMAND_LEDGER_KEY_PREFIX}:entry:${identityKeySuffix(identity)}`;
}

function conflictKeyPrefix(identity: CommandLedgerIdentity): string {
  // The trailing delimiter keeps `request-1` from listing `request-10`'s conflicts.
  return `${COMMAND_LEDGER_KEY_PREFIX}:conflict:${identityKeySuffix(identity)}:`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIdentity(value: unknown): value is CommandLedgerIdentity {
  return (
    isRecord(value) &&
    typeof value['callerId'] === 'string' &&
    typeof value['requestId'] === 'string' &&
    typeof value['operationVersion'] === 'string'
  );
}

function isWellFormedEntry(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !isIdentity(value['identity']) ||
    typeof value['payloadDigest'] !== 'string' ||
    typeof value['claimedAt'] !== 'string' ||
    !('claim' in value)
  ) {
    return false;
  }
  if (value['state'] === 'pending') return true;
  return (
    value['state'] === 'completed' && typeof value['completedAt'] === 'string' && 'result' in value
  );
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

function parseConflict(key: string, raw: string | null): CommandLedgerConflictEntry | undefined {
  if (raw === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Command-ledger conflict record at "${key}" is unreadable.`, { cause: error });
  }
  if (!isRecord(parsed) || parsed['state'] !== 'failed' || !isIdentity(parsed['identity'])) {
    throw new Error(`Command-ledger conflict record at "${key}" is unreadable.`);
  }
  return parsed as unknown as CommandLedgerConflictEntry;
}

/**
 * A command ledger over `options.kv`. See the module doc for the identity,
 * digest, and conflict rules.
 */
export function createCommandLedger<TClaim, TResult>(
  options: CreateCommandLedgerOptions,
): CommandLedger<TClaim, TResult> {
  const { kv, now, nextConflictId } = options;

  async function recordConflict(
    identity: CommandLedgerIdentity,
    payloadDigest: string,
    originalPayloadDigest: string,
  ): Promise<string> {
    for (let attempt = 0; attempt < COMMAND_LEDGER_MAX_CAS_ATTEMPTS; attempt += 1) {
      const conflictId = nextConflictId();
      const key = `${conflictKeyPrefix(identity)}${encodeStorageKeyComponent(conflictId)}`;
      const record: CommandLedgerConflictEntry = {
        state: 'failed',
        identity,
        conflictId,
        reason: 'payload-mismatch',
        payloadDigest,
        originalPayloadDigest,
        recordedAt: now(),
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

  return {
    async claim(identity, payloadDigest, claim) {
      const key = entryKey(identity);
      for (let attempt = 0; attempt < COMMAND_LEDGER_MAX_CAS_ATTEMPTS; attempt += 1) {
        const raw = await kv.get(key);
        if (raw !== null) {
          const existing = parseEntry<TClaim, TResult>(key, raw);
          if (existing.payloadDigest === payloadDigest) {
            return { outcome: 'existing', entry: existing };
          }
          const conflictId = await recordConflict(identity, payloadDigest, existing.payloadDigest);
          throw new BureauLedgerConflictError(identity.requestId, conflictId);
        }
        const entry: CommandLedgerPendingEntry<TClaim> = {
          state: 'pending',
          identity,
          payloadDigest,
          claimedAt: now(),
          claim,
        };
        const committed = await kv.conditionalBatch(
          [{ key, expectedValue: null }],
          [{ type: 'set', key, value: JSON.stringify(entry) }],
        );
        if (committed) return { outcome: 'claimed', entry };
        // Another attempt claimed the identity between the read and the
        // write. Re-read and resolve against what it wrote.
      }
      throw new Error(
        `Command ledger could not claim request "${identity.requestId}" ` +
          `within ${COMMAND_LEDGER_MAX_CAS_ATTEMPTS} compare-and-swap attempts.`,
      );
    },

    async complete(entry, result) {
      const key = entryKey(entry.identity);
      const expected = JSON.stringify(entry);
      const completed: CommandLedgerCompletedEntry<TClaim, TResult> = {
        ...entry,
        state: 'completed',
        completedAt: now(),
        result,
      };
      const committed = await kv.conditionalBatch(
        [{ key, expectedValue: expected }],
        [{ type: 'set', key, value: JSON.stringify(completed) }],
      );
      if (!committed) {
        throw new Error(
          `Command-ledger entry for request "${entry.identity.requestId}" is no longer pending ` +
            'as claimed, so its result was not recorded.',
        );
      }
      return completed;
    },

    async release(entry) {
      const key = entryKey(entry.identity);
      return kv.conditionalBatch(
        [{ key, expectedValue: JSON.stringify(entry) }],
        [{ type: 'delete', key }],
      );
    },

    async read(identity) {
      const key = entryKey(identity);
      const raw = await kv.get(key);
      return raw === null ? undefined : parseEntry<TClaim, TResult>(key, raw);
    },

    async listConflicts(identity) {
      const conflicts: CommandLedgerConflictEntry[] = [];
      for (const key of await kv.list(conflictKeyPrefix(identity))) {
        const conflict = parseConflict(key, await kv.get(key));
        if (conflict !== undefined) conflicts.push(conflict);
      }
      return conflicts;
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
  const canonical = Object.keys(payload)
    .filter((key) => payload[key] !== undefined)
    .toSorted()
    .map((key) => [key, payload[key]] as const);
  return sha256HexSync(JSON.stringify(canonical));
}

/**
 * The digest of a run-creation request's payload: everything that decides
 * which run it creates. The caller and the request id are the identity, not
 * the payload, and the request context carries per-attempt credentials and
 * tracing that legitimately differ between retries, so none of them count.
 */
export function digestRunCreationPayload(request: CreateRunRequest): string {
  return digestCommandPayload({
    message: request.message,
    sessionId: request.sessionId?.trim(),
    systemPrompt: request.systemPrompt,
    maximumSteps: request.maximumSteps,
    maximumTokens: request.maximumTokens,
    agentName: request.agentName,
  });
}

/**
 * The durable receipt for a run-creation command: which run the request
 * created, the request that created it, when it was claimed, and the run's
 * status at creation. A retry of the same request receives the same receipt.
 */
export interface RunCreationReceipt {
  readonly runId: string;
  readonly requestId: string;
  readonly createdAt: string;
  /**
   * The run's status when the receipt was issued: a `RunSummary` status, or
   * `pending` for a run that was claimed but has not started.
   */
  readonly status: string;
}

/** What a run-creation claim reserves before the run exists. */
export interface RunCreationClaim {
  readonly runId: string;
  readonly sessionId: string;
  readonly agentName: string;
}

/** What a completed run-creation entry records for later retries. */
export interface RunCreationLedgerResult {
  readonly receipt: RunCreationReceipt;
  readonly summary: RunSummary;
}

/** `createRun`'s result: the run's summary, with its receipt when the request named a request id. */
export type CreatedRunSummary = RunSummary & { readonly receipt?: RunCreationReceipt | undefined };

/** What the Bureau can see of a claimed run when a retry arrives. */
export interface RunCreationObservation {
  /** The run as this process's run store has it, if it does. */
  readonly live: RunSummary | undefined;
  /** The durable engine's status, `null` when it has no such run, `undefined` without an engine. */
  readonly durableStatus: WorkflowState['status'] | null | undefined;
}

/** One run-creation request's identity and payload, with what it would claim. */
export interface BeginRunCreationInput {
  readonly callerId: string;
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
      complete(summary: RunSummary): Promise<CreatedRunSummary>;
      release(cause: unknown): Promise<void>;
    };

export interface CreateRunCreationLedgerOptions {
  readonly kv: ConditionalTextValueStore;
  readonly clock: Pick<RuntimeClock, 'nowISO'>;
  readonly identifiers: RuntimeIdentifiers;
  /** Looks up the run a claim reserved. */
  readonly observe: (claim: RunCreationClaim) => Promise<RunCreationObservation>;
}

export interface RunCreationLedger {
  readonly ledger: CommandLedger<RunCreationClaim, RunCreationLedgerResult>;
  begin(input: BeginRunCreationInput): Promise<RunCreationAttempt>;
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

/**
 * The run-creation command ledger. See the module doc for how a retry is
 * resolved against a pending or completed entry.
 */
export function createRunCreationLedger(
  options: CreateRunCreationLedgerOptions,
): RunCreationLedger {
  const { clock, identifiers, observe } = options;
  const ledger = createCommandLedger<RunCreationClaim, RunCreationLedgerResult>({
    kv: options.kv,
    now: () => clock.nowISO(),
    nextConflictId: () => identifiers.next('command-ledger-conflict'),
  });
  // Attempts this process claimed and has not yet settled, by ledger key.
  const inFlight = new Map<string, Promise<CreatedRunSummary>>();

  async function replayCompleted(
    entry: CommandLedgerCompletedEntry<RunCreationClaim, RunCreationLedgerResult>,
  ): Promise<CreatedRunSummary> {
    const { live, durableStatus } = await observe(entry.claim);
    const stored = entry.result.summary;
    const summary = live ?? {
      ...stored,
      status: runStatusFromDurable(durableStatus) ?? stored.status,
    };
    return { ...summary, receipt: entry.result.receipt };
  }

  async function replayPending(
    entry: CommandLedgerPendingEntry<RunCreationClaim>,
  ): Promise<CreatedRunSummary> {
    const { live, durableStatus } = await observe(entry.claim);
    const status = live?.status ?? runStatusFromDurable(durableStatus) ?? 'pending';
    // Without a live run this process has observed none of the run's work,
    // so it reports none. A run that never started has done none.
    const summary: RunSummary = live ?? {
      id: entry.claim.runId,
      sessionId: entry.claim.sessionId,
      status,
      steps: 0,
      usage: { prompt: 0, completion: 0, total: 0 },
      finishReason: undefined,
      error: undefined,
      actionCount: 0,
      agentName: entry.claim.agentName,
      principal: entry.identity.callerId,
      startedAt: undefined,
    };
    const receipt: RunCreationReceipt = {
      runId: entry.claim.runId,
      requestId: entry.identity.requestId,
      createdAt: entry.claimedAt,
      status,
    };
    return { ...summary, receipt };
  }

  return {
    ledger,
    async begin(input) {
      const identity: CommandLedgerIdentity = {
        callerId: input.callerId,
        requestId: input.requestId,
        operationVersion: RUN_CREATION_OPERATION_VERSION,
      };
      const key = entryKey(identity);
      const outcome = await ledger.claim(identity, input.payloadDigest, input.claim);

      if (outcome.outcome === 'existing') {
        const existing = outcome.entry;
        if (existing.state === 'completed') {
          return { kind: 'replay', result: await replayCompleted(existing) };
        }
        const pending = inFlight.get(key);
        return {
          kind: 'replay',
          result: pending !== undefined ? await pending : await replayPending(existing),
        };
      }

      // Registered synchronously on resuming from the claim, before any
      // other continuation can observe the pending entry this claim wrote.
      const entry = outcome.entry;
      const settlement = Promise.withResolvers<CreatedRunSummary>();
      // An attempt nobody is waiting on may still fail; its caller sees that
      // failure directly, so it must not also surface as an unhandled rejection.
      settlement.promise.catch(() => {});
      inFlight.set(key, settlement.promise);
      const settle = () => {
        if (inFlight.get(key) === settlement.promise) inFlight.delete(key);
      };

      return {
        kind: 'claimed',
        async complete(summary) {
          const receipt: RunCreationReceipt = {
            runId: entry.claim.runId,
            requestId: entry.identity.requestId,
            createdAt: entry.claimedAt,
            status: summary.status,
          };
          try {
            await ledger.complete(entry, { receipt, summary });
          } catch (error) {
            settlement.reject(error);
            throw error;
          } finally {
            settle();
          }
          const created: CreatedRunSummary = { ...summary, receipt };
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
