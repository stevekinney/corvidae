/**
 * Discarding a context's last unfinished turn (COR-2437): which turn may be discarded, why one is
 * refused, the durable command record that makes a retry safe, and the receipt the removal
 * commits beside itself.
 *
 * A turn is what one run added to the conversation after the message that started it: its
 * replies, tool calls, tool results and the answers the person gave its questions. Discarding
 * removes those rows and keeps the person's message, so the chat reads as if the run had written
 * nothing. Only the context's last run may be discarded, and only once it has ended without
 * finishing: the person stopped it, or it failed. A run still going, one that finished normally,
 * one a follow-up was delivered into, and one with a follow-up still queued are refused, each for
 * its own reason, so nothing the person sent is lost or left answering a turn that is gone.
 *
 * The removal is one compare-and-swap on the session, fenced on the incarnation and revision the
 * attempt read and judged again on what it writes over, and the same commit appends two outbox
 * entries: the receipt under {@link DISCARD_RECEIPT_OUTBOX_NAMESPACE}, from which the drain
 * completes the command ledger, and the audit entry under the review audit namespace, which the
 * drain replays into the audit trail exactly once. Nothing is visible before that commit, and a
 * process that stops after it leaves both entries for the next drain.
 *
 * The task record of the run is not rewritten: it holds how the run ended and the person's own
 * message, both still true after the discard, and never the reply's text.
 *
 * @module session-discard
 */

import type { AgentSession, JSONValue } from '@lostgradient/operative';
import { parseStepRowIdentifier } from '@lostgradient/operative';
import type { RuntimeServices } from '@lostgradient/lifecycle';
import {
  type ConditionalTextValueStore,
  MemoryStorage,
  textValueStore,
} from '@lostgradient/storage';
import { getOwn, type Message } from 'conversationalist';

import {
  type CommandLedger,
  type CommandLedgerIdentity,
  createCommandLedger,
} from './command-ledger';

/** The key prefix of the discard command ledger, apart from every other ledger's. */
export const DISCARD_LEDGER_KEY_PREFIX = 'command-ledger:discard-turn:v1';

/** The version of the discard command contract the ledger keys on. */
export const DISCARD_OPERATION_VERSION = 'bureau.contexts.discardturn.v1';

/**
 * The session outbox namespace a discard's receipt is attached under, in the same commit as the
 * removal. Only this Bureau writes it; the drain completes the command ledger from it before
 * acknowledging it.
 */
export const DISCARD_RECEIPT_OUTBOX_NAMESPACE = 'bureau.contexts.discardturn.v1';

/** The audit entry type a discard records, under the run whose turn it removed. */
export const DISCARD_AUDIT_TYPE = 'context.turn-discarded';

/**
 * The metadata key a follow-up the run delivered into its turn carries (operative's
 * `SESSION_INPUT_COMMAND_ID_METADATA_KEY`): the row is the person's message, never the run's.
 */
const SESSION_INPUT_COMMAND_ID_METADATA_KEY = 'sessionInputCommandId';

/** Why a discard was refused. Each is stable: the management plane carries it as `data.reason`. */
export type SessionDiscardRefusalReason =
  /** The run is not one of this context's runs. */
  | 'run-not-found'
  /** A later run of the context exists, or a row the run did not write follows its turn. */
  | 'not-latest-turn'
  /** The run is still going (streaming, or waiting on an approval or a question): cancel it first. */
  | 'turn-running'
  /**
   * The process that was running the run stopped before the run recorded its end, so the run may
   * still be recovered and write again.
   */
  | 'turn-outcome-unknown'
  /** The run finished normally: its answer is the turn, and it is kept. */
  | 'turn-finished'
  /** A follow-up the person sent while the run went on was delivered into its turn. */
  | 'follow-up-delivered'
  /** A follow-up the person sent is still queued for the context. */
  | 'follow-ups-queued'
  /** The run ended before it wrote anything after the person's message. */
  | 'nothing-to-discard'
  /** The context changed, or was deleted or created again, after the attempt read it. */
  | 'history-changed'
  /** The command identifier was used to discard another run's turn. */
  | 'command-conflict'
  /** An earlier attempt of the command is pending and left no receipt: it may still commit. */
  | 'command-in-doubt';

/** A discard that was refused. The context's history is unchanged. */
export class SessionDiscardRefusedError extends Error {
  /** Why the discard was refused. */
  readonly reason: SessionDiscardRefusalReason;

  constructor(reason: SessionDiscardRefusalReason, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SessionDiscardRefusedError';
    this.reason = reason;
  }
}

