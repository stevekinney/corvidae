/**
 * The wiring between `@lostgradient/chat`'s session controller and the Bureau's AG-UI mount
 * (`packages/bureau/src/http/ag-ui-mount.ts`): the transport that sends each turn, the hook that
 * answers an approval, and the attach to a run that is already going.
 *
 * A turn is one of three requests, and the controller does not say which:
 *
 * - **start** (`POST <mount>/agents/<agent>/run`): the whole thread, whose last new message is the
 *   user's. The mount skips the rows it already holds.
 * - **resume** (the same route, with `resume`): what follows an approval the user decided. The
 *   decision is recorded by {@link ChatRunWiring.resolveToolApproval} and sent by the next turn,
 *   which the controller starts once it has the decision. It carries the user turn that opened the
 *   run and never a follow-up row: a follow-up sent while the run was waiting must not stand in for
 *   the turn the run answers.
 * - **attach** (`GET <mount>/threads/<thread>/run`): a run the page did not start, such as one
 *   still going when it reloaded. {@link ChatRunWiring.attach} opens the stream and the next turn
 *   reads it.
 *
 * The AG-UI transport drops the interrupts that end a run, so the wiring reads them from the raw
 * events. A run that stops on a tool approval is shown to the chat as a result row parked on
 * `action_required`, which is what puts the approval in the conversation. A run that stops on a
 * question for the person (a `human-wait` interrupt) is told to the page
 * ({@link ChatRunWiringOptions.onHumanRequests}), and the person's next message is sent as the
 * answer: a resume, not a new run, because the run is parked and a new run would be refused as busy.
 *
 * A resume carries an answer to every interrupt the run ended on, and the mount refuses one that
 * leaves any unanswered. So the wiring holds what the person has answered so far (a decision on an
 * approval, the text typed for a question, in the order the questions came) and sends one resume
 * once every interrupt has an entry. A turn the controller starts before that point is held, and
 * sends nothing.
 *
 * A request is committed only once the mount has answered it. The first event of the response is
 * the answer, so a request that failed before one keeps what it carried (the decisions on
 * approvals, the run identifier) for the retry, which the mount recognises by that identifier. A
 * refusal of a resume is not an answer to it either: the one-event `RUN_ERROR` with no run's
 * identifier keeps the entries, and the page reads again what is still pending
 * ({@link ChatRunWiring.attach}), which drops the entries whose interrupt is gone.
 *
 * A Stop before the response's first event does not abort the request: the run exists from the
 * moment the mount admits the request, and only its first event names it. The wiring reads to that
 * event, then cancels the run it names, or cancels nothing for a refusal.
 */
import {
  EventType,
  type Interrupt,
  type MessagesSnapshotEvent,
  type ResumeEntry,
  type RunAgentInput,
} from '@ag-ui/core';
import { EventSchemas } from '@ag-ui/core/schemas';
import {
  createConversationHistory,
  findToolResultMessage,
  mapAGUIEventsToChatStream,
  removeMessage,
  replaceToolResult,
  type ChatAttachment,
  type ChatSessionRequest,
  type ChatSessionTransport,
  type ChatStreamEvent,
  type ConversationHistory,
  type ToolResult,
} from '@lostgradient/chat';
import type { ApprovalResolution } from '@lostgradient/cinder';
import { HttpClientError } from '@lostgradient/weft';
import { agUiConversationAdapter, mergeAGUIMessages } from 'conversationalist';

import {
  ASSET_FILE_PROVIDER,
  ASSET_PART_EVENT_NAME,
  ASSET_PARTS_METADATA_KEY,
  type AssetPartReference,
} from '../../lib/bureau-assets.ts';
import { BUREAU_PATH, getThreadMessages, type Fetcher } from '../../lib/bureau-client.ts';
import { getLastRun } from '../../lib/bureau-tasks.ts';
import { readEvents } from './ag-ui-events.ts';
import {
  noteAnnouncementKey,
  noteAnnouncementOf,
  withEventNotes,
  withStopReason,
  withStoredMemoryNotes,
  type NoteAnnouncement,
} from './event-notes.ts';
import { ResumableMapper } from './resumable-mapper.ts';

/** The AG-UI mount's path, under the Bureau's. */
export const AG_UI_PATH = `${BUREAU_PATH}/ag-ui`;

/** The marker `@lostgradient/chat` stamps on a row the user sent while a run was working. */
const FOLLOW_UP_KEY = '_followUp';

/** Whether `event` is a valid `MESSAGES_SNAPSHOT`. */
function isMessagesSnapshot(event: unknown): event is MessagesSnapshotEvent {
  const parsed = EventSchemas.safeParse(event);
  return parsed.success && parsed.data.type === EventType.MESSAGES_SNAPSHOT;
}

/** A request the mount turned away at the door, as its `RUN_ERROR` says it. */
export type Refusal = {
  /** The mount's code (`THREAD_BUSY`, `RUN_FAILED`, ...), when it sent one. */
  readonly code: string | undefined;
  readonly message: string;
  /** Whether the request that was refused was a resume, which carried what the person had answered. */
  readonly resume: boolean;
  /**
   * Whether the mount only found the thread busy: the thread's lease is held, or an earlier attempt
   * at this very resume is still being applied. Nothing is wrong with the request, and the next send
   * repeats it. Every other refusal is a failure to be told.
   */
  readonly busy: boolean;
};

/**
 * The refusals of a resume that say an attempt is still going (`ag-ui-resume.ts`: "An earlier
 * attempt at this resume is still being applied; try again shortly", "Another attempt at this
 * resume is in progress; try again", "This resume lost its lease to another attempt before it
 * finished; try again"). The mount sends them as `RUN_FAILED`, as it does the refusals of an
 * attempt that failed ("The answers could not be applied; answer the interrupts again", "...send a
 * new message to continue the thread"), which are told to the person. They differ by their words.
 */
const ATTEMPT_STILL_GOING = /\b(?:attempt|resume)\b[^.]*\btry again\b/i;

function isBusyRefusal(code: string | undefined, message: string): boolean {
  return code === 'THREAD_BUSY' || (code === 'RUN_FAILED' && ATTEMPT_STILL_GOING.test(message));
}

/** A question a run is waiting on a person to answer. */
export type HumanRequest = {
  /** The interrupt the answer resolves. */
  readonly interruptId: string;
  /** What the agent asked, or nothing when it said no more than that it is waiting. */
  readonly message: string;
  /**
   * The JSON Schema the answer must satisfy, which says how the question is drawn (`ChatQuestion`).
   * Absent when the interrupt carries none: the generic resume schema takes any answer, so the
   * question is free text.
   */
  readonly schema?: Readonly<Record<string, unknown>>;
};

