/**
 * Branching a session at the end of a turn (COR-1560, COR-1910): which messages are a branch point,
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
 * - the run has ended (a live run's own replies are mid-turn) and has no pending tool approval;
 * - it is the last reply of that run: the final step of a run that `completed`, which has no tool
 *   call without a result, or the last step that has reply text in a run that ended in error or
 *   was aborted. A fork ends at the reply's text row, so the rows of a failed step after it are
 *   not carried, and no tool call without a result is.
 *
 * A fork may also branch before the first message (`throughMessageId: null`), which needs no
 * evidence: it carries no history. An earlier turn of the same context is a branch point whether or
 * not a later run is live, because a fork reads a settled prefix and touches nothing else.
 *
 * @module session-fork
 */

import {
  type AgentSession,
  type Effort,
  type PermissionMode,
  parseStepRowIdentifier,
} from '@lostgradient/operative';
import type { ConversationHistory } from 'conversationalist';

import type { RuntimeServices } from '@lostgradient/lifecycle';
import {
  type ConditionalTextValueStore,
  MemoryStorage,
  textValueStore,
} from '@lostgradient/storage';

import { type CommandLedger, createCommandLedger } from './command-ledger';
import type { SteeringCommandAdmissionOutcome } from './steering';
import { belongsToIncarnation, type TaskRecord } from './task-registry';
import { getOwn } from 'conversationalist';

/** The key prefix of the fork command ledger (COR-424), apart from every other ledger's. */
export const FORK_LEDGER_KEY_PREFIX = 'command-ledger:fork:v1';

/** The version of the fork command contract the ledger keys on. */
export const FORK_OPERATION_VERSION = 'bureau.fork.v1';

/** Why a fork was refused. Each is stable: the management plane carries it as `data.reason`. */
export type SessionForkRefusalReason =
  /** The message is not in this session's history. */
  | 'message-not-found'
  /** The message is not the last assistant reply of a run that has ended in this session. */
  | 'not-a-branch-point'
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

/** What {@link BureauContexts.fork} takes. */
export interface ForkSessionRequest {
  /** The owner of the new session: the caller's owner of record. Authorization is the caller's. */
  readonly owner: string;
  /** The caller's own identifier for the command; an exact retry of it returns the original result. */
  readonly commandId: string;
  /**
   * The last assistant reply of a run that has ended in the session, which the branch ends at, or
   * `null` to branch before the first message (the fork starts empty and records only its parent).
   */
  readonly throughMessageId: string | null;
}

/** What {@link BureauContexts.fork} answers, and what the ledger keeps for a retry. */
export interface ForkSessionResult {
  /** The new session. */
  readonly contextId: string;
  /**
   * The outcome of admitting the parent's `model` override on the new session, as
   * `<commandId>:model`; `null` when the parent had none. A refused admission (the override is no
   * longer allowed) leaves the fork in place, running on the agent's default.
   */
  readonly carriedOverride: SteeringCommandAdmissionOutcome | null;
  /**
   * The outcome of admitting the parent's `effort` on the new session, as `<commandId>:effort`
   * (COR-1935); `null` when the parent had none. A refused admission leaves the fork in place on
   * the effort its agent's request carries. A result the ledger kept before the field existed has
   * none, which reads as `null`.
   */
  readonly carriedEffort?: SteeringCommandAdmissionOutcome | null;
  /**
   * The outcome of admitting the parent's `permission-mode` on the new session, as
   * `<commandId>:permission-mode` (COR-1936); `null` when the parent had none. A branch is the
   * same conversation, so it keeps the mode its parent was in. A result the ledger kept before the
   * field existed has none, which reads as `null`.
   */
  readonly carriedPermissionMode?: SteeringCommandAdmissionOutcome | null;
}

/**
 * How an attempt ended when the branch could not be made after it had been claimed: the parent
 * session or the message went away between the checks and the fork (a fork before the first message
 * names no message, so only the parent can). The ledger keeps it as the
 * entry's result, so the command does not stay pending and an exact retry is refused the same way.
 */
export interface ForkLedgerFailure {
  readonly failure: {
    /**
     * `message-not-found` when the message went away; `context-not-found` when the parent did,
     * which a fork before the first message (no message to name) settles to.
     */
    readonly reason: 'message-not-found' | 'context-not-found';
    readonly message: string;
  };
}

/** What the fork ledger keeps for a command: the answer it gave, or the failure it settled to. */
export type ForkLedgerResult = ForkSessionResult | ForkLedgerFailure;

