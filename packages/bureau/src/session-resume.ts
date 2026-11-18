/**
 * Resuming a context's last stopped turn (COR-2437): which turn may go on, why one is refused, and
 * the continuation row that starts the run that goes on.
 *
 * A run the person stopped, or one that failed on a cause worth trying again (finish reason
 * `error`: the provider dropped the connection, the model call failed), has ended its durable
 * workflow, which the engine does not resume. The turn goes on as a continuation run instead: a new
 * run of the same chat, started with no message from the person. It is seeded from the stored
 * conversation, the partial reply included, and the one row it adds before its own is a hidden
 * continuation row (`<stoppedRunId>:continuation`) that names the stopped run and the command. A
 * hidden row is never sent to the model, so the model is asked over the history as it stands,
 * ending in the partial reply, and continues it. Operative's provider adapters do not prefill a
 * trailing assistant message, so what the continuation writes is a new assistant turn after the
 * partial reply, linked to the stopped run by that row; nothing of the stopped run is rewritten.
 *
 * The start is one atomic session write: the run creation's own save, which appends the row and
 * names the new run as the chat's last, judges the history again inside its update
 * ({@link judgeResumableTurn}). A message, a discard or another continuation that lands first wins,
 * and this start is refused. A repeated `commandId` finds its row and answers the run it started,
 * after a restart too, and never starts a second.
 *
 * What is refused, and why:
 *
 * - A run whose process stopped (`owner-lost`) is still `running` in the engine, and the Bureau
 *   that next boots over the store takes it up: it goes on from its checkpoint, or is ended when
 *   recovery cannot take it (`recovered-run-classification.ts`): `turn-recovering`.
 * - A reply the model cut at its token limit ends its step like any reply with no tool call, so the
 *   run finishes normally: `turn-finished`.
 * - A run that failed on a cause that would only fail again (a guardrail, its step or cost limit, a
 *   refused elicitation) is `run-not-resumable`.
 * - A turn that stopped inside a tool call would run the call again unasked: `turn-interrupted-call`
 *   (Retry runs the turn again through its approval).
 * - A run still going is `turn-running`, and one waiting on an approval or a question is
 *   `turn-awaiting-person`: it goes on once the person answers.
 *
 * @module session-resume
 */

import type { AgentSession } from '@lostgradient/operative';
import { parseStepRowIdentifier } from '@lostgradient/operative';
import { getOwn, type Message } from 'conversationalist';

/** Why a resume was refused. Each is stable: the management plane carries it as `data.reason`. */
export type SessionResumeRefusalReason =
  /** The run is not one of this context's runs. */
  | 'run-not-found'
  /** A later run of the context exists, the turn already went on, or a row the run did not write follows it. */
  | 'not-latest-turn'
  /** The run is still going. */
  | 'turn-running'
  /** The run waits on an approval or a question, and goes on once the person answers it. */
  | 'turn-awaiting-person'
  /**
   * The run's process stopped before it recorded its end: the Bureau that next boots goes on with
   * it from its checkpoint, or ends it when recovery cannot take it.
   */
  | 'turn-recovering'
  /** The run finished normally, including a reply the model cut at its token limit. */
  | 'turn-finished'
  /** The run failed on a cause that going on would only meet again. */
  | 'run-not-resumable'
  /** The turn stopped inside a tool call, which going on would run again unasked. */
  | 'turn-interrupted-call'
  /** A follow-up the person sent was delivered into the turn. */
  | 'follow-up-delivered'
  /** A follow-up the person sent is still queued for the context. */
  | 'follow-ups-queued'
  /** The run wrote nothing after the person's message, or its turn was discarded. */
  | 'nothing-to-resume'
  /** A goal's attempt or a schedule's fire owns the run, and accounts for how it ended. */
  | 'turn-owned-elsewhere'
  /** The command identifier was used to resume another run's turn. */
  | 'command-conflict';

/** A resume that was refused. Nothing was started or changed. */
export class SessionResumeRefusedError extends Error {
  /** Why the resume was refused. */
  readonly reason: SessionResumeRefusalReason;

  constructor(reason: SessionResumeRefusalReason, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SessionResumeRefusedError';
    this.reason = reason;
  }
}

/** What {@link BureauContexts.resumeTurn} takes. */
export interface ResumeTurnRequest {
  /** The caller's owner of record: the run that goes on is theirs. Authorization is the caller's. */
  readonly owner: string;
  /** The caller's own identifier for the command; a retry of it answers the run it started. */
  readonly commandId: string;
  /** The context's last run, which the person stopped or which failed: the turn that goes on. */
  readonly runId: string;
}

/** What {@link BureauContexts.resumeTurn} answers. */
export type ResumeTurnResult = {
  /** The context whose turn went on. */
  readonly contextId: string;
  /** The continuation run, which goes on from the stopped run's partial reply. */
  readonly runId: string;
  /** The stopped run whose turn went on. */
  readonly resumedRunId: string;
};

/** The metadata key of a continuation row that names the stopped run it continues. */
export const CONTINUATION_OF_METADATA_KEY = 'bureau:continuationOf';

/** The metadata key of a continuation row that names the command that started it. */
export const CONTINUATION_COMMAND_METADATA_KEY = 'bureau:continuationCommand';

/** The metadata key of a continuation row that names the owner whose command started it. */
export const CONTINUATION_OWNER_METADATA_KEY = 'bureau:continuationOwner';

/** The id of the continuation row of the stopped run `runId`: one per stopped run. */
export function continuationRowId(runId: string): string {
  return `${runId}:continuation`;
}

/**
 * The hidden row a continuation run starts from: the person did not write it, the model is never
 * sent it, and it names the stopped run and the command, so a retry finds the run it started.
 */
