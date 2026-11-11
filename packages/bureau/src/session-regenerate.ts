/**
 * Regenerating a context's latest answer without running a tool (COR-2296): which answer may be
 * regenerated, why one is refused, the durable command record that makes a retry safe, and the
 * receipt the replacement commits beside itself.
 *
 * Regeneration replaces one row: the last assistant reply of the context's newest run, which must
 * have ended. Every other row (the user's message, earlier replies, tool calls, tool results and
 * approvals) is kept as it is. The model is asked once, over the history before that reply, with a
 * toolbox that holds no tool; an answer that asks for a tool is refused, so nothing is executed.
 *
 * A command is made safe to retry in two durable parts. The command ledger (`command-ledger.ts`)
 * binds the caller's command to one attempt before the model is asked, so a duplicate never asks
 * it again. The replacement itself is one compare-and-swap on the session, fenced on the
 * incarnation and revision the attempt read, and the same commit appends a receipt to the session
 * outbox under {@link REGENERATE_RECEIPT_OUTBOX_NAMESPACE}. The outbox drain completes the ledger
 * from that receipt before it acknowledges the entry, so an attempt that committed and then died
 * is completed, and its retry answered, without another model call. A pending command with no
 * receipt is in doubt: it is answered as such, and the original answer stays.
 *
 * @module session-regenerate
 */

import type { AgentSession, JSONValue } from '@lostgradient/operative';
import type { RuntimeServices } from '@lostgradient/lifecycle';
import {
  type ConditionalTextValueStore,
  MemoryStorage,
  textValueStore,
} from '@lostgradient/storage';
import { type ConversationHistory, getOwn, type Message } from 'conversationalist';

import {
  type CommandLedger,
  type CommandLedgerIdentity,
  createCommandLedger,
} from './command-ledger';

/** The key prefix of the regeneration command ledger, apart from every other ledger's. */
export const REGENERATE_LEDGER_KEY_PREFIX = 'command-ledger:regenerate:v1';

/** The version of the regeneration command contract the ledger keys on. */
export const REGENERATE_OPERATION_VERSION = 'bureau.contexts.regenerate.v1';

/**
 * The session outbox namespace a regeneration's receipt is attached under, in the same commit as
 * the answer it replaced. Only this Bureau writes it; the drain completes the command ledger from
 * it before acknowledging it.
 */
export const REGENERATE_RECEIPT_OUTBOX_NAMESPACE = 'bureau.contexts.regenerate.v1';

/** Why a regeneration was refused. Each is stable: the management plane carries it as `data.reason`. */
export type SessionRegenerateRefusalReason =
  /** The message is not in this context's history. */
  | 'message-not-found'
  /** The message is not the last assistant reply of a run of this context that has ended. */
  | 'not-a-branch-point'
  /** The message's run still has a tool approval waiting. */
  | 'branch-with-pending-approval'
  /** The message's step has a tool call with no result. */
  | 'branch-with-unresolved-tool-call'
  /** A row follows the message, or a newer run of the context exists or is still going. */
  | 'not-latest-answer'
  /** The context changed, or was deleted or created again, after the attempt read it. */
  | 'history-changed'
  /** The model's answer asked for a tool, which regeneration never runs. */
  | 'answer-has-tool-calls'
  /** The model could not answer: it failed, refused by policy, or answered with no text. */
  | 'generation-failed'
  /** The caller's request was aborted before the answer was committed. */
  | 'aborted'
  /** The command identifier was used to regenerate another message. */
  | 'command-conflict'
  /** An earlier attempt of the command is pending and left no receipt: it may still commit. */
  | 'command-in-doubt';

/** A regeneration that was refused. The context's history is unchanged. */
export class SessionRegenerateRefusedError extends Error {
  /** Why the regeneration was refused. */
  readonly reason: SessionRegenerateRefusalReason;

  constructor(reason: SessionRegenerateRefusalReason, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SessionRegenerateRefusedError';
    this.reason = reason;
  }
}

/** What {@link BureauContexts.regenerate} takes. */
export interface RegenerateSessionRequest {
  /** The caller's owner of record: the command ledger's identity. Authorization is the caller's. */
  readonly owner: string;
  /** The caller's own identifier for the command; an exact retry of it returns the original result. */
  readonly commandId: string;
  /** The last assistant reply of the context's newest run, which has ended: the answer replaced. */
  readonly messageId: string;
  /**
   * Aborts the attempt: an answer that arrives after it is discarded, and nothing is committed.
   * A replacement already committed stands.
   */
  readonly signal?: AbortSignal | undefined;
}

/** What {@link BureauContexts.regenerate} answers, and what the ledger and the receipt keep. */
export type RegenerateSessionResult = {
  /** The context whose answer was replaced. */
  readonly contextId: string;
  /** The replaced answer's message id, which the new answer keeps. */
  readonly messageId: string;
  /** The incarnation of the context the answer was replaced in. */
  readonly incarnation: string;
  /** The session revision the attempt read, and the replacement was fenced on. */
  readonly previousRevision: number;
  /** The session revision the replacement committed. */
  readonly revision: number;
};

