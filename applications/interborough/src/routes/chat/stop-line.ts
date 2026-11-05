/**
 * The status line under a reply that stopped. It is the product speaking, not the agent, so it is a
 * note on the last row of the turn (`kind: 'stopped'`), drawn as a danger line with a Retry beside
 * it. What it says is keyed to the tool the run was in the middle of: for a tool that only reads, the
 * call did not finish and nothing was changed; for one that changes things, or that nothing
 * classifies, the call may have run, and "nothing was changed" is never said.
 *
 * Retry keeps the failed attempt on record (B06, row 20b), so a transcript can hold the lines of
 * several turns. Each is worded from its own turn, and only the last turn's offers Retry and says
 * the chat failed.
 */
import {
  CINDER_NOTES_METADATA_KEY,
  pairToolCallsWithResults,
  resolveMessageNotes,
  type ConversationHistory,
  type MessageNoteInfo,
} from '@lostgradient/chat';

import { CHAT_COPY } from '../../app/copy.ts';
import { opensTurn } from './event-notes.ts';
import {
  lastTurnStart,
  mayChange,
  toolDisplayName,
  turnStart,
  type ToolInfo,
} from './tool-activity.ts';

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

/** The index just past the last row of the turn `index` is in. */
function turnEnd(conversation: ConversationHistory, index: number): number {
  for (let at = index + 1; at < conversation.ids.length; at += 1) {
    if (opensTurn(conversation.messages[conversation.ids[at] ?? ''])) return at;
  }
  return conversation.ids.length;
}

/**
 * The tool whose call is the last of the turn row `within` is in (the last turn when it is not
 * given) and has no answer, which a run that is no longer going was interrupted on; `undefined`
 * when every call of that turn has its answer. A call of another turn is never this turn's.
 */
export function interruptedTool(
  conversation: ConversationHistory,
  tools: ReadonlyMap<string, ToolInfo>,
  within: number = conversation.ids.length - 1,
): InterruptedTool | undefined {
  const rows = conversation.ids
    .slice(turnStart(conversation, within), turnEnd(conversation, within))
    .flatMap((id) => conversation.messages[id] ?? []);
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
 * place from what its own turn was in the middle of. A stop the person asked for stays the plain
 * line it was.
 */
export function withStopLine(
  conversation: ConversationHistory,
  options: {
    readonly tools: ReadonlyMap<string, ToolInfo>;
  },
): ConversationHistory {
  let current = conversation;
  for (const [index, id] of conversation.ids.entries()) {
    const row = conversation.messages[id];
    if (row === undefined) continue;
    const notes = notesOf(row);
    if (!notes.some((note) => note.kind === 'stopped' && note.failed === true)) continue;
    const interrupted = interruptedTool(conversation, options.tools, index);
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

/**
 * The identity of the note on the last turn that says its run failed, which is the line Retry is
 * offered beside, or `undefined` when the last turn's run did not fail. A failed attempt of an
 * earlier turn keeps its line, and offers nothing: Retry runs the last turn again.
 */
export function failedStopNoteId(conversation: ConversationHistory): string | undefined {
  for (const id of conversation.ids.slice(lastTurnStart(conversation))) {
    const row = conversation.messages[id];
    const note =
      row === undefined
        ? undefined
        : notesOf(row).find((entry) => entry.kind === 'stopped' && entry.failed === true);
    if (note !== undefined) return note.id;
  }
  return undefined;
}
