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
};

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
  };
}

/** What the line says: why the reply stopped, and what that means for the call it stopped on. */
export function stopSentence(reason: string, interrupted?: InterruptedTool): string {
  const cause = causeOf(reason);
  if (interrupted === undefined) return COPY.partway(cause);
  const outcome = mayChange(interrupted.tier)
    ? COPY.mayHaveRun(interrupted.name)
    : COPY.didNotFinish(interrupted.name);
  return `${COPY.whileRunning(interrupted.name, cause)} ${outcome}`;
}

function notesOf(row: ConversationHistory['messages'][string]): MessageNoteInfo[] {
  return resolveMessageNotes(row) ?? [];
}

function lastVisibleRowId(conversation: ConversationHistory): string | undefined {
  return conversation.ids.findLast((id) => conversation.messages[id]?.hidden === false);
}

/**
 * `conversation` with the stop note of a run that failed worded as the status line. A stored note
 * (`failed: true`, from the run's own record) is reworded in place; a failure the page saw while it
 * watched (`liveFailure`) becomes the note on the turn's last row when the run's record has not
 * said so yet. A stop the person asked for stays the plain line it was.
 */
export function withStopLine(
  conversation: ConversationHistory,
  options: {
    readonly tools: ReadonlyMap<string, ToolInfo>;
    readonly liveFailure?: string | undefined;
  },
): ConversationHistory {
  const interrupted = interruptedTool(conversation, options.tools);
  let current = conversation;
  let found = false;
  for (const id of conversation.ids) {
    const row = conversation.messages[id];
    if (row === undefined) continue;
    const notes = notesOf(row);
    if (!notes.some((note) => note.kind === 'stopped' && note.failed === true)) continue;
    found = true;
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
  if (found || options.liveFailure === undefined) return current;
  const target = lastVisibleRowId(current);
  const row = target === undefined ? undefined : current.messages[target];
  if (target === undefined || row === undefined) return current;
  const note: MessageNoteInfo = {
    kind: 'stopped',
    id: STOPPED_NOTE_ID,
    failed: true,
    reason: stopSentence(options.liveFailure, interrupted),
  };
  return {
    ...current,
    messages: {
      ...current.messages,
      [target]: {
        ...row,
        metadata: { ...row.metadata, [CINDER_NOTES_METADATA_KEY]: [...notesOf(row), note] },
      },
    },
  };
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
