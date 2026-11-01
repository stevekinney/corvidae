/**
 * The lines a run leaves under a chat's messages: a memory record it wrote, a time it parked itself
 * until, a run it handed work to, and why its last run stopped. The Bureau announces the first three
 * with `CUSTOM` events while a run streams (`packages/bureau/src/http/ag-ui-vocabulary.ts`), and a
 * stream that attaches after the event does not hold them, so each is held as an announcement and
 * stamped on a row's `cinder:notes` metadata, where Chat renders it. A reloaded thread has no
 * announcements, so what its history and its tasks still say becomes the same notes: a stored
 * memory record from the `memory_store` result in the rows, why the last run stopped from its task,
 * the wakeup a run is still parked on from its task's `wakeAt`, and each child run from the tasks
 * the thread's runs started (COR-1987). A note has one identity, so a live note and the one read
 * back from history or a task are the same line, never two.
 *
 * Reasoning is not here: it is live and private (COR-1806), and Chat's mapper already folds it into
 * the assistant row as a thinking block.
 */
import {
  CINDER_NOTES_METADATA_KEY,
  pairToolCallsWithResults,
  resolveMessageNotes,
  type ChildRunStatus,
  type ConversationHistory,
  type MessageNoteInfo,
} from '@lostgradient/chat';

import { CHAT_COPY } from '../../app/copy.ts';
import { agentMemoryPath } from '../../lib/agent-paths.ts';
import type { TaskView } from '../../lib/bureau-tasks.ts';
import { identifierPath } from '../../lib/identifier-paths.ts';

/**
 * The `name`s of the live announcements, restated because the page cannot import them from the
 * Bureau. They are a one-way door on its side; `event-notes.test.ts` holds the two to the same
 * strings.
 */
export const MEMORY_WRITTEN_EVENT_NAME = 'bureau.memory-written';
export const WAKEUP_SCHEDULED_EVENT_NAME = 'bureau.wakeup-scheduled';
export const CHILD_RUN_STARTED_EVENT_NAME = 'bureau.child-run-started';
export const CHILD_RUN_SETTLED_EVENT_NAME = 'bureau.child-run-settled';
/** What the Bureau says of a grant that came with an approval (COR-1990); not a note. */
export const TOOL_GRANT_SETTLED_EVENT_NAME = 'bureau.tool-grant-settled';
/** The name the Bureau's memory tool answers to in a thread's tool calls. */
export const MEMORY_STORE_TOOL_NAME = 'memory_store';

/** How a child run ended. */
type SettledStatus = Exclude<ChildRunStatus, 'running'>;

/**
 * One announcement of a note: the note, and the row it belongs under when the announcement names
 * one, or a child run's end, which changes the note that announced its start.
 */
export type NoteAnnouncement =
  | { readonly kind: 'note'; readonly note: MessageNoteInfo; readonly anchor?: string | undefined }
  | {
      readonly kind: 'child-settled';
      readonly childRunId: string;
      readonly status: SettledStatus;
    };

