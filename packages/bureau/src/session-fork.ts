/**
 * Branching a session after a completed agent reply (COR-1560): which messages are a branch point,
 * why one is refused, and the durable command record that makes a retry safe.
 *
 * A Bureau session keeps no per-run records of its own (`AgentSession.runs` stays empty), so a
 * branch point is found from what Bureau does keep. The message id of an assistant step names its
 * run (`<runId>:step:<n>`, read back by Operative's `parseAssistantMessageIdentifier`), and the
 * task registry holds one durable record per run: its context, the session incarnation, and how it
 * ended. A message is a branch point only when all of these hold:
 *
 * - it is in this session's stored history, as an assistant row of a run's step;
 * - the registry holds that run's record, and the record belongs to this session;
 * - it is the last assistant row of that run in the history;
 * - the run has no pending tool approval, ended `completed` (not in error, not aborted), and left
 *   no tool call of that message without a result.
 *
 * @module session-fork
 */

import { type AgentSession, parseAssistantMessageIdentifier } from '@lostgradient/operative';

import type { RuntimeServices } from '@lostgradient/lifecycle';
import { type ConditionalTextValueStore, MemoryStorage, textValueStore } from '@lostgradient/weft';

import { type CommandLedger, createCommandLedger } from './command-ledger';
import type { SteeringCommandAdmissionOutcome } from './steering';
import { belongsToIncarnation, type TaskRecord } from './task-registry';

/** The key prefix of the fork command ledger (COR-424), apart from every other ledger's. */
export const FORK_LEDGER_KEY_PREFIX = 'command-ledger:fork:v1';

/** The version of the fork command contract the ledger keys on. */
export const FORK_OPERATION_VERSION = 'bureau.fork.v1';

/** Why a fork was refused. Each is stable: the management plane carries it as `data.reason`. */
export type SessionForkRefusalReason =
  /** The message is not in this session's history. */
  | 'message-not-found'
  /** The message is not the final assistant message of a run that has ended in this session. */
  | 'not-a-branch-point'
  /** The message's run ended in error. */
  | 'branch-from-errored-run'
  /** The message's run was aborted. */
  | 'branch-from-aborted-run'
  /** The message's run still has an unresolved tool approval. */
  | 'branch-with-pending-approval'
  /** The message has a tool call with no matching result. */
  | 'branch-with-unresolved-tool-call'
  /** The command identifier was used for a different branch. */
  | 'command-conflict';

/** A fork that was refused. Nothing was created. */
export class SessionForkRefusedError extends Error {
  readonly reason: SessionForkRefusalReason;

  constructor(reason: SessionForkRefusalReason, message: string) {
    super(message);
    this.name = 'SessionForkRefusedError';
    this.reason = reason;
  }
}

/** What {@link Bureau.forkSession} takes. */
export interface ForkSessionRequest {
  /** The owner of the new session: the caller's owner of record. Authorization is the caller's. */
  readonly owner: string;
  /** The caller's own identifier for the command; an exact retry of it returns the original result. */
  readonly commandId: string;
  /** The final assistant message of a completed run in the session, which the branch ends at. */
  readonly throughMessageId: string;
}

/** What {@link Bureau.forkSession} answers, and what the ledger keeps for a retry. */
export interface ForkSessionResult {
  /** The new session. */
  readonly contextId: string;
  /**
   * The outcome of admitting the parent's `model` override on the new session, as
   * `<commandId>:model`; `null` when the parent had none. A refused admission (the override is no
   * longer allowed) leaves the fork in place, running on the agent's default.
   */
  readonly carriedOverride: SteeringCommandAdmissionOutcome | null;
}

/** What a first attempt records before it forks, so a retry finds the fork and never makes a second. */
export interface ForkLedgerClaim {
  /** The identifier the fork is created under, minted before it is created. */
  readonly contextId: string;
  /** The parent's model override when the attempt began; `null` when it had none. */
  readonly override: { readonly provider: string | null; readonly model: string } | null;
}