/** What {@link BureauContexts.discardTurn} takes. */
export interface DiscardTurnRequest {
  /** The caller's owner of record: the command ledger's identity. Authorization is the caller's. */
  readonly owner: string;
  /** The caller's own identifier for the command; an exact retry of it returns the original result. */
  readonly commandId: string;
  /** The context's last run, which ended without finishing: the turn removed is the one it wrote. */
  readonly runId: string;
}

/** What {@link BureauContexts.discardTurn} answers, and what the ledger and the receipt keep. */
export type DiscardTurnResult = {
  /** The context whose turn was discarded. */
  readonly contextId: string;
  /** The run whose turn was discarded. */
  readonly runId: string;
  /** How many rows the discard removed. */
  readonly removed: number;
  /** The incarnation of the context the turn was discarded in. */
  readonly incarnation: string;
  /** The session revision the attempt read, and the removal was fenced on. */
  readonly previousRevision: number;
  /** The session revision the removal committed. */
  readonly revision: number;
};

/** What a first attempt records before it writes: the fence it read. */
export type DiscardLedgerClaim = {
  /** The incarnation of the context when the attempt read it. */
  readonly incarnation: string;
  /** The session revision when the attempt read it. */
  readonly revision: number;
};

/**
 * The receipt a removal commits to the session outbox: the command it answers, the digest of its
 * payload, and its result. It holds identifiers, a count and revisions only, never a row's text.
 */
export type DiscardReceipt = {
  /** The command's ledger identity. */
  readonly identity: CommandLedgerIdentity;
  /** The digest of the command's payload. */
  readonly payloadDigest: string;
  /** The result the command answers. */
  readonly result: DiscardTurnResult;
};