/** What an announcement is remembered by, so a repeat of it replaces the first and never doubles. */
export function noteAnnouncementKey(announcement: NoteAnnouncement): string {
  return announcement.kind === 'note'
    ? `note:${announcement.note.id}`
    : `settled:${announcement.childRunId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** A child run's page. */
function runHref(childRunId: string): string {
  return identifierPath('runs', '/runs/:run', childRunId, new URLSearchParams());
}

/**
 * Whether `value` is a moment a `Date` can hold. A finite number is not enough: `1e17` is finite
 * and makes `new Date(value).toISOString()` throw, which fails the whole transcript's render.
 */
function isRepresentableTime(value: unknown): value is number {
  return typeof value === 'number' && !Number.isNaN(new Date(value).getTime());
}

function isSettled(status: string | undefined): status is SettledStatus {
  return status === 'completed' || status === 'failed' || status === 'aborted';
}

/**
 * The announcement a `CUSTOM` event carries, or `undefined` for any other event or for a value that
 * does not say what the Bureau's vocabulary promises. `agentName` is the chat's agent, whose memory
 * page a stored record is read on.
 */
export function noteAnnouncementOf(
  event: unknown,
  agentName: string,
): NoteAnnouncement | undefined {
  if (!isRecord(event) || event['type'] !== 'CUSTOM' || !isRecord(event['value'])) return undefined;
  const value = event['value'];
  switch (event['name']) {
    case MEMORY_WRITTEN_EVENT_NAME: {
      const recordId = text(value['recordId']);
      const collection = text(value['collection']);
      const memoryClass = text(value['class']);
      if (recordId === undefined || collection === undefined || memoryClass === undefined) {
        return undefined;
      }
      return {
        kind: 'note',
        anchor: text(value['messageId']),
        note: memoryNote(recordId, collection, memoryClass, agentName),
      };
    }
    case WAKEUP_SCHEDULED_EVENT_NAME: {
      const wakeAt = value['wakeAt'];
      const runId = text(value['runId']);
      if (runId === undefined || !isRepresentableTime(wakeAt)) return undefined;
      const note = text(value['note']);
      return {
        kind: 'note',
        note: {
          kind: 'wakeup',
          id: `wakeup:${runId}:${String(wakeAt)}`,
          wakeAt,
          ...(note === undefined ? {} : { note }),
        },
      };
    }
    case CHILD_RUN_STARTED_EVENT_NAME: {
      const childRunId = text(value['childRunId']);
      const childAgent = text(value['childAgentName']);
      if (childRunId === undefined || childAgent === undefined) return undefined;
      return {
        kind: 'note',
        note: {
          kind: 'child-run',
          id: `child:${childRunId}`,
          childRunId,
          agentName: childAgent,
          status: 'running',
          href: runHref(childRunId),
        },
      };
    }
    case CHILD_RUN_SETTLED_EVENT_NAME: {
      const childRunId = text(value['childRunId']);
      const status = text(value['status']);
      if (childRunId === undefined || !isSettled(status)) {
        return undefined;
      }
      return { kind: 'child-settled', childRunId, status };
    }
    default:
      return undefined;
  }
}

function memoryNote(
  recordId: string,
  collection: string,
  memoryClass: string,
  agentName: string,
): MessageNoteInfo {
  return {
    kind: 'memory',
    id: `memory:${recordId}`,
    recordId,
    collection,
    memoryClass,
    href: agentMemoryPath(agentName),
  };
}

function notesOf(message: ConversationHistory['messages'][string]): MessageNoteInfo[] {
  return resolveMessageNotes(message) ?? [];
}

function withNotes(
  conversation: ConversationHistory,
  rowId: string,
  notes: readonly MessageNoteInfo[],
): ConversationHistory {
  const row = conversation.messages[rowId];
  if (row === undefined) return conversation;
  const metadata = { ...row.metadata };
  if (notes.length === 0) delete metadata[CINDER_NOTES_METADATA_KEY];
  else metadata[CINDER_NOTES_METADATA_KEY] = notes;
  return {
    ...conversation,
    messages: { ...conversation.messages, [rowId]: { ...row, metadata } },
  };
}

type Row = ConversationHistory['messages'][string];

/** The marker `@lostgradient/chat` stamps on a row the user sent while a run was working. */
export const FOLLOW_UP_METADATA_KEY = '_followUp';

/**
 * Where the notes of a run may go. A note belongs to its own turn, never to an earlier reply: the
 * turn is the rows from the last message the person opened one with (a follow-up sent mid-run does
 * not open one) to the end.
 */
export type Placement = {
  /**
   * Says which rows the run made. The terminal history keeps the page's own copy of a row that was
   * on screen before the run (`mergeRunHistory`), so a note on one would be thrown away with the
   * terminal's copy; a run's notes go on its own rows. Without it, every row of the last turn is a
   * candidate, which is how a note is put on a thread read back or on the page after a merge.
   */
  readonly owns?: ((id: string) => boolean) | undefined;
  /**
   * Leaves a note unplaced when the run made no row to carry it, so the caller can place it once
   * the page's own rows are in. Without it, such a note goes on the last turn's last row, which is
   * the person's message when the turn has no other.
   */
  readonly ownedOnly?: boolean | undefined;
  /**
   * Lets an announcement's anchor name any shown reply, not only one of the last turn's. A thread
   * read back puts a child run under the reply that started it, in whichever turn that was.
   */
  readonly anchorAnywhere?: boolean | undefined;
};

function shownIds(conversation: ConversationHistory): string[] {
  return conversation.ids.filter((id) => !conversation.messages[id]?.hidden);
}

/** Whether `row` is a message the person opened a turn with. */
function opensTurn(row: Row | undefined): boolean {
  return row?.role === 'user' && !row.hidden && row.metadata?.[FOLLOW_UP_METADATA_KEY] !== true;
}

/** The rows shown from the last message the person opened a turn with to the end. */
function lastTurnIds(conversation: ConversationHistory): string[] {
  const shown = shownIds(conversation);
  const start = shown.findLastIndex((id) => opensTurn(conversation.messages[id]));
  return start < 0 ? shown : shown.slice(start);
}

/**
 * The row a note with no better place goes under: the last reply among `candidates`, else the last
 * tool row (a turn that only called a tool has no reply, and its tool rows are shown as a group
 * that carries the note). A result row is shown inside its call's card, so it is never the place.
 */
function carrierAmong(
  conversation: ConversationHistory,
  candidates: readonly string[],
): string | undefined {
  return (
    candidates.findLast((id) => conversation.messages[id]?.role === 'assistant') ??
    candidates.findLast((id) => conversation.messages[id]?.role === 'tool-call')
  );
}

function placementRowId(
  conversation: ConversationHistory,
  anchor: string | undefined,
  placement: Placement,
): string | undefined {
  const owned = (id: string): boolean => placement.owns?.(id) ?? true;
  const turn = lastTurnIds(conversation);
  const preferred = anchor === undefined ? undefined : conversation.messages[anchor];
  if (
    (preferred?.role === 'assistant' || preferred?.role === 'tool-call') &&
    !preferred.hidden &&
    owned(preferred.id) &&
    (placement.owns !== undefined ||
      placement.anchorAnywhere === true ||
      turn.includes(preferred.id))
  ) {
    return preferred.id;
  }
  const candidates = placement.owns === undefined ? turn : shownIds(conversation).filter(owned);
  const carrier = carrierAmong(conversation, candidates);
  if (carrier !== undefined || placement.ownedOnly === true) return carrier;
  return turn.findLast((id) => conversation.messages[id]?.role !== 'tool-result');
}

/** The row `note` is on, when the conversation holds it. */
function rowHolding(conversation: ConversationHistory, id: string): string | undefined {
  return conversation.ids.find((rowId) => {
    const row = conversation.messages[rowId];
    return row !== undefined && notesOf(row).some((note) => note.id === id);
  });
}

/**
 * `conversation` with `note` on the row `rowId`, or on the row that already holds it: a note the
 * conversation already holds is replaced where it is, so stamping the same note twice (an
 * announcement, then the history it left) leaves one line. `undefined` when there is no such row.
 */
function stampNote(
  conversation: ConversationHistory,
  note: MessageNoteInfo,
  rowId: string | undefined,
): ConversationHistory | undefined {
  const target = rowHolding(conversation, note.id) ?? rowId;
  const row = target === undefined ? undefined : conversation.messages[target];
  if (target === undefined || row === undefined) return undefined;
  const held = notesOf(row);
  const exists = held.some((entry) => entry.id === note.id);
  return withNotes(
    conversation,
    target,
    exists ? held.map((entry) => (entry.id === note.id ? note : entry)) : [...held, note],
  );
}

function putNote(
  conversation: ConversationHistory,
  note: MessageNoteInfo,
  anchor: string | undefined,
  placement: Placement = {},
): ConversationHistory | undefined {
  return stampNote(conversation, note, placementRowId(conversation, anchor, placement));
}

function settleChild(
  conversation: ConversationHistory,
  childRunId: string,
  status: SettledStatus,
): ConversationHistory | undefined {
  const id = `child:${childRunId}`;
  const rowId = rowHolding(conversation, id);
  const row = rowId === undefined ? undefined : conversation.messages[rowId];
  if (rowId === undefined || row === undefined) return undefined;
  return withNotes(
    conversation,
    rowId,
    notesOf(row).map((note) =>
      note.kind === 'child-run' && note.id === id ? { ...note, status } : note,
    ),
  );
}

/**
 * `conversation` with each announced note on the row it belongs under: the row an announcement
 * names, else the run's last reply, else its last tool row (see {@link Placement}). A child run's
 * end changes the note of its start. `unplaced` holds the announcements that found no row: a note
 * the run made no row to carry (with `ownedOnly`), and an end whose start is not in this
 * conversation, which a later conversation may hold (the page's own row of a turn that parked).
 */
export function placeEventNotes(
  conversation: ConversationHistory,
  announced: readonly NoteAnnouncement[],
  placement: Placement = {},
): { readonly conversation: ConversationHistory; readonly unplaced: NoteAnnouncement[] } {
  let current = conversation;
  const unplaced: NoteAnnouncement[] = [];
  for (const announcement of announced) {
    const next =
      announcement.kind === 'note'
        ? putNote(current, announcement.note, announcement.anchor, placement)
        : settleChild(current, announcement.childRunId, announcement.status);
    if (next === undefined) unplaced.push(announcement);
    else current = next;
  }
  return { conversation: current, unplaced };
}

/** {@link placeEventNotes} without the announcements it could not place. */
export function withEventNotes(
  conversation: ConversationHistory,
  announced: readonly NoteAnnouncement[],
  placement: Placement = {},
): ConversationHistory {
  return placeEventNotes(conversation, announced, placement).conversation;
}

function parsedContent(content: unknown): Record<string, unknown> {
  if (typeof content !== 'string') return isRecord(content) ? content : {};
  try {
    const parsed: unknown = JSON.parse(content);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * `conversation` with a note under the reply that wrote each memory record its rows say was stored
 * (a successful `memory_store` result naming the record, its collection and its class), which is
 * what a reloaded thread still holds of the live announcement.
 */
export function withStoredMemoryNotes(
  conversation: ConversationHistory,
  agentName: string,
): ConversationHistory {
  const rows = conversation.ids.flatMap((id) => conversation.messages[id] ?? []);
  const resultOf = new Map(
    pairToolCallsWithResults(rows).map((pair) => [pair.call.id, pair.result] as const),
  );
  const carriers = callCarriers(rows);
  let current = conversation;
  for (const row of rows) {
    const call = row.toolCall;
    if (call?.name !== MEMORY_STORE_TOOL_NAME) continue;
    const result = resultOf.get(call.id);
    if (result?.outcome !== 'success') continue;
    const content = parsedContent(result.content);
    const recordId = text(content['id']);
    const collection = text(content['collection']);
    const memoryClass = text(content['memoryClass']);
    if (
      content['stored'] !== true ||
      recordId === undefined ||
      collection === undefined ||
      memoryClass === undefined
    ) {
      continue;
    }
    current =
      stampNote(
        current,
        memoryNote(recordId, collection, memoryClass, agentName),
        carriers.get(call.id),
      ) ?? current;
  }
  return current;
}

/**
 * The row each tool call is shown under: the reply before the call in its own turn, else the
 * call's own row, which a group of tool rows shows with a note. A reply of an earlier turn is not
 * where this turn's call was made, and a hidden call row carries nothing.
 */
function callCarriers(rows: readonly Row[]): Map<string, string> {
  const carriers = new Map<string, string>();
  let reply: string | undefined;
  for (const row of rows) {
    if (opensTurn(row)) reply = undefined;
    if (row.role === 'assistant' && !row.hidden) reply = row.id;
    const call = row.toolCall;
    if (call === undefined) continue;
    const carrier = reply ?? (row.hidden ? undefined : row.id);
    if (carrier !== undefined) carriers.set(call.id, carrier);
  }
  return carriers;
}

/**
 * Why a task stopped, in words, or `undefined` for one that did not stop: a task still going, or
 * one that ended its normal way. The task's own message is the reason when it left one, since that
 * is what says which limit was reached; otherwise the finish reason has words of its own.
 */
export function stopReasonOf(
  task: Pick<TaskView, 'status' | 'finishReason' | 'statusMessage'>,
): string | undefined {
  const reasons: Record<string, string | undefined> = CHAT_COPY.stopReasons;
  const stopped =
    task.status === 'failed' ||
    task.status === 'canceled' ||
    (task.status === 'completed' &&
      task.finishReason !== null &&
      Object.hasOwn(reasons, task.finishReason));
  if (!stopped) return undefined;
  const own = task.statusMessage?.trim();
  if (own !== undefined && own !== '') return own;
  const key =
    task.finishReason !== null && Object.hasOwn(reasons, task.finishReason)
      ? task.finishReason
      : task.status;
  return reasons[key];
}

/**
 * `conversation` with why its last run stopped under its last turn's last reply, or under the
 * person's message when the turn has none, when that run did stop.
 */
export function withStopReason(
  conversation: ConversationHistory,
  task: Pick<TaskView, 'status' | 'finishReason' | 'statusMessage'> | undefined,
): ConversationHistory {
  const reason = task === undefined ? undefined : stopReasonOf(task);
  if (reason === undefined) return conversation;
  return (
    putNote(conversation, { kind: 'stopped', id: 'stopped', reason }, undefined) ?? conversation
  );
}

/**
 * The kinds of note a thread read again cannot be trusted to give back whole. The tasks say a
 * wakeup that is still pending and each child run (`taskNoteAnnouncements`), but a wakeup that has
 * since fired, or a child run a task record does not hold (one a tool or a peer started), is
 * something only the stream said.
 */
const LIVE_ONLY: ReadonlySet<MessageNoteInfo['kind']> = new Set(['wakeup', 'child-run']);

/**
 * `next` with the stream-told notes `previous` holds, on the rows of `next` that have the same id.
 * A thread read again after a run keeps what the page was told while it watched, since the
 * thread's rows do not say it; a note the tasks say again is the same line and is stamped over it.
 */
export function carryLiveNotes(
  previous: ConversationHistory,
  next: ConversationHistory,
): ConversationHistory {
  let current = next;
  for (const id of previous.ids) {
    const before = previous.messages[id];
    if (before === undefined || current.messages[id] === undefined) continue;
    const carried = notesOf(before).filter((note) => LIVE_ONLY.has(note.kind));
    // On the row that held it: a wakeup held on a tool row stays there.
    for (const note of carried) current = stampNote(current, note, id) ?? current;
  }
  return current;
}

/** What a child run's task state is called on its card: a task not yet ended is still running. */
function childStatusOf(status: TaskView['status']): ChildRunStatus {
  switch (status) {
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'canceled':
      return 'aborted';
    case 'submitted':
    case 'working':
    case 'input-required':
      return 'running';
  }
}

/**
 * The announcements a reloaded thread's tasks still make (COR-1987), as the same notes the stream
 * announced, with the same identities, so a live note and the one a task gives back are one line.
 *
 * - `runs`: the runs whose pending wakeup is shown. A task holds `wakeAt` only while the run is
 *   parked on it, so a wakeup that fired, or one the run left for a person's answer, is not
 *   shown; one whose time has passed by `now` is not either.
 * - `children`: the child runs the thread's runs started, each as a card with its link and where it
 *   stands. The card goes under the reply before the tool call that started it when the task
 *   names the call and the thread holds it, else on the last reply. A child with no agent to name
 *   is left out, since the card is named for it, and so is a task that is not a child run. A child a tool or a peer started has no task
 *   (it is never listed here), so it is not shown after a reload.
 */
export function taskNoteAnnouncements(
  runs: readonly Pick<TaskView, 'id' | 'wakeAt'>[],
  children: readonly TaskView[],
  conversation: ConversationHistory,
  now: number = Date.now(),
): NoteAnnouncement[] {
  const announcements: NoteAnnouncement[] = [];
  for (const run of runs) {
    const wakeAt = run.wakeAt === undefined || run.wakeAt === null ? NaN : Date.parse(run.wakeAt);
    if (!isRepresentableTime(wakeAt) || wakeAt <= now) continue;
    announcements.push({
      kind: 'note',
      note: { kind: 'wakeup', id: `wakeup:${run.id}:${String(wakeAt)}`, wakeAt },
    });
  }
  const carriers = callCarriers(conversation.ids.flatMap((id) => conversation.messages[id] ?? []));
  for (const child of children) {
    if (child.agentName === null || child.origin?.kind !== 'agent') continue;
    const callId = child.origin?.['toolCallId'];
    announcements.push({
      kind: 'note',
      anchor: typeof callId === 'string' ? carriers.get(callId) : undefined,
      note: {
        kind: 'child-run',
        id: `child:${child.id}`,
        childRunId: child.id,
        agentName: child.agentName,
        status: childStatusOf(child.status),
        href: runHref(child.id),
      },
    });
  }
  return announcements;
}
