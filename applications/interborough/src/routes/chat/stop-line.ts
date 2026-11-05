/**
 * The status line under a reply that stopped. It is the product speaking, not the agent, so it is a
 * note on the last row of the turn (`kind: 'stopped'`), drawn as a danger line with a Retry beside
 * it. What it says is keyed to the tool the run was in the middle of: for a tool that only reads, the
 * call did not finish and nothing was changed; for one that changes things, or that nothing
 * classifies, the call may have run, and "nothing was changed" is never said.
 */
import {
  CINDER_NOTES_METADATA_KEY,
  pairToolCallsWithResults,
  resolveMessageNotes,
  type ConversationHistory,
  type MessageNoteInfo,
} from '@lostgradient/chat';

import { CHAT_COPY } from '../../app/copy.ts';
import { mayChange, toolDisplayName, type ToolInfo } from './tool-activity.ts';

/** The identity of the note that says why a run stopped. */
export const STOPPED_NOTE_ID = 'stopped';

const COPY = CHAT_COPY.stopLine;

/** Why a run stopped as the end of a sentence: lower case, with no full stop ("the run failed"). */
export function causeOf(reason: string): string {
  const trimmed = reason.trim().replace(/[.\s]+$/u, '');
  const second = trimmed.charAt(1);
  // An acronym or an identifier keeps its capital: "HTTP 429" is not "hTTP 429".
  const keepsCapital =
    second !== '' && second === second.toUpperCase() && second !== second.toLowerCase();
  return keepsCapital ? trimmed : `${trimmed.charAt(0).toLowerCase()}${trimmed.slice(1)}`;
}

/** The tool a run was in the middle of when it stopped: its name for a person, and what it may do. */
export type InterruptedTool = {
  readonly name: string;
  readonly tier: ToolInfo['tier'] | undefined;
  /**
   * What the call acted on, as a noun ("order"), read from the argument that names it (`orderId`
   * is "order"); `undefined` when no argument does.
   */
  readonly subject: string | undefined;
};

/**
 * The noun the arguments of a call name what it acts on with: `orderId`, `orderID`, `order_id` and
 * `order-id` are "order" (a word that merely ends in "id", such as `valid`, is not an identifier).
 * The first argument whose name ends in an identifier word, with something before it, says it; a call with no such argument has no subject.
 */
export function subjectOf(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return undefined;
  for (const key of Object.keys(args)) {
    const prefix = /^(.+?)(?:[_-](?:id|ID)|Id|ID)$/u.exec(key)?.[1];
    if (prefix === undefined) continue;
    const words = prefix
      .replaceAll(/([a-z0-9])([A-Z])/gu, '$1 $2')
      .replaceAll(/[_-]+/gu, ' ')
      .trim()
      .toLowerCase();
    if (words !== '') return words;
  }
  return undefined;
}

/**
 * The tool whose call is the last in the transcript and has no answer, which a run that is no
 * longer going was interrupted on; `undefined` when every call has its answer.
 */
export function interruptedTool(
  conversation: ConversationHistory,
  tools: ReadonlyMap<string, ToolInfo>,
): InterruptedTool | undefined {
  const rows = conversation.ids.flatMap((id) => conversation.messages[id] ?? []);
  const unanswered = pairToolCallsWithResults(rows).findLast((pair) => pair.result === undefined);
  if (unanswered === undefined) return undefined;
  const info = tools.get(unanswered.call.name);
  return {
    name: toolDisplayName(unanswered.call.name, info?.title),
    tier: info?.tier,
    subject: subjectOf(unanswered.call.arguments),
  };
}

/** What the line says: why the reply stopped, and what that means for the call it stopped on. */
export function stopSentence(reason: string, interrupted?: InterruptedTool): string {
  const cause = causeOf(reason);
  if (interrupted === undefined) return COPY.partway(cause);
  const outcome = mayChange(interrupted.tier)
    ? COPY.mayHaveRun(interrupted.name, interrupted.subject)
    : COPY.didNotFinish(interrupted.name);
  return `${COPY.whileRunning(interrupted.name, cause)} ${outcome}`;
}

function notesOf(row: ConversationHistory['messages'][string]): MessageNoteInfo[] {
  return resolveMessageNotes(row) ?? [];
}

/**
 * `conversation` with the stop note of a run that failed worded as the status line. A stored note
 * (`failed: true`, from the run's own record, read when the page opens on the chat) is reworded in
 * place from what the run was in the middle of. A stop the person asked for stays the plain line it
 * was.
 */
export function withStopLine(
  conversation: ConversationHistory,
  options: {
    readonly tools: ReadonlyMap<string, ToolInfo>;
  },
): ConversationHistory {
  const interrupted = interruptedTool(conversation, options.tools);
  let current = conversation;
  for (const id of conversation.ids) {
    const row = conversation.messages[id];
    if (row === undefined) continue;
    const notes = notesOf(row);
    if (!notes.some((note) => note.kind === 'stopped' && note.failed === true)) continue;
    const reworded = notes.map((note) =>
      note.kind === 'stopped' && note.failed === true
        ? { ...note, reason: stopSentence(note.reason, interrupted) }
        : note,
    );
    current = {
      ...current,
      messages: {
        ...current.messages,
        [id]: { ...row, metadata: { ...row.metadata, [CINDER_NOTES_METADATA_KEY]: reworded } },
      },
    };
  }
  return current;
}

/** Whether a note on the conversation says its run failed. */
export function hasFailedStop(conversation: ConversationHistory): boolean {
  return conversation.ids.some((id) => {
    const row = conversation.messages[id];
    return (
      row !== undefined &&
      notesOf(row).some((note) => note.kind === 'stopped' && note.failed === true)
    );
  });
}
