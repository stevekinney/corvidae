/**
 * Rewinding a session (B06, rows 19r and 20c): taking a turn back out of the conversation so the
 * person can send it again, as Retry does for a reply that failed. The conversation from a chosen
 * row to its end is removed and the session answers as if those rows had never been said.
 *
 * It is the one thing that shortens a stored conversation, so it is narrow. It refuses a session
 * a run still holds (a run going, or one parked on a tool approval), because the run is
 * writing to the rows it would remove, and a row the conversation does not hold. Every tool the
 * caller names also loses its "Allow for the rest of this chat" grant, so the call that was
 * interrupted goes back through its approval when the turn is run again.
 *
 * The pending-approval rule here is the one the AG-UI mount decides a thread is busy with, so a
 * start and a rewind never disagree about whether a run holds the thread.
 *
 * @module session-rewind
 */

import type { AgentSession } from '@lostgradient/operative';
import { getOwn, type ConversationHistory } from 'conversationalist';

/** Why a session could not be rewound. */
export type SessionRewindRefusalReason =
  /** The conversation holds no row with that identifier. */
  | 'message-not-found'
  /** A run of the session is going, or is waiting on a tool approval. */
  | 'run-in-progress';

/** What `bureau.contexts.rewind` asks of a session. */
export interface SessionRewindRequest {
  /** The row to remove together with every row after it. */
  readonly fromMessageId: string;
  /**
   * Tools whose "Allow for the rest of this chat" grant the session forgets, by the name a tool
   * call carries. A grant is stored under the tool's identifier (`namespace:name@version`), so a
   * name matches the grants of every version of the tool. A name no grant matches changes nothing.
   */
  readonly forgetGrantsFor?: readonly string[] | undefined;
}

/** What a rewind did, or why it did nothing. */
export type SessionRewindOutcome =
  | {
      readonly outcome: 'rewound';
      /** The identifiers of the rows removed, in conversation order. */
      readonly removed: readonly string[];
      /** The grants forgotten, as they were stored. */
      readonly forgotten: readonly string[];
    }
  | { readonly outcome: 'not-found' }
  | { readonly outcome: SessionRewindRefusalReason };

/** The name of a tool as a grant or a call carries it: `namespace:name@version` reads `name`. */
function toolNameOf(identifier: string): string {
  const unversioned = identifier.split('@')[0] ?? identifier;
  return unversioned.slice(unversioned.lastIndexOf(':') + 1);
}

/** Whether a grant stored under `grant` allows the tool a call names as `name`. */
function grantAllows(grant: string, name: string): boolean {
  return grant === name || toolNameOf(grant) === toolNameOf(name);
}

/**
 * `history` without the row `fromMessageId` and every row after it, with the identifiers removed,
 * or `undefined` when `history` holds no such row.
 */
export function historyBefore(
  history: ConversationHistory,
  fromMessageId: string,
): { readonly history: ConversationHistory; readonly removed: string[] } | undefined {
  const index = history.ids.indexOf(fromMessageId);
  if (index < 0 || getOwn(history.messages, fromMessageId) === undefined) return undefined;
  const ids = history.ids.slice(0, index);
  const messages: Record<string, ConversationHistory['messages'][string]> = {};
  for (const id of ids) {
    const message = getOwn(history.messages, id);
    if (message !== undefined) messages[id] = message;
  }
  return { history: { ...history, ids, messages }, removed: history.ids.slice(index) };
}

/**
 * `session` with its conversation cut before `request.fromMessageId` and the grants of
 * `request.forgetGrantsFor` forgotten, with what each took away. `undefined` when the
 * conversation holds no such row.
 */
export function rewoundSession(
  session: AgentSession,
  request: SessionRewindRequest,
):
  | {
      readonly session: AgentSession;
      readonly removed: readonly string[];
      readonly forgotten: readonly string[];
    }
  | undefined {
  const cut = historyBefore(session.conversationHistory, request.fromMessageId);
  if (cut === undefined) return undefined;
  const held = session.metadata['approvalGrants'];
  const grants = Array.isArray(held)
    ? held.filter((entry): entry is string => typeof entry === 'string')
    : [];
  const names = request.forgetGrantsFor ?? [];
  const forgotten = grants.filter((grant) => names.some((name) => grantAllows(grant, name)));
  const { approvalGrants: _replaced, ...rest } = session.metadata;
  const kept = grants.filter((grant) => !forgotten.includes(grant));
  const metadata =
    forgotten.length === 0
      ? session.metadata
      : kept.length === 0
        ? rest
        : { ...rest, approvalGrants: kept };
  return {
    session: { ...session, conversationHistory: cut.history, metadata },
    removed: cut.removed,
    forgotten,
  };
}

/**
 * Whether `metadata` holds an unexpired tool approval for `runId` in `pendingApprovalOverrides`.
 * Bureau persists the entry when an approval is gated and removes it in the same write as the
 * resolution; an entry whose binding has expired is not pending, by the rule `reviews.list` uses.
 */
export function holdsPendingApproval(
  metadata: AgentSession['metadata'],
  runId: string,
  asOf: number,
): boolean {
  const overrides = metadata['pendingApprovalOverrides'];
  if (typeof overrides !== 'object' || overrides === null || Array.isArray(overrides)) {
    return false;
  }
  return Object.entries(overrides).some(([reviewId, approval]) => {
    if (!reviewId.startsWith(`approval:${runId}:`)) return false;
    const expiresAt = (approval as { approvalBinding?: { expiresAt?: unknown } } | null)
      ?.approvalBinding?.expiresAt;
    return typeof expiresAt !== 'number' || expiresAt > asOf;
  });
}