export type ChatRunWiringOptions = {
  readonly onFrame?: () => void;
  readonly onTerminal?: () => void;
  readonly onSnapshot?: (history: ConversationHistory) => void;
  /**
   * The conversation on screen. A run that follows an approval shows its tool call again, and a
   * run attached to shows the thread it restores, for a client that did not watch them happen; the
   * calls the conversation holds when the stream's first event arrives are not added a second time.
   */
  readonly conversation: () => ConversationHistory;
  /** The agent a start request names. Read per request: it is the session's agent. */
  readonly agentName: () => string;
  /** Replaces `fetch`, for tests. */
  readonly fetch?: Fetcher;
  /**
   * Told when a run this page started has begun (its `RUN_STARTED` arrived). A run attached to
   * began elsewhere and does not call it.
   */
  readonly onRunStarted?: () => void;
  /**
   * Told what the run is waiting on a person to answer: the questions a run ended on that have no
   * answer held yet, and none when a run begins. The person's next message answers the first of
   * them.
   */
  readonly onHumanRequests?: (requests: readonly HumanRequest[]) => void;
};

export type ChatRunWiring = {
  readonly transport: ChatSessionTransport;
  /**
   * Records the user's decision on a tool approval, for the turn the controller starts next, and
   * answers with the result row that takes the approval's place in the transcript.
   */
  resolveToolApproval(toolCallId: string, resolution: ApprovalResolution): Promise<ToolResult>;
  /**
   * Opens the run `threadId` has going, or waiting on an approval, for the next turn to read.
   * Resolves the thread as the stream's snapshot gave it, or `undefined` when the thread has
   * nothing to attach to, and then opens nothing.
   */
  attach(threadId: string, signal?: AbortSignal): Promise<ConversationHistory | undefined>;
  /**
   * The thread's conversation as the Bureau holds it, run or no run, or `undefined` when the
   * Bureau has no such thread. It is how a finished session's transcript comes back. The caller
   * replaces the transcript with it, so the live cursor, which continues the transcript it replaces,
   * is forgotten: the next attach opens on the thread's snapshot.
   */
  history(threadId: string, signal?: AbortSignal): Promise<ConversationHistory | undefined>;
  /** Drops an attach that was opened and never read. */
  discardAttach(): Promise<void>;
  /**
   * Leaves the run it is reading going when the page's own signal ends, as it does when the person
   * leaves the chat. Without it the end of the signal is a Stop, which cancels the Bureau's run.
   */
  detach(): void;
  /**
   * Holds the person's answer, the text of the row `rowId`, to the first question still waiting,
   * for the resume that answers every interrupt. Answers the question as `false` when none waits.
   */
  holdAnswer(text: string, rowId: string): boolean;
  /**
   * Holds `value`, an answer to the question of `interruptId` that was given in the control the
   * question's schema drew, for the same resume. No row of the conversation holds it. Answers
   * `false` when that question is not waiting on an answer.
   */
  holdValue(interruptId: string, value: unknown): boolean;
  /**
   * Lets go of the value `holdValue` held for `interruptId` when the resume that carried it was not
   * applied, so the question is offered again. `false` when no such value is held (the resume was
   * applied, or the thread no longer waits on the question). A typed answer is not released: its
   * row holds it.
   */
  releaseValue(interruptId: string): boolean;
  /**
   * What the last turn was refused with, once: the one-event `RUN_ERROR` a mount answers a request
   * with that it did not admit, which carries no run's identifier. Nothing for a turn that was not
   * refused. The page reads the thread again after a refused resume.
   */
  takeRefusal(): Refusal | undefined;
  /**
   * Whether a refused resume still owes the mount what it carried, which the next send repeats
   * before anything new is sent.
   */
  owesResume(): boolean;
  /**
   * Whether what a refused resume still owes leaves an interrupt without an entry, so the person's
   * next message is the missing answer and completes it. When it is complete, the resume is sent as
   * a turn of its own, from the entries held, before anything new.
   */
  owedResumeIncomplete(): boolean;
  /**
   * The rows holding answers that no resume owes any longer, once: the mount took them, or the
   * question they answered is gone. The run holds each answer as a row of its own, so the typed
   * rows are dropped from the conversation, and no later start sends one a second time.
   */
  takeSettledAnswerRows(): readonly string[];
  /**
   * The assets the last turn announced that no terminal frame stamped on a row: a turn that ended
   * in an error or a stop carries no history to stamp them on. Answers them once, and the caller
   * puts them on the rows with {@link withAnnouncements}.
   */
  drainAssets(): readonly Announced[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The interrupts a `RUN_FINISHED` event carries, or none for any other event. */
function interruptsOf(event: unknown): Interrupt[] | undefined {
  if (!isRecord(event) || event['type'] !== 'RUN_FINISHED') return undefined;
  const outcome = event['outcome'];
  if (!isRecord(outcome) || outcome['type'] !== 'interrupt') return [];
  const interrupts = outcome['interrupts'];
  if (!Array.isArray(interrupts)) return [];
  return interrupts.filter(
    (entry): entry is Interrupt => isRecord(entry) && typeof entry['id'] === 'string',
  );
}

/** The key every event's `metadata` carries the Bureau's own fields under (`ag-ui-vocabulary.ts`). */
const BUREAU_METADATA_KEY = '@lostgradient/bureau';

/**
 * The round of an approval, as its interrupt shows it and a resume entry sends it back, under the
 * same key (`ag-ui-interrupts.ts`). A question has none.
 */
function roundOf(value: { readonly metadata?: unknown }): number | undefined {
  if (!isRecord(value.metadata)) return undefined;
  const fields = value.metadata[BUREAU_METADATA_KEY];
  return isRecord(fields) && typeof fields['round'] === 'number' ? fields['round'] : undefined;
}

/**
 * An entry that names the round of the approval the person decided, so the mount refuses it as
 * `REVIEW_ROUND_CHANGED` once the approval has been gated again (COR-1714).
 */
function onRoundOf(interrupt: Interrupt, entry: ResumeEntry): ResumeEntry {
  const round = roundOf(interrupt);
  return round === undefined ? entry : { ...entry, metadata: { [BUREAU_METADATA_KEY]: { round } } };
}

/** The Bureau's own identifier for the run an event belongs to, which the cancel route takes. */
function nativeRunIdOf(event: unknown): string | undefined {
  if (!isRecord(event) || !isRecord(event['metadata'])) return undefined;
  const fields = event['metadata'][BUREAU_METADATA_KEY];
  return isRecord(fields) && typeof fields['runId'] === 'string' ? fields['runId'] : undefined;
}

/**
 * What a request was refused with, or `undefined` when `event` is not a refusal. A mount answers a
 * request it did not admit with one `RUN_ERROR` and nothing else, and no run's identifier: a
 * `RUN_ERROR` that ends a run carries the run's own.
 */
function refusalOf(event: unknown, resume: boolean): Refusal | undefined {
  if (!isRecord(event) || event['type'] !== 'RUN_ERROR' || nativeRunIdOf(event) !== undefined) {
    return undefined;
  }
  const code = event['code'];
  const message = event['message'];
  const refusedCode = typeof code === 'string' ? code : undefined;
  const refusedMessage = typeof message === 'string' ? message : '';
  return {
    code: refusedCode,
    message: refusedMessage,
    resume,
    busy: isBusyRefusal(refusedCode, refusedMessage),
  };
}

const CALL_EVENT_TYPES: ReadonlySet<unknown> = new Set([
  'TOOL_CALL_START',
  'TOOL_CALL_ARGS',
  'TOOL_CALL_END',
  'TOOL_CALL_CHUNK',
  'TOOL_CALL_RESULT',
]);

/** Whether `event` is about a tool call the conversation already holds. */
function isCallEventFor(event: unknown, held: ReadonlySet<string>): boolean {
  if (!isRecord(event) || !CALL_EVENT_TYPES.has(event['type'])) return false;
  const callId = event['toolCallId'];
  return typeof callId === 'string' && held.has(callId);
}

/** The identifiers of the tool calls a thread's snapshot holds. */
function snapshotCalls(snapshot: MessagesSnapshotEvent): ReadonlySet<string> {
  return new Set(
    snapshot.messages.flatMap((message) =>
      message.role === 'assistant' ? (message.toolCalls ?? []).map((call) => call.id) : [],
    ),
  );
}

/** The identifiers of the tool calls a conversation holds. */
function heldCalls(conversation: ConversationHistory): ReadonlySet<string> {
  return new Set(
    Object.values(conversation.messages).flatMap((message) =>
      message.toolCall === undefined ? [] : [message.toolCall.id],
    ),
  );
}

function isFollowUp(message: ConversationHistory['messages'][string] | undefined): boolean {
  return message?.metadata?.[FOLLOW_UP_KEY] === true;
}

/**
 * The user turn that opened the run: the last user row that is not a follow-up, and not one of the
 * `ignored` rows (the answers typed to a run's questions). A follow-up row can come after it, and
 * the rows before it belong to turns that are over.
 */
export function openingTurn(
  conversation: ConversationHistory,
  ignored: ReadonlySet<string> = new Set(),
): ConversationHistory['messages'][string] | undefined {
  for (let index = conversation.ids.length - 1; index >= 0; index -= 1) {
    const message = conversation.messages[conversation.ids[index]!];
    if (message?.role === 'user' && !isFollowUp(message) && !ignored.has(message.id)) {
      return message;
    }
  }
  return undefined;
}

/** The conversation without the rows that are not the user's to see. */
function withoutHiddenRows(conversation: ConversationHistory): ConversationHistory {
  return conversation.ids.reduce(
    (current, id) => (conversation.messages[id]?.hidden ? removeMessage(current, id) : current),
    conversation,
  );
}

/** A conversation holding one row, so the AG-UI adapter can export just it. */
function onlyRow(
  conversation: ConversationHistory,
  message: ConversationHistory['messages'][string],
): ConversationHistory {
  return { ...conversation, ids: [message.id], messages: { [message.id]: message } };
}

/** Where the mount embeds a question's answer schema in the interrupt's response schema. */
const ANSWER_SCHEMA_BASE = '#/properties/answer';

/** Keywords whose value is one subschema (the mount's `SUBSCHEMA_KEYWORDS`). */
const SUBSCHEMA_KEYWORDS: ReadonlySet<string> = new Set([
  'items',
  'additionalProperties',
  'contains',
  'propertyNames',
  'not',
  'if',
  'then',
  'else',
  'unevaluatedItems',
  'unevaluatedProperties',
  'contentSchema',
]);
/** Keywords whose value is an array of subschemas (the mount's `SUBSCHEMA_LIST_KEYWORDS`). */
const SUBSCHEMA_LIST_KEYWORDS: ReadonlySet<string> = new Set([
  'allOf',
  'anyOf',
  'oneOf',
  'prefixItems',
]);
/** Keywords whose value maps a name the author chose to a subschema (the mount's `SUBSCHEMA_MAP_KEYWORDS`). */
const SUBSCHEMA_MAP_KEYWORDS: ReadonlySet<string> = new Set([
  'properties',
  'patternProperties',
  '$defs',
  'definitions',
  'dependentSchemas',
]);

/**
 * `schema` with every local reference the mount rebased under {@link ANSWER_SCHEMA_BASE} moved
 * back, so the answer schema is a document of its own again: `#/properties/answer/$defs/x` is
 * `#/$defs/x` and `#/properties/answer` is `#`. It walks only where JSON Schema puts a subschema,
 * as the mount did when it rebased, so a `default`, `const`, `enum` or `examples` that holds such a
 * string is data and stays.
 */
function withReferencesRebasedToRoot(schema: unknown): unknown {
  if (!isRecord(schema)) return schema;
  // Built with `fromEntries`, which defines each key, so a property named `__proto__` stays a key.
  return Object.fromEntries(
    Object.entries(schema).map(([key, entry]): [string, unknown] => {
      if (key === '$ref' && typeof entry === 'string') {
        if (entry === ANSWER_SCHEMA_BASE) return [key, '#'];
        if (entry.startsWith(`${ANSWER_SCHEMA_BASE}/`)) {
          return [key, `#${entry.slice(ANSWER_SCHEMA_BASE.length)}`];
        }
        return [key, entry];
      }
      if (SUBSCHEMA_KEYWORDS.has(key)) return [key, withReferencesRebasedToRoot(entry)];
      if (SUBSCHEMA_LIST_KEYWORDS.has(key) && Array.isArray(entry)) {
        return [key, (entry as unknown[]).map(withReferencesRebasedToRoot)];
      }
      if (SUBSCHEMA_MAP_KEYWORDS.has(key) && isRecord(entry)) {
        return [
          key,
          Object.fromEntries(
            Object.entries(entry).map(([name, child]) => [
              name,
              withReferencesRebasedToRoot(child),
            ]),
          ),
        ];
      }
      return [key, entry];
    }),
  );
}

/**
 * The schema a question's answer must satisfy: the `answer` property of the interrupt's response
 * schema (`responseSchemaFor` in the mount), with its references moved back to its own root. The
 * generic resume schema leaves `answer` as `{}`, which says nothing about the answer, so it is no
 * schema.
 */
function answerSchemaOf(interrupt: Interrupt): Record<string, unknown> | undefined {
  const properties: unknown = isRecord(interrupt.responseSchema)
    ? interrupt.responseSchema['properties']
    : undefined;
  const answer =
    isRecord(properties) && Object.hasOwn(properties, 'answer') ? properties['answer'] : undefined;
  if (!isRecord(answer) || Object.keys(answer).length === 0) return undefined;
  const rooted = withReferencesRebasedToRoot(answer);
  return isRecord(rooted) ? rooted : undefined;
}

/** The questions among `interrupts`, as the page shows them. */
function humanRequestsOf(interrupts: readonly Interrupt[]): HumanRequest[] {
  return interrupts
    .filter((interrupt) => interrupt.reason === 'human-wait')
    .map((interrupt) => {
      const schema = answerSchemaOf(interrupt);
      return {
        interruptId: interrupt.id,
        message: interrupt.message ?? '',
        ...(schema === undefined ? {} : { schema }),
      };
    });
}

/** The text of a message, which is what a question is answered with. */
function textOf(message: ConversationHistory['messages'][string]): string {
  if (typeof message.content === 'string') return message.content;
  return message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n');
}

/** The result row an interrupt parks its tool call on, until the user decides. */
function approvalRow(interrupt: Interrupt, toolCallId: string): ToolResult {
  return {
    callId: toolCallId,
    outcome: 'action_required',
    content: interrupt.message ?? 'This tool call needs your approval.',
    action: {
      type: 'approval',
      ...(interrupt.message === undefined ? {} : { message: interrupt.message }),
      risk: 'medium',
      operation: { kind: 'other' },
      policyVersion: 'bureau',
      idempotencyKey: interrupt.id,
      ...(interrupt.expiresAt === undefined ? {} : { expiresAt: interrupt.expiresAt }),
    },
  };
}

/** A terminal conversation with each tool call that is waiting on the user parked on its approval. */
function withApprovalRows(
  conversation: ConversationHistory,
  interrupts: readonly Interrupt[],
): ConversationHistory {
  return interrupts.reduce((current, interrupt) => {
    const toolCallId = interrupt.toolCallId;
    if (interrupt.reason !== 'tool-approval' || toolCallId === undefined) return current;
    const row = findToolResultMessage(current, toolCallId, { includeHidden: true });
    if (row === undefined || row.toolResult?.outcome === 'action_required') return current;
    return replaceToolResult(current, toolCallId, approvalRow(interrupt, toolCallId));
  }, conversation);
}

/**
 * The turn's frames, with the history the run ends with made what the chat should show: each tool
 * call that is waiting on the user parked on its approval, and the person's answers to questions
 * left out. The run appends its own row for an answer (`ag-ui-resume.ts`), which is in the history
 * it ends with, so the row the person typed would be a second one, ahead of the call it answers.
 * The assets the run announced are put on the rows that carry them, as a reloaded thread's
 * snapshot has them.
 */
async function* parkApprovals(
  frames: AsyncIterable<ChatStreamEvent>,
  interrupts: () => readonly Interrupt[],
  answerRowIds: ReadonlySet<string>,
  announced: Announced[],
  agentName: () => string,
  owns: (id: string) => boolean,
  stamped: () => void,
): AsyncGenerator<ChatStreamEvent> {
  for await (const frame of frames) {
    if (frame.type !== 'run.completed') {
      yield frame;
      continue;
    }
    const parked = withStoredMemoryNotes(
      withAnnouncements(withApprovalRows(frame.conversation, interrupts()), announced, owns),
      agentName(),
    );
    // Stamped, so nothing is left for the end of the turn to put on a row a second time.
    announced.splice(0);
    stamped();
    yield {
      ...frame,
      conversation: [...answerRowIds].reduce(
        (current, id) =>
          current.messages[id] === undefined ? current : removeMessage(current, id),
        parked,
      ),
    };
  }
}

function resumeEntryFor(interrupt: Interrupt, resolution: ApprovalResolution): ResumeEntry {
  return onRoundOf(interrupt, answerTo(interrupt, resolution));
}

function answerTo(interrupt: Interrupt, resolution: ApprovalResolution): ResumeEntry {
  if (resolution.decision === 'approve' || resolution.decision === 'approve_with_edits') {
    return {
      interruptId: interrupt.id,
      status: 'resolved',
      payload: {
        decision: 'approve',
        ...(resolution.decision === 'approve_with_edits' && resolution.editedArgs !== undefined
          ? { arguments: resolution.editedArgs }
          : {}),
      },
    };
  }
  return {
    interruptId: interrupt.id,
    status: 'resolved',
    payload: {
      decision: 'deny',
      ...(resolution.reason === undefined || resolution.reason.trim() === ''
        ? {}
        : { reason: resolution.reason }),
    },
  };
}

function resultFor(toolCallId: string, resolution: ApprovalResolution): ToolResult {
  if (resolution.decision === 'approve' || resolution.decision === 'approve_with_edits') {
    return { callId: toolCallId, outcome: 'success', content: { decision: 'approved' } };
  }
  return {
    callId: toolCallId,
    outcome: 'error',
    content: { decision: 'denied' },
    error: {
      code: 'approval-denied',
      category: 'permission',
      retryable: false,
      message: resolution.reason ?? 'The approval was denied.',
    },
  };
}

/** One `bureau.asset-part` event: an asset the assistant row `messageId` carries. */
export type AssetAnnouncement = AssetPartReference & { readonly messageId: string };

/**
 * What a run announced while it streamed that its history does not hold: an asset a row carries,
 * or a line under a message (memory written, a wakeup, a child run).
 */
export type Announced = AssetAnnouncement | NoteAnnouncement;

function isNoteAnnouncement(announced: Announced): announced is NoteAnnouncement {
  return 'kind' in announced;
}

function announcedKey(announced: Announced): string {
  return isNoteAnnouncement(announced)
    ? noteAnnouncementKey(announced)
    : `asset:${announced.messageId}:${String(announced.index)}`;
}

/** The announcement a `CUSTOM` event carries, or `undefined` for any other event. */
function announcementOf(event: unknown): AssetAnnouncement | undefined {
  if (!isRecord(event) || event['type'] !== 'CUSTOM' || event['name'] !== ASSET_PART_EVENT_NAME) {
    return undefined;
  }
  const value = event['value'];
  if (
    !isRecord(value) ||
    typeof value['messageId'] !== 'string' ||
    typeof value['index'] !== 'number' ||
    typeof value['assetId'] !== 'string' ||
    typeof value['mediaType'] !== 'string'
  ) {
    return undefined;
  }
  return {
    messageId: value['messageId'],
    index: value['index'],
    assetId: value['assetId'],
    mediaType: value['mediaType'],
  };
}

/** One asset part per row and index, and one line per note, even if an announcement is replayed. */
function rememberAnnouncement(announcements: Announced[], announcement: Announced): void {
  const key = announcedKey(announcement);
  const index = announcements.findIndex((entry) => announcedKey(entry) === key);
  if (index < 0) announcements.push(announcement);
  else announcements[index] = announcement;
}

/**
 * The conversation with each announced asset on the row that carries it, under
 * {@link ASSET_PARTS_METADATA_KEY}, in part order: the key a reloaded thread's snapshot already
 * holds, so a live row and a reloaded one are read the same way. An announcement for a row the
 * conversation does not hold is dropped.
 */
export function withAssetParts(
  conversation: ConversationHistory,
  everything: readonly Announced[],
): ConversationHistory {
  const announced = everything.filter(
    (announcement): announcement is AssetAnnouncement => !isNoteAnnouncement(announcement),
  );
  if (announced.length === 0) return conversation;
  const messages = { ...conversation.messages };
  for (const messageId of new Set(announced.map((announcement) => announcement.messageId))) {
    const message = messages[messageId];
    if (message === undefined) continue;
    const assets = announced
      .filter((announcement) => announcement.messageId === messageId)
      .map(({ index, assetId, mediaType }): AssetPartReference => ({ index, assetId, mediaType }))
      .toSorted((left, right) => left.index - right.index);
    messages[messageId] = {
      ...message,
      metadata: { ...message.metadata, [ASSET_PARTS_METADATA_KEY]: assets },
    };
  }
  return { ...conversation, messages };
}

/**
 * The conversation with everything the run announced on the rows it belongs to: the assets a row
 * carries, and the lines under a message (memory written, a wakeup, a child run).
 */
export function withAnnouncements(
  conversation: ConversationHistory,
  announced: readonly Announced[],
  owns?: (id: string) => boolean,
): ConversationHistory {
  return withEventNotes(
    withAssetParts(conversation, announced),
    announced.filter(isNoteAnnouncement),
    { owns },
  );
}

/** The AG-UI part type an attachment of `mimeType` is sent as. A text file is a document. */
function partTypeOf(mimeType: string): 'image' | 'audio' | 'video' | 'document' {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.startsWith('video/')) return 'video';
  return 'document';
}

/** The AG-UI parts for the attachments that finished uploading, each naming its asset. */
function attachmentParts(attachments: readonly ChatAttachment[]): Record<string, unknown>[] {
  return attachments.flatMap((attachment) => {
    const { reference } = attachment;
    if (attachment.status !== 'ready' || reference === undefined) return [];
    if (attachment.restoreText !== undefined) return [];
    const mimeType =
      reference.mimeType ?? (attachment.file.type === '' ? undefined : attachment.file.type);
    return [
      {
        type: partTypeOf(mimeType ?? ''),
        source: {
          type: 'file',
          provider: ASSET_FILE_PROVIDER,
          value: reference.id,
          ...(mimeType === undefined ? {} : { mimeType }),
        },
      },
    ];
  });
}

/** The identifiers of the assets a message's content already names. */
function namedAssets(content: unknown): ReadonlySet<string> {
  if (!Array.isArray(content)) return new Set();
  return new Set(
    content.flatMap((part): string[] => {
      const source: unknown = isRecord(part) ? part['source'] : undefined;
      return isRecord(source) && source['provider'] === ASSET_FILE_PROVIDER
        ? [String(source['value'])]
        : [];
    }),
  );
}

/**
 * `messages` with the attachments' parts added to the message `openerId`, which keeps its text as
 * a text part. A file the message already names (the chat page puts it on the row it appends) is
 * not added twice. A message with no attachment to add is left as it is.
 */
function withAttachmentParts<T extends { id: string }>(
  messages: readonly T[],
  openerId: string | undefined,
  attachments: readonly ChatAttachment[],
): T[] {
  if (openerId === undefined) return [...messages];
  return messages.map((message) => {
    if (message.id !== openerId) return message;
    const content: unknown = Reflect.get(message, 'content');
    const named = namedAssets(content);
    const parts = attachmentParts(
      attachments.filter((attachment) => !named.has(attachment.reference?.id ?? '')),
    );
    if (parts.length === 0) return message;
    const lead =
      typeof content === 'string'
        ? content === ''
          ? []
          : [{ type: 'text', text: content }]
        : Array.isArray(content)
          ? content
          : [];
    return { ...message, content: [...lead, ...parts] };
  });
}

/**
 * The request a Stop must not abort before the response's first event. The mount admits a request
 * before it answers, and the run it began has no identifier a client can cancel it by until that
 * event names it, so a fetch aborted before it leaves a run nobody can stop and a thread that
 * refuses the next message as busy. The gate holds the fetch open until the first event has
 * arrived, and then lets a Stop end it as it always did.
 */
type FirstEventGate = {
  /** The signal the fetch carries. */
  readonly signal: AbortSignal;
  /** The response's first event has arrived. */
  arrived(): void;
  dispose(): void;
};

export function createChatRunWiring(options: ChatRunWiringOptions): ChatRunWiring {
  const send = options.fetch ?? fetch;
  /** The interrupts the latest run ended on, read from its raw events. */
  let interrupts: readonly Interrupt[] = [];
  /** The decisions on approvals, by interrupt, that no request the mount answered has carried. */
  const decisions = new Map<string, ResumeEntry>();
  /** The text typed to answer each question, by interrupt, with the row it was typed in. */
  const answers = new Map<
    string,
    { readonly entry: ResumeEntry; readonly rowId: string | undefined }
  >();
  /** The start the mount has not answered, so a retry of the same request is the same run. */
  let unanswered: { readonly fingerprint: string; readonly runId: string } | undefined;
  let attached: AsyncGenerator<unknown> | undefined;
  let lastAttachCursor: string | undefined;
  let attachGeneration = 0;
  let detached = false;
  /** The assets the turn on screen announced that no terminal frame has put on a row. */
  let unstamped: Announced[] = [];
  /** Recovery survives an unsuccessful turn draining its UI handoff after rollback. */
  let assetRun: { readonly id: string; readonly announcements: Announced[] } | undefined;
  let transportGeneration = 0;
  /** What the last turn was refused with, until it is taken. */
  let refusal: Refusal | undefined;
  /** Whether a resume was refused and what it carried is still held, to be sent again. */
  let refusedResume = false;
  /** The rows of answers that are settled and not yet dropped from the conversation. */
  let settledAnswerRows: string[] = [];

  /** The questions the run waits on that no answer is held for, in the order the run asked them. */
  function unansweredRequests(): HumanRequest[] {
    return humanRequestsOf(interrupts).filter((request) => !answers.has(request.interruptId));
  }

  /**
   * Makes `next` what the run waits on. An answer held for an interrupt that is not among them is
   * dropped: the mount has settled it, so a resume that carried it would be refused. So is a
   * decision on an approval that is at another round now: it was gated again under the same id, and
   * the person decides the request they have not seen yet (COR-1714).
   */
  function setInterrupts(next: readonly Interrupt[]): void {
    interrupts = next;
    const pending = new Map(next.map((interrupt) => [interrupt.id, roundOf(interrupt)]));
    // Deleting from a map while it is walked is safe: the walk skips what it has already left.
    for (const [id, entry] of decisions) {
      if (!pending.has(id) || pending.get(id) !== roundOf(entry)) decisions.delete(id);
    }
    for (const [id, answer] of answers) {
      if (pending.has(id)) continue;
      answers.delete(id);
      settleAnswerRow(answer.rowId);
    }
    if (decisions.size === 0 && answers.size === 0) refusedResume = false;
    options.onHumanRequests?.(unansweredRequests());
  }

  /** Notes that the row an answer was typed in is settled, when the answer was typed in one. */
  function settleAnswerRow(rowId: string | undefined): void {
    if (rowId !== undefined) settledAnswerRows.push(rowId);
  }

  /**
   * Holds `value`, the answer `ChatQuestion` drew a control for, as the answer to the question of
   * `interruptId`. Nothing was typed, so no row holds it. False when that question is not one the
   * run waits on without an answer.
   */
  function holdValue(interruptId: string, value: unknown): boolean {
    if (!unansweredRequests().some((request) => request.interruptId === interruptId)) return false;
    answers.set(interruptId, {
      entry: {
        interruptId,
        status: 'resolved',
        payload: { decision: 'approve', answer: value },
      },
      rowId: undefined,
    });
    options.onHumanRequests?.(unansweredRequests());
    return true;
  }

  function releaseValue(interruptId: string): boolean {
    const held = answers.get(interruptId);
    // A typed answer has a row that holds it, and the person's next message takes its place.
    if (held === undefined || held.rowId !== undefined) return false;
    answers.delete(interruptId);
    if (decisions.size === 0 && answers.size === 0) refusedResume = false;
    options.onHumanRequests?.(unansweredRequests());
    return true;
  }

  /** Holds `text`, typed in the row `rowId`, as the answer to the first question without one. */
  function holdAnswer(text: string, rowId: string): boolean {
    const waiting = unansweredRequests()[0];
    if (waiting === undefined) return false;
    answers.set(waiting.interruptId, {
      entry: {
        interruptId: waiting.interruptId,
        status: 'resolved',
        payload: { decision: 'approve', answer: text },
      },
      rowId,
    });
    options.onHumanRequests?.(unansweredRequests());
    return true;
  }

  /**
   * Stops the Bureau's run: a stop on this page ends this page's stream, and the run goes on
   * unless it is told to stop. Resolves once the run has ended, so a turn sent next finds the
   * thread free.
   */
  async function cancelRun(nativeRunId: string): Promise<void> {
    const encoded = encodeURIComponent(nativeRunId);
    await send(`${AG_UI_PATH}/runs/${encoded}/cancel`, { method: 'POST' }).catch(() => undefined);
    // The run's own stream ends when the run does.
    const ended = readEvents(() =>
      send(`${AG_UI_PATH}/runs/${encoded}`, { headers: { accept: 'text/event-stream' } }),
    );
    try {
      // Only the end matters.
      await Array.fromAsync(ended);
    } catch {
      // A run that is already over answers with an error event or none.
    }
  }

  /** The gate a start's fetch runs behind, for the turn `stop` can end. */
  function firstEventGate(stop: AbortSignal): FirstEventGate {
    const fetching = new AbortController();
    let waiting = true;
    // Leaving the page is not a Stop and has nothing to cancel, so nothing is waited for.
    const onStop = (): void => {
      if (!waiting || detached) fetching.abort();
    };
    stop.addEventListener('abort', onStop, { once: true });
    return {
      signal: fetching.signal,
      arrived() {
        waiting = false;
      },
      dispose() {
        stop.removeEventListener('abort', onStop);
      },
    };
  }

  async function* observe(
    events: AsyncIterable<unknown>,
    signal: AbortSignal,
    started: boolean,
    announced: Announced[],
    gate: FirstEventGate | undefined,
    generation: number,
  ): AsyncGenerator<unknown> {
    let nativeRunId: string | undefined;
    let held: ReadonlySet<string> | undefined;
    try {
      for await (const event of events) {
        if (generation !== transportGeneration) return;
        gate?.arrived();
        nativeRunId ??= nativeRunIdOf(event);
        // A Stop before this event is acted on here, now that the run it began has a name: the
        // run is cancelled below, and nothing of the turn is shown.
        if (signal.aborted) return;
        // Read at the first event, not when the turn started, and the calls this stream streams
        // itself arrive after, never before. A snapshot replaces the conversation, so the calls
        // it holds are the ones held from then on: an attach's turn starts before the thread is
        // back on screen, without the approvals it is parked on (`chat-session.svelte.ts`).
        held ??= heldCalls(options.conversation());
        if (isMessagesSnapshot(event)) held = snapshotCalls(event);
        if (isRecord(event) && event['type'] === 'RUN_STARTED') {
          const identity =
            nativeRunId ?? (typeof event['runId'] === 'string' ? event['runId'] : undefined);
          if (identity !== undefined) {
            if (assetRun?.id !== identity) assetRun = { id: identity, announcements: [] };
            announced.push(...assetRun.announcements);
          }
          if (started) options.onRunStarted?.();
          // A run that has begun is waiting on nobody.
          options.onHumanRequests?.([]);
        }
        if (
          isRecord(event) &&
          event['type'] === 'RUN_ERROR' &&
          (event['code'] === 'STREAM_DEADLINE' || event['code'] === 'STREAM_OVERFLOW')
        ) {
          throw new Error(String(event['message']));
        }
        if (isRecord(event) && (event['type'] === 'RUN_FINISHED' || event['type'] === 'RUN_ERROR'))
          options.onTerminal?.();
        if (isRecord(event) && event['type'] === 'MESSAGES_SNAPSHOT') {
          announced.splice(0);
          assetRun?.announcements.splice(0);
        }
        const announcement =
          announcementOf(event) ?? noteAnnouncementOf(event, options.agentName());
        if (announcement !== undefined) {
          rememberAnnouncement(announced, announcement);
          if (assetRun !== undefined) rememberAnnouncement(assetRun.announcements, announcement);
        }
        const ended = interruptsOf(event);
        if (ended !== undefined) setInterrupts(ended);
        // A run that follows an approval shows the call it was waiting on again, for a client that
        // did not watch it run. This conversation holds the call, and holds it only once.
        if (isCallEventFor(event, held)) continue;
        yield event;
      }
    } finally {
      gate?.dispose();
      // An abort is a Stop only while the page is still here: leaving it ends the signal too, and
      // the run goes on.
      if (signal.aborted && !detached && nativeRunId !== undefined) await cancelRun(nativeRunId);
    }
  }

  /** What a start carries: the entries of a resume, and the rows the person's answers are in. */
  type Resume = {
    readonly entries: readonly ResumeEntry[];
    /** The rows holding the answers typed to the run's questions. */
    readonly answerRowIds: ReadonlySet<string>;
    /** Whether an interrupt the run waits on has no entry yet, so a resume would be refused. */
    readonly incomplete: boolean;
  };

  /**
   * What a start's resume carries. The row the person has just typed answers the first question
   * still without an answer; a row typed earlier is already held, and a turn the controller starts
   * for a decision has no new row. Every interrupt the run waits on needs an entry before one
   * resume can carry them all.
   */
  function resumeFor(conversation: ConversationHistory): Resume {
    const last = conversation.messages[conversation.ids.at(-1) ?? ''];
    const held = new Set(
      [...answers.values()].flatMap((answer) => (answer.rowId === undefined ? [] : [answer.rowId])),
    );
    if (last?.role === 'user' && !isFollowUp(last) && !held.has(last.id)) {
      if (holdAnswer(textOf(last), last.id)) held.add(last.id);
    }
    const { entries, incomplete } = entriesOwed();
    return { entries, answerRowIds: held, incomplete };
  }

  /** The entries held for the interrupts the run waits on, and whether one of them has none yet. */
  function entriesOwed(): {
    readonly entries: readonly ResumeEntry[];
    readonly incomplete: boolean;
  } {
    const answerable = interrupts.filter(
      (interrupt) =>
        interrupt.reason === 'human-wait' ||
        (interrupt.reason === 'tool-approval' && interrupt.toolCallId !== undefined),
    );
    const entries = answerable.flatMap(
      (interrupt) => decisions.get(interrupt.id) ?? answers.get(interrupt.id)?.entry ?? [],
    );
    return { entries, incomplete: entries.length > 0 && entries.length < answerable.length };
  }

  function runInput(
    conversation: ConversationHistory,
    resume: Resume,
    attachments: readonly ChatAttachment[],
  ): RunAgentInput {
    const base = {
      tools: [],
      context: [],
      state: {},
      forwardedProps: {},
      threadId: conversation.id,
    };
    if (resume.entries.length === 0) {
      return {
        ...base,
        runId: runIdFor(conversation.id, [], conversation.ids),
        messages: withAttachmentParts(
          agUiConversationAdapter.export(conversation),
          openingTurn(conversation)?.id,
          attachments,
        ),
      };
    }
    // The person's answers ride in the resume. As messages too they would be second rows, next to
    // the ones the run appends for them. A decision on an approval continues the turn that opened
    // the run, which the resume carries.
    const opener = decisions.size > 0 ? openingTurn(conversation, resume.answerRowIds) : undefined;
    const messages =
      opener === undefined
        ? []
        : withAttachmentParts(
            agUiConversationAdapter.export(onlyRow(conversation, opener)),
            opener.id,
            attachments,
          );
    return {
      ...base,
      runId: runIdFor(
        conversation.id,
        resume.entries,
        messages.map((message) => message.id),
      ),
      messages,
      resume: [...resume.entries],
    };
  }

  /** The run identifier a request goes under: the one an unanswered attempt of it already used. */
  function runIdFor(
    threadId: string,
    entries: readonly ResumeEntry[],
    messageIds: readonly string[],
  ): string {
    const fingerprint = JSON.stringify([threadId, messageIds, entries]);
    if (unanswered?.fingerprint === fingerprint) return unanswered.runId;
    unanswered = { fingerprint, runId: `run-${crypto.randomUUID()}` };
    return unanswered.runId;
  }

  /** What the mount's first event settles: the request it answered is no longer one to repeat. */
  function acknowledged(sent: readonly ResumeEntry[]): void {
    unanswered = undefined;
    for (const entry of sent) {
      if (decisions.get(entry.interruptId) === entry) decisions.delete(entry.interruptId);
      const answer = answers.get(entry.interruptId);
      if (answer?.entry === entry) {
        answers.delete(entry.interruptId);
        settleAnswerRow(answer.rowId);
      }
    }
    refusedResume = false;
    // The questions and approvals of the run before are answered, or refused as the mount sees fit.
    interrupts = [];
  }

  /**
   * The mount refused a resume as `INVALID_INPUT` (COR-1804): an answer typed to a question does not
   * fit the schema the question carries. Sending the same text again is refused the same way for
   * ever, so the answers a refused resume carried are dropped, and the questions are asked again;
   * the person's next message answers the first of them, and any approval already decided stays
   * held. The rows that held the typed answers go with them, so the agent is not sent them as a
   * message of their own.
   */
  function unfittingAnswers(sent: readonly ResumeEntry[]): void {
    unanswered = undefined;
    for (const entry of sent) {
      const answer = answers.get(entry.interruptId);
      if (answer?.entry !== entry) continue;
      answers.delete(entry.interruptId);
      settleAnswerRow(answer.rowId);
    }
    if (decisions.size === 0 && answers.size === 0) refusedResume = false;
    options.onHumanRequests?.(unansweredRequests());
  }

  async function* untilAnswered(
    events: AsyncIterable<unknown>,
    sent: readonly ResumeEntry[],
  ): AsyncGenerator<unknown> {
    let answered = false;
    for await (const event of events) {
      if (!answered) {
        answered = true;
        const refused = refusalOf(event, sent.length > 0);
        if (refused !== undefined) refusal = refused;
        if (refused?.resume === true) refusedResume = true;
        // A refusal is the mount's answer to a start, but not to a resume: the entries it carried
        // are still owed, and what is still pending is read again before they are sent.
        if (refused === undefined || sent.length === 0) acknowledged(sent);
        else if (refused.resume && refused.code === 'INVALID_INPUT') unfittingAnswers(sent);
      }
      yield event;
    }
  }

  function startEvents(
    request: ChatSessionRequest,
    gate: FirstEventGate,
  ): {
    readonly events: AsyncGenerator<unknown>;
    readonly answerRowIds: ReadonlySet<string>;
    /** Whether nothing is sent, because an interrupt the run waits on is still unanswered. */
    readonly held: boolean;
  } {
    const conversation = withoutHiddenRows(request.conversation);
    const resume = resumeFor(conversation);
    if (resume.incomplete) {
      return { events: (async function* () {})(), answerRowIds: resume.answerRowIds, held: true };
    }
    const input = runInput(conversation, resume, request.attachments);
    const events = untilAnswered(
      readEvents(
        () =>
          send(`${AG_UI_PATH}/agents/${encodeURIComponent(options.agentName())}/run`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
            body: JSON.stringify(input),
            signal: gate.signal,
          }),
        {
          onCursor: (cursor) => {
            if (!gate.signal.aborted) lastAttachCursor = cursor;
          },
          onFrame: () => {
            if (!gate.signal.aborted) options.onFrame?.();
          },
        },
      ),
      resume.entries,
    );
    return { events, answerRowIds: resume.answerRowIds, held: false };
  }

  /**
   * The turn the controller starts for a decision or an answer while another interrupt of the run
   * is still unanswered: a run that began and ended with the conversation as it was, and no request.
   * The run is not told to the page as one that began, because none did.
   */
  function heldTurn(request: ChatSessionRequest): AsyncGenerator<ChatStreamEvent> {
    const threadId = request.conversation.id;
    const runId = `held-${crypto.randomUUID()}`;
    return mapAGUIEventsToChatStream(
      [
        { type: EventType.RUN_STARTED, threadId, runId },
        { type: EventType.RUN_FINISHED, threadId, runId, outcome: { type: 'success' } },
      ],
      { conversation: withoutHiddenRows(request.conversation) },
    );
  }

  const mapper = new ResumableMapper((history) => options.onSnapshot?.(history));

  const transport: ChatSessionTransport = (request) => {
    refusal = undefined;
    const attachedStream = attached;
    attached = undefined;
    // Only a start has a fetch of its own for a Stop to wait on; an attach reads a stream the page
    // opened earlier, under a signal of its own.
    let gate: FirstEventGate | undefined;
    let opened: { events: AsyncIterable<unknown>; answerRowIds: ReadonlySet<string> };
    if (attachedStream === undefined) {
      gate = firstEventGate(request.signal);
      const start = startEvents(request, gate);
      // Nothing was sent, so there is no fetch for a Stop to wait on and nothing to observe.
      if (start.held) {
        gate.dispose();
        return heldTurn(request);
      }
      opened = start;
    } else {
      opened = { events: attachedStream, answerRowIds: new Set() };
    }
    const generation = ++transportGeneration;
    const startIds = new Set(request.conversation.ids);
    const announced: Announced[] = [];
    unstamped = announced;
    // An attach reads a thread the page may know nothing of yet: its first rows come from the
    // snapshot, and the row the controller appended to start the turn is not one of them.
    const frames = mapper.map(
      observe(
        opened.events,
        request.signal,
        attachedStream === undefined,
        announced,
        gate,
        generation,
      ),
      withoutHiddenRows(request.conversation),
    );
    return parkApprovals(
      frames,
      // An approval already decided here stays decided while the mount still has it pending.
      () => interrupts.filter((interrupt) => !decisions.has(interrupt.id)),
      opened.answerRowIds,
      announced,
      options.agentName,
      // The rows on screen when the turn began are the page's own: the terminal history leaves its
      // copy of them in place, so the run's notes belong on the rows the run made.
      (id) => !startIds.has(id),
      () => {
        if (generation === transportGeneration) assetRun = undefined;
      },
    );
  };

  return {
    transport,
    async resolveToolApproval(toolCallId, resolution) {
      const interrupt = interrupts.find((entry) => entry.toolCallId === toolCallId);
      if (interrupt === undefined) {
        throw new Error('No approval is waiting for this tool call.');
      }
      decisions.set(interrupt.id, resumeEntryFor(interrupt, resolution));
      return resultFor(toolCallId, resolution);
    },
    async attach(threadId, signal) {
      const current = ++attachGeneration;
      const events = readEvents(
        () =>
          send(`${AG_UI_PATH}/threads/${encodeURIComponent(threadId)}/run`, {
            headers: {
              accept: 'text/event-stream',
              ...(lastAttachCursor === undefined ? {} : { 'Last-Event-ID': lastAttachCursor }),
            },
            ...(signal === undefined ? {} : { signal }),
          }),
        {
          onCursor: (cursor) => {
            if (!signal?.aborted && current === attachGeneration) lastAttachCursor = cursor;
          },
          onFrame: () => {
            if (!signal?.aborted && current === attachGeneration) options.onFrame?.();
          },
        },
      );
      const started = await events.next();
      if (
        started.done === true ||
        !isRecord(started.value) ||
        started.value['type'] !== 'RUN_STARTED'
      ) {
        await events.return(undefined);
        // The thread has nothing going or waiting, so nothing answered for it can still be sent.
        setInterrupts([]);
        return undefined;
      }
      // An attach stream opens with the thread as a snapshot, which is what restores a transcript
      // the page never held.
      const snapshot = await events.next();
      const opening = [started.value, ...(snapshot.done === true ? [] : [snapshot.value])];
      if (signal?.aborted || current !== attachGeneration) {
        await events.return(undefined);
        return undefined;
      }
      const opened = opening;
      const messages =
        snapshot.done !== true && isMessagesSnapshot(snapshot.value) ? snapshot.value.messages : [];
      // A valid live-cursor resume has no snapshot: preserve the transcript already
      // on screen. A snapshot is authoritative and therefore starts from an empty
      // history so no stale row can survive the replacement.
      const restored =
        snapshot.done !== true && isMessagesSnapshot(snapshot.value)
          ? withStoredMemoryNotes(
              mergeAGUIMessages(createConversationHistory({ id: threadId }), messages),
              options.agentName(),
            )
          : options.conversation();
      attached = (async function* () {
        try {
          for (const event of opened) {
            if (signal?.aborted || current !== attachGeneration) return;
            yield event;
          }
          for await (const event of events) {
            if (signal?.aborted || current !== attachGeneration) return;
            yield event;
          }
        } finally {
          await events.return(undefined);
        }
      })();
      return restored;
    },
    async history(threadId, signal) {
      // An attach that resumed from the old cursor would keep this history and replay the run from
      // past rows it does not hold, such as a parked call's result without its call.
      lastAttachCursor = undefined;
      let messages: readonly unknown[];
      try {
        messages = await getThreadMessages(threadId, {
          fetch: send,
          ...(signal === undefined ? {} : { signal }),
        });
      } catch (error) {
        // A thread the Bureau has no record of, or that the caller may not read, has no history.
        if (error instanceof HttpClientError && error.status === 404) return undefined;
        throw error;
      }
      const snapshot = { type: 'MESSAGES_SNAPSHOT', messages };
      if (!isMessagesSnapshot(snapshot)) {
        throw new Error('The server answered with messages this page cannot read.');
      }
      const thread = withStoredMemoryNotes(
        mergeAGUIMessages(createConversationHistory({ id: threadId }), snapshot.messages),
        options.agentName(),
      );
      // The stream said why a run stopped while it was watched and does not say it again, so the
      // run's own record is read. The line is a courtesy: a record that cannot be read leaves the
      // thread as it is rather than failing the page's read of it.
      const lastRun = await getLastRun(threadId, {
        fetch: send,
        ...(signal === undefined ? {} : { signal }),
      }).catch(() => undefined);
      return withStopReason(thread, lastRun);
    },
    detach() {
      detached = true;
    },
    holdAnswer,
    holdValue,
    releaseValue,
    owesResume: () => refusedResume && (decisions.size > 0 || answers.size > 0),
    owedResumeIncomplete: () => refusedResume && entriesOwed().incomplete,
    takeSettledAnswerRows() {
      return settledAnswerRows.splice(0);
    },
    takeRefusal() {
      const taken = refusal;
      refusal = undefined;
      return taken;
    },
    drainAssets() {
      return unstamped.splice(0);
    },
    async discardAttach() {
      const dropped = attached;
      attached = undefined;
      await dropped?.return(undefined);
    },
  };
}