export function continuationRow(
  runId: string,
  commandId: string,
  owner: string,
  createdAt: string,
): Message {
  return {
    id: continuationRowId(runId),
    role: 'user',
    content: 'Continue the answer from where it stopped.',
    hidden: true,
    // The append re-stamps both, as it does every row a run is started with.
    position: 0,
    createdAt,
    metadata: {
      [CONTINUATION_OF_METADATA_KEY]: runId,
      [CONTINUATION_COMMAND_METADATA_KEY]: commandId,
      [CONTINUATION_OWNER_METADATA_KEY]: owner,
    },
  };
}

/** The metadata key a follow-up delivered into a run carries (operative's session input turn). */
const SESSION_INPUT_COMMAND_ID_METADATA_KEY = 'sessionInputCommandId';

/** Whether `id` is a row run `runId` wrote: a step's text, call or result, or an answer to its question. */
function isRowOfRun(id: string, runId: string): boolean {
  return parseStepRowIdentifier(id)?.runId === runId || id.startsWith(`${runId}:signal:`);
}

/** The judgment of a turn: whether it may go on, and why not. */
export type ResumeJudgment =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: SessionResumeRefusalReason; readonly message: string };

/**
 * Judges whether the turn of `runId` may go on from `session` as it stands. Pure, so the save that
 * starts the continuation judges again what it writes over. Which run is the context's last, and
 * how it ended, are the task registry's to say; this reads what the chat holds: the marker of its
 * last run, which the run's terminal save writes with its rows, and the rows after it.
 */
export function judgeResumableTurn(session: AgentSession, runId: string): ResumeJudgment {
  const refuse = (reason: SessionResumeRefusalReason, message: string): ResumeJudgment => ({
    ok: false,
    reason,
    message,
  });
  const history = session.conversationHistory;
  if (getOwn(history.messages, continuationRowId(runId)) !== undefined) {
    return refuse('not-latest-turn', 'The turn already went on.');
  }
  if (session.metadata['lastRunId'] !== runId) {
    return refuse('turn-running', 'The run has not recorded its end in the chat yet.');
  }
  const recorded = session.metadata['lastRunStatus'];
  if (recorded === 'completed') {
    return refuse(
      'turn-finished',
      'The turn finished, and a finished turn has nothing to go on with.',
    );
  }
  if (recorded !== 'aborted' && recorded !== 'error') {
    return refuse('turn-running', 'The turn is still going.');
  }
  const start = history.ids.findIndex((id) => isRowOfRun(id, runId));
  if (start === -1) {
    return refuse('nothing-to-resume', 'The run wrote nothing after the person’s message.');
  }
  const calls = new Set<string>();
  const answered = new Set<string>();
  for (const id of history.ids.slice(start)) {
    const row = getOwn(history.messages, id);
    if (!isRowOfRun(id, runId)) {
      return row?.metadata?.[SESSION_INPUT_COMMAND_ID_METADATA_KEY] === undefined
        ? refuse('not-latest-turn', 'A row the run did not write follows its turn.')
        : refuse('follow-up-delivered', 'A follow-up the person sent was delivered into the turn.');
    }
    if (row?.toolCall !== undefined) calls.add(row.toolCall.id);
    // An approval's `action_required` row is a placeholder, not the tool's result: the call has
    // not finished, and going on would pass it or run it without the approval path.
    if (row?.toolResult !== undefined && row.toolResult.outcome !== 'action_required') {
      answered.add(row.toolResult.callId);
    }
  }
  if ([...calls].some((call) => !answered.has(call))) {
    return refuse(
      'turn-interrupted-call',
      'The turn stopped inside a tool call, which going on would run again unasked.',
    );
  }
  return { ok: true };
}

/**
 * The continuation run a command already started for the stopped run `runId`, read from its row:
 * the run whose rows follow it, or the chat's last run while it has written none. `undefined` when
 * no continuation of `runId` was started; `other-command` when one was, under another command or
 * owner.
 */
export function startedContinuation(
  session: AgentSession,
  runId: string,
  commandId: string,
  owner: string,
):
  | { readonly kind: 'started'; readonly runId: string }
  | { readonly kind: 'other-command' }
  | undefined {
  const history = session.conversationHistory;
  const rowId = continuationRowId(runId);
  const row = getOwn(history.messages, rowId);
  if (row === undefined) return undefined;
  const metadata = row.metadata ?? {};
  if (
    metadata[CONTINUATION_COMMAND_METADATA_KEY] !== commandId ||
    metadata[CONTINUATION_OWNER_METADATA_KEY] !== owner
  ) {
    return { kind: 'other-command' };
  }
  for (const id of history.ids.slice(history.ids.indexOf(rowId) + 1)) {
    const step = parseStepRowIdentifier(id);
    if (step !== undefined) return { kind: 'started', runId: step.runId };
  }
  const last = session.metadata['lastRunId'];
  return typeof last === 'string' && last !== runId ? { kind: 'started', runId: last } : undefined;
}

/** Whether `commandId` of `owner` started the continuation of another run than `runId`. */
export function commandContinuesAnotherRun(
  session: AgentSession,
  runId: string,
  commandId: string,
  owner: string,
): boolean {
  const history = session.conversationHistory;
  return history.ids.some((id) => {
    const metadata = getOwn(history.messages, id)?.metadata;
    return (
      metadata?.[CONTINUATION_COMMAND_METADATA_KEY] === commandId &&
      metadata[CONTINUATION_OWNER_METADATA_KEY] === owner &&
      metadata[CONTINUATION_OF_METADATA_KEY] !== runId
    );
  });
}