/** What the branch-point checks read besides the session. */
export interface BranchPointEvidence {
  /** The registry's record of the run, or `undefined` when it holds none. */
  readonly record: (
    runId: string,
  ) => Promise<Pick<TaskRecord, 'contextId' | 'incarnation' | 'settled'> | undefined>;
  /** The review identifiers of the run's tool approvals that are still pending. */
  readonly pendingApprovals: (runId: string) => Promise<readonly string[]>;
}

/**
 * Decides whether `throughMessageId` is a branch point in `session`, throwing a
 * {@link SessionForkRefusedError} naming why when it is not.
 */
export async function assertBranchPoint(
  session: AgentSession,
  throughMessageId: string,
  evidence: BranchPointEvidence,
): Promise<void> {
  const refuse = (reason: SessionForkRefusalReason, message: string): never => {
    throw new SessionForkRefusedError(reason, message);
  };
  const history = session.conversationHistory;
  const message = history.messages[throughMessageId];
  if (message === undefined || !history.ids.includes(throughMessageId)) {
    return refuse('message-not-found', `The context holds no message "${throughMessageId}".`);
  }
  const step = parseAssistantMessageIdentifier(throughMessageId);
  if (step === undefined || message.role !== 'assistant') {
    return refuse('not-a-branch-point', 'Only an assistant reply of a run can be branched from.');
  }
  const { runId } = step;
  const record = await evidence.record(runId);
  if (
    record === undefined ||
    record.contextId !== session.id ||
    !belongsToIncarnation(record, session.incarnation)
  ) {
    return refuse(
      'not-a-branch-point',
      'The run that made this reply is not known to this context.',
    );
  }
  const final = history.ids.findLast((id) => {
    const parsed = parseAssistantMessageIdentifier(id);
    return parsed?.runId === runId && history.messages[id]?.role === 'assistant';
  });
  if (final !== throughMessageId) {
    return refuse(
      'not-a-branch-point',
      'Only the final assistant reply of a run can be branched from.',
    );
  }
  const approvals = await evidence.pendingApprovals(runId);
  if (approvals.length > 0) {
    return refuse('branch-with-pending-approval', 'The run still has a tool approval waiting.');
  }
  const status = record.settled?.status;
  if (status === 'failed') return refuse('branch-from-errored-run', 'The run ended in error.');
  if (status === 'canceled') return refuse('branch-from-aborted-run', 'The run was aborted.');
  if (status === undefined) {
    return refuse('not-a-branch-point', 'The run that made this reply has not ended.');
  }
  const answered = new Set(
    history.ids.flatMap((id) => {
      const callId = history.messages[id]?.toolResult?.callId;
      return callId === undefined ? [] : [callId];
    }),
  );
  const unresolved = history.ids.some((id) => {
    const row = history.messages[id];
    return (
      row?.role === 'tool-call' &&
      id.startsWith(`${throughMessageId}:call:`) &&
      row.toolCall !== undefined &&
      !answered.has(row.toolCall.id)
    );
  });
  if (unresolved) {
    return refuse('branch-with-unresolved-tool-call', 'The reply has a tool call with no result.');
  }
}

/**
 * The fork command ledger over `kv`, or over memory for a Bureau with no store: a retry then
 * lasts as long as the process does.
 */
export function createForkLedger(
  kv: ConditionalTextValueStore | undefined,
  services: Pick<RuntimeServices, 'clock' | 'identifiers'>,
): CommandLedger<ForkLedgerClaim, ForkSessionResult> {
  return createCommandLedger<ForkLedgerClaim, ForkSessionResult>({
    kv: kv ?? textValueStore(new MemoryStorage()),
    keyPrefix: FORK_LEDGER_KEY_PREFIX,
    clock: services.clock,
    nextConflictId: () => services.identifiers.next('command-ledger-conflict'),
  });
}