/** What a first attempt records before it asks the model: the fence it read. */
export type RegenerateLedgerClaim = {
  /** The incarnation of the context when the attempt read it. */
  readonly incarnation: string;
  /** The session revision when the attempt read it. */
  readonly revision: number;
};

/**
 * The receipt a replacement commits to the session outbox: the command it answers, the digest of
 * its payload, and its result. It holds identifiers and revisions only, never the answer's text.
 */
export type RegenerateReceipt = {
  /** The command's ledger identity. */
  readonly identity: CommandLedgerIdentity;
  /** The digest of the command's payload. */
  readonly payloadDigest: string;
  /** The result the command answers. */
  readonly result: RegenerateSessionResult;
};

/** `receipt` as the JSON the session outbox stores. */
export function regenerateReceiptPayload(receipt: RegenerateReceipt): JSONValue {
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
      messageId: result.messageId,
      incarnation: result.incarnation,
      previousRevision: result.previousRevision,
      revision: result.revision,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** A stored receipt, or `undefined` for a payload that is not one. */
export function parseRegenerateReceipt(value: unknown): RegenerateReceipt | undefined {
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
  const messageId = result['messageId'];
  const incarnation = result['incarnation'];
  const previousRevision = result['previousRevision'];
  const revision = result['revision'];
  if (
    typeof callerId !== 'string' ||
    typeof target !== 'string' ||
    typeof requestId !== 'string' ||
    typeof operationVersion !== 'string' ||
    typeof contextId !== 'string' ||
    typeof messageId !== 'string' ||
    typeof incarnation !== 'string' ||
    !isRevision(previousRevision) ||
    !isRevision(revision)
  ) {
    return undefined;
  }
  return {
    identity: { callerId, target, requestId, operationVersion },
    payloadDigest,
    result: { contextId, messageId, incarnation, previousRevision, revision },
  };
}

/** Whether two ledger identities name the same command. */
export function sameRegenerateIdentity(
  left: CommandLedgerIdentity,
  right: CommandLedgerIdentity,
): boolean {
  return (
    left.callerId === right.callerId &&
    left.target === right.target &&
    left.requestId === right.requestId &&
    left.operationVersion === right.operationVersion
  );
}

/**
 * Whether `receipt` answers the pending claim `claim` of `identity` with `payloadDigest`: the same
 * command, the same payload, and the fence the claim recorded. A receipt that does not is never
 * used to complete the claim.
 */
export function receiptAnswersClaim(
  receipt: RegenerateReceipt,
  identity: CommandLedgerIdentity,
  payloadDigest: string,
  claim: RegenerateLedgerClaim,
): boolean {
  return (
    sameRegenerateIdentity(receipt.identity, identity) &&
    receipt.payloadDigest === payloadDigest &&
    receipt.result.contextId === identity.target &&
    receipt.result.incarnation === claim.incarnation &&
    receipt.result.previousRevision === claim.revision &&
    receipt.result.revision === claim.revision + 1
  );
}

/**
 * `history` without the row `messageId`: what the model is asked to answer when the answer at
 * `messageId` is regenerated. Every other row, and the order of the rows, is kept.
 */
export function historyBeforeAnswer(
  history: ConversationHistory,
  messageId: string,
): ConversationHistory {
  const ids = history.ids.filter((id) => id !== messageId);
  const messages: Record<string, Message> = Object.fromEntries(
    ids.flatMap((id) => {
      const message = getOwn(history.messages, id);
      return message === undefined ? [] : [[id, message] as const];
    }),
  );
  return { ...history, ids, messages };
}

/**
 * `session` with the row `messageId` replaced by `answer`, in the live history and in every run's
 * conversation boundary that holds the row's body, so a fork through that run reads the new
 * answer, not the old one. Nothing else changes: the ids, their order and every other row stay.
 */
export function replaceSessionAnswer(
  session: AgentSession,
  messageId: string,
  answer: Message,
  updatedAt: string,
): AgentSession {
  const history = session.conversationHistory;
  return {
    ...session,
    conversationHistory: {
      ...history,
      messages: { ...history.messages, [messageId]: answer },
      updatedAt,
    },
    runs: session.runs.map((run) => {
      const boundary = run.conversationBoundary;
      if (boundary === undefined || getOwn(boundary.messages, messageId) === undefined) return run;
      return {
        ...run,
        conversationBoundary: {
          ...boundary,
          messages: { ...boundary.messages, [messageId]: answer },
        },
      };
    }),
  };
}

/**
 * The regeneration command ledger over `kv`, or over memory for a Bureau with no store: a retry
 * then lasts as long as the process does.
 */
export function createRegenerateLedger(
  kv: ConditionalTextValueStore | undefined,
  services: Pick<RuntimeServices, 'clock' | 'identifiers'>,
): CommandLedger<RegenerateLedgerClaim, RegenerateSessionResult> {
  return createCommandLedger<RegenerateLedgerClaim, RegenerateSessionResult>({
    kv: kv ?? textValueStore(new MemoryStorage()),
    keyPrefix: REGENERATE_LEDGER_KEY_PREFIX,
    clock: services.clock,
    nextConflictId: () => services.identifiers.next('command-ledger-conflict'),
  });
}