/** What a first attempt records before it forks, so a retry finds the fork and never makes a second. */
export interface ForkLedgerClaim {
  /** The identifier the fork is created under, minted before it is created. */
  readonly contextId: string;
  /**
   * The parent's latest admitted `model` request when the attempt began, as the parent made it;
   * `null` when it had none. `policyRef` is present when the parent chose its model through a
   * policy profile, and the carried admission then submits that reference, resolved afresh; the
   * `provider` and `model` beside it only record what the policy resolved to when the claim was
   * made. A claim written before the field existed has none and carries an explicit override, as
   * it always did.
   */
  readonly override: {
    readonly provider: string | null;
    readonly model: string;
    readonly policyRef?: string;
  } | null;
  /**
   * The effort the parent's steering had settled on when the attempt began (COR-1935); `null`
   * when it had none. A claim written before the field existed has none, and carries no effort.
   */
  readonly effort?: Effort | null;
  /**
   * The permission mode the parent's steering had settled on when the attempt began (COR-1936);
   * `null` when it had none. A claim written before the field existed has none.
   */
  readonly permissionMode?: PermissionMode | null;
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
  throughMessageId: string | null,
  evidence: BranchPointEvidence,
): Promise<void> {
  // Before the first message there is no run to judge.
  if (throughMessageId === null) return;
  const refuse = (reason: SessionForkRefusalReason, message: string): never => {
    throw new SessionForkRefusedError(reason, message);
  };
  const history = session.conversationHistory;
  if (
    getOwn(history.messages, throughMessageId) === undefined ||
    !history.ids.includes(throughMessageId)
  ) {
    return refuse('message-not-found', `The context holds no message "${throughMessageId}".`);
  }
  const through = parseStepRowIdentifier(throughMessageId);
  if (through === undefined || through.kind !== 'step') {
    return refuse('not-a-branch-point', "Only the reply of a run's step can be branched from.");
  }
  const { runId } = through;
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
  const approvals = await evidence.pendingApprovals(runId);
  if (approvals.length > 0) {
    return refuse('branch-with-pending-approval', 'The run still has a tool approval waiting.');
  }
  const status = record.settled?.status;
  if (status === undefined) {
    return refuse('not-a-branch-point', 'The run that made this reply has not ended.');
  }
  const steps = stepsOfRun(history, runId);
  // A run that completed ends at its final step, which must be a reply. A run that ended in error
  // or was aborted ends at the last step that replied: later steps (a tool call that was never
  // answered, a model call that failed) left no reply to end a turn at.
  const replySteps = [...steps].filter(([, rows]) => rows.hasText).map(([step]) => step);
  const finalStep = status === 'completed' ? Math.max(...steps.keys()) : Math.max(...replySteps);
  const last = steps.get(finalStep);
  if (through.step !== finalStep || last === undefined) {
    return refuse('not-a-branch-point', 'Only the last reply of a run can be branched from.');
  }
  // What the fork carries must not leave a tool call without its result. A run that completed
  // answered every call of its final step; for the others only the rows up to the reply count.
  const carried =
    status === 'completed' ? last : stepsOfRun(history, runId, throughMessageId).get(finalStep)!;
  if ([...carried.calls].some((callId) => !carried.answered.has(callId))) {
    return refuse(
      'branch-with-unresolved-tool-call',
      'The final step has a tool call with no result.',
    );
  }
  // The fork ends at the step's text row, so a step that has none leaves nothing to end at.
  if (!last.hasText) {
    return refuse('not-a-branch-point', 'The final step of the run has no reply text.');
  }
}

/** What one step of a run left in the history: whether it has text, and its calls and their results. */
interface StepRows {
  hasText: boolean;
  readonly calls: Set<string>;
  readonly answered: Set<string>;
}

/**
 * Whether a stored row is a step's reply: an assistant row holding visible text, as a string or as
 * a `text` part. A step that only thought (a `thinking` or redacted part) or only used a server
 * tool stores an assistant row too, but it has said nothing a turn could end at.
 */
function isReplyRow(row: ConversationHistory['messages'][string]): boolean {
  if (row.role !== 'assistant') return false;
  if (typeof row.content === 'string') return row.content.length > 0;
  return row.content.some((part) => part.type === 'text');
}

/**
 * The rows of every step of `runId` in `history`, by step number, read through Operative's own
 * row identifier parser. A step with no text stores its first tool call under the step's own id,
 * so a `tool-call` row at a step id is a call, and an `assistant` row there is the step's reply
 * only when it holds visible text (`isReplyRow`): a step that only thought has an assistant row and
 * no reply. Results
 * are matched by the call they answer, from the row itself. With `throughMessageId`, only the rows
 * up to and including it are read, which is what a fork ending there carries.
 */
function stepsOfRun(
  history: AgentSession['conversationHistory'],
  runId: string,
  throughMessageId?: string,
): Map<number, StepRows> {
  const steps = new Map<number, StepRows>();
  const end = throughMessageId === undefined ? -1 : history.ids.indexOf(throughMessageId);
  for (const id of end < 0 ? history.ids : history.ids.slice(0, end + 1)) {
    const parsed = parseStepRowIdentifier(id);
    const row = getOwn(history.messages, id);
    if (parsed?.runId !== runId || row === undefined) continue;
    let rows = steps.get(parsed.step);
    if (rows === undefined) {
      rows = { hasText: false, calls: new Set(), answered: new Set() };
      steps.set(parsed.step, rows);
    }
    if (parsed.kind === 'step' && isReplyRow(row)) rows.hasText = true;
    if (row.role === 'tool-call' && row.toolCall !== undefined) rows.calls.add(row.toolCall.id);
    if (row.role === 'tool-result' && row.toolResult !== undefined) {
      rows.answered.add(row.toolResult.callId);
    }
  }
  return steps;
}

/**
 * The fork command ledger over `kv`, or over memory for a Bureau with no store: a retry then
 * lasts as long as the process does.
 */
export function createForkLedger(
  kv: ConditionalTextValueStore | undefined,
  services: Pick<RuntimeServices, 'clock' | 'identifiers'>,
): CommandLedger<ForkLedgerClaim, ForkLedgerResult> {
  return createCommandLedger<ForkLedgerClaim, ForkLedgerResult>({
    kv: kv ?? textValueStore(new MemoryStorage()),
    keyPrefix: FORK_LEDGER_KEY_PREFIX,
    clock: services.clock,
    nextConflictId: () => services.identifiers.next('command-ledger-conflict'),
  });
}