/** `receipt` as the JSON the session outbox stores. */
export function discardReceiptPayload(receipt: DiscardReceipt): JSONValue {
  const { identity, result } = receipt;
  return {
    identity: {
      callerId: identity.callerId,
      target: identity.target,
      requestId: identity.requestId,
      operationVersion: identity.operationVersion,
    },
    payloadDigest: receipt.payloadDigest,
    result: {
      contextId: result.contextId,
      runId: result.runId,
      removed: result.removed,
      incarnation: result.incarnation,
      previousRevision: result.previousRevision,
      revision: result.revision,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** A stored receipt, or `undefined` for a payload that is not one. */
export function parseDiscardReceipt(value: unknown): DiscardReceipt | undefined {
  if (!isRecord(value)) return undefined;
  const identity = value['identity'];
  const result = value['result'];
  const payloadDigest = value['payloadDigest'];
  if (!isRecord(identity) || !isRecord(result) || typeof payloadDigest !== 'string') {
    return undefined;
  }
  const callerId = identity['callerId'];
  const target = identity['target'];
  const requestId = identity['requestId'];
  const operationVersion = identity['operationVersion'];
  const contextId = result['contextId'];
  const runId = result['runId'];
  const removed = result['removed'];
  const incarnation = result['incarnation'];
  const previousRevision = result['previousRevision'];
  const revision = result['revision'];
  if (
    typeof callerId !== 'string' ||
    typeof target !== 'string' ||
    typeof requestId !== 'string' ||
    typeof operationVersion !== 'string' ||
    typeof contextId !== 'string' ||
    typeof runId !== 'string' ||
    !isCount(removed) ||
    typeof incarnation !== 'string' ||
    !isCount(previousRevision) ||
    !isCount(revision)
  ) {
    return undefined;
  }
  return {
    identity: { callerId, target, requestId, operationVersion },
    payloadDigest,
    result: { contextId, runId, removed, incarnation, previousRevision, revision },
  };
}

/**
 * Whether `receipt` answers the pending claim `claim` of `identity` with `payloadDigest`: the same
 * command, the same payload, and the fence the claim recorded. A receipt that does not is never
 * used to complete the claim.
 */
export function discardReceiptAnswersClaim(
  receipt: DiscardReceipt,
  identity: CommandLedgerIdentity,
  payloadDigest: string,
  claim: DiscardLedgerClaim,
): boolean {
  return (
    receipt.identity.callerId === identity.callerId &&
    receipt.identity.target === identity.target &&
    receipt.identity.requestId === identity.requestId &&
    receipt.identity.operationVersion === identity.operationVersion &&
    receipt.payloadDigest === payloadDigest &&
    receipt.result.contextId === identity.target &&
    receipt.result.incarnation === claim.incarnation &&
    receipt.result.previousRevision === claim.revision &&
    receipt.result.revision === claim.revision + 1
  );
}

/** A turn that may be discarded: the rows the run wrote, in order. */
export type DiscardableTurn = { readonly ok: true; readonly removed: readonly string[] };

/** A turn that may not be, and why. */
export type UndiscardableTurn = {
  readonly ok: false;
  readonly reason: SessionDiscardRefusalReason;
  readonly message: string;
};

/** Whether `id` is a row run `runId` wrote: a step's text, call or result, or an answer to its question. */
function isRowOfRun(id: string, runId: string): boolean {
  return parseStepRowIdentifier(id)?.runId === runId || id.startsWith(`${runId}:signal:`);
}

/**
 * Judges whether the turn of `runId` may be discarded from `session`'s history as it stands, and
 * names its rows when it may. Pure, so the removal judges again what it writes over. Which run is
 * the context's last, and whether it ended without finishing, are the task registry's to say; a
 * session that also keeps a ref of the run (`AgentSession.runs`) is held to it as well.
 *
 * The turn starts at the first row the run wrote (every row a run writes carries its id: a step's
 * text, call or result, or an answer to its question) and runs to the end of the history, so the
 * person's message that started it, which a Bureau run does not name by the run, stays.
 */
export function judgeDiscardableTurn(
  session: AgentSession,
  runId: string,
): DiscardableTurn | UndiscardableTurn {
  const refuse = (reason: SessionDiscardRefusalReason, message: string): UndiscardableTurn => ({
    ok: false,
    reason,
    message,
  });
  const ref = session.runs.find((candidate) => candidate.runId === runId);
  if (ref !== undefined && session.runs.at(-1)?.runId !== runId) {
    return refuse('not-latest-turn', 'Only the turn of the context’s last run can be discarded.');
  }
  if (ref?.status === 'running') {
    return refuse('turn-running', 'The turn is still going: cancel it before discarding it.');
  }
  if (ref?.status === 'completed') {
    return refuse('turn-finished', 'The turn finished normally, and a finished turn is kept.');
  }
  const ids = session.conversationHistory.ids;
  const start = ids.findIndex((id) => isRowOfRun(id, runId));
  const turn = start === -1 ? [] : ids.slice(start);
  for (const id of turn) {
    if (isRowOfRun(id, runId)) continue;
    const row = getOwn(session.conversationHistory.messages, id);
    if (row?.metadata?.[SESSION_INPUT_COMMAND_ID_METADATA_KEY] !== undefined) {
      return refuse(
        'follow-up-delivered',
        'A follow-up the person sent was delivered into the turn, and discarding would lose it.',
      );
    }
    return refuse('not-latest-turn', 'A row the run did not write follows its turn.');
  }
  if (turn.length === 0) {
    return refuse('nothing-to-discard', 'The run wrote nothing after the person’s message.');
  }
  return { ok: true, removed: turn };
}

function withoutRows(
  messages: Readonly<Record<string, Message>>,
  removed: ReadonlySet<string>,
): Record<string, Message> {
  return Object.fromEntries(Object.entries(messages).filter(([id]) => !removed.has(id)));
}

/**
 * `session` without the rows `removed` of the turn of `runId`, in the live history and in that
 * run's own conversation boundary, so a fork through the run reads the turn as discarded too. The
 * run is the context's last, so no later boundary is encoded against the one rewritten here.
 */
export function removeSessionTurn(
  session: AgentSession,
  runId: string,
  removed: readonly string[],
  updatedAt: string,
): AgentSession {
  const gone = new Set(removed);
  const history = session.conversationHistory;
  return {
    ...session,
    conversationHistory: {
      ...history,
      ids: history.ids.filter((id) => !gone.has(id)),
      messages: withoutRows(history.messages, gone),
      updatedAt,
    },
    runs: session.runs.map((run) => {
      const boundary = run.conversationBoundary;
      if (run.runId !== runId || boundary === undefined) return run;
      return {
        ...run,
        conversationBoundary: {
          ...boundary,
          ids: boundary.ids.filter((id) => !gone.has(id)),
          messages: withoutRows(boundary.messages, gone),
        },
      };
    }),
  };
}

/**
 * The discard command ledger over `kv`, or over memory for a Bureau with no store: a retry then
 * lasts as long as the process does.
 */
export function createDiscardLedger(
  kv: ConditionalTextValueStore | undefined,
  services: Pick<RuntimeServices, 'clock' | 'identifiers'>,
): CommandLedger<DiscardLedgerClaim, DiscardTurnResult> {
  return createCommandLedger<DiscardLedgerClaim, DiscardTurnResult>({
    kv: kv ?? textValueStore(new MemoryStorage()),
    keyPrefix: DISCARD_LEDGER_KEY_PREFIX,
    clock: services.clock,
    nextConflictId: () => services.identifiers.next('command-ledger-conflict'),
  });
}
