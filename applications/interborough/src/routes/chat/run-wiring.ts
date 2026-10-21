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
import { readEvents } from './ag-ui-events.ts';

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
};

export type ChatRunWiringOptions = {
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
   * Bureau has no such thread. It is how a finished session's transcript comes back.
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
   * puts them on the rows with {@link withAssetParts}.
   */
  drainAssets(): readonly AssetAnnouncement[];
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

/** The questions among `interrupts`, as the page shows them. */
function humanRequestsOf(interrupts: readonly Interrupt[]): HumanRequest[] {
  return interrupts
    .filter((interrupt) => interrupt.reason === 'human-wait')
    .map((interrupt) => ({ interruptId: interrupt.id, message: interrupt.message ?? '' }));
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
  announced: AssetAnnouncement[],
): AsyncGenerator<ChatStreamEvent> {
  for await (const frame of frames) {
    if (frame.type !== 'run.completed') {
      yield frame;
      continue;
    }
    const parked = withAssetParts(withApprovalRows(frame.conversation, interrupts()), announced);
    // Stamped, so nothing is left for the end of the turn to put on a row a second time.
    announced.splice(0);
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

/**
 * The conversation with each announced asset on the row that carries it, under
 * {@link ASSET_PARTS_METADATA_KEY}, in part order: the key a reloaded thread's snapshot already
 * holds, so a live row and a reloaded one are read the same way. An announcement for a row the
 * conversation does not hold is dropped.
 */
export function withAssetParts(
  conversation: ConversationHistory,
  announced: readonly AssetAnnouncement[],
): ConversationHistory {
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
  const answers = new Map<string, { readonly entry: ResumeEntry; readonly rowId: string }>();
  /** The start the mount has not answered, so a retry of the same request is the same run. */
  let unanswered: { readonly fingerprint: string; readonly runId: string } | undefined;
  let attached: AsyncGenerator<unknown> | undefined;
  let detached = false;
  /** The assets the turn on screen announced that no terminal frame has put on a row. */
  let unstamped: AssetAnnouncement[] = [];
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
   * dropped: the mount has settled it, so a resume that carried it would be refused.
   */
  function setInterrupts(next: readonly Interrupt[]): void {
    interrupts = next;
    const pending = new Set(next.map((interrupt) => interrupt.id));
    // Deleting from a map while it is walked is safe: the walk skips what it has already left.
    for (const id of decisions.keys()) if (!pending.has(id)) decisions.delete(id);
    for (const [id, answer] of answers) {
      if (pending.has(id)) continue;
      answers.delete(id);
      settledAnswerRows.push(answer.rowId);
    }
    if (decisions.size === 0 && answers.size === 0) refusedResume = false;
    options.onHumanRequests?.(unansweredRequests());
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
    announced: AssetAnnouncement[],
    gate: FirstEventGate | undefined,
  ): AsyncGenerator<unknown> {
    let nativeRunId: string | undefined;
    let held: ReadonlySet<string> | undefined;
    try {
      for await (const event of events) {
        gate?.arrived();
        nativeRunId ??= nativeRunIdOf(event);
        // A Stop before this event is acted on here, now that the run it began has a name: the
        // run is cancelled below, and nothing of the turn is shown.
        if (signal.aborted) return;
        // Read at the first event, not when the turn started: an attach restores the thread right
        // after it starts, and the calls this stream streams itself arrive after, never before.
        held ??= heldCalls(options.conversation());
        if (isRecord(event) && event['type'] === 'RUN_STARTED') {
          if (started) options.onRunStarted?.();
          // A run that has begun is waiting on nobody.
          options.onHumanRequests?.([]);
        }
        const announcement = announcementOf(event);
        if (announcement !== undefined) announced.push(announcement);
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
    const held = new Set([...answers.values()].map((answer) => answer.rowId));
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
        settledAnswerRows.push(answer.rowId);
      }
    }
    refusedResume = false;
    // The questions and approvals of the run before are answered, or refused as the mount sees fit.
    interrupts = [];
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
      readEvents(() =>
        send(`${AG_UI_PATH}/agents/${encodeURIComponent(options.agentName())}/run`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
          body: JSON.stringify(input),
          signal: gate.signal,
        }),
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
    const announced: AssetAnnouncement[] = [];
    unstamped = announced;
    // An attach reads a thread the page may know nothing of yet: its first rows come from the
    // snapshot, and the row the controller appended to start the turn is not one of them.
    const frames = mapAGUIEventsToChatStream(
      observe(opened.events, request.signal, attachedStream === undefined, announced, gate),
      {
        conversation: withoutHiddenRows(request.conversation),
      },
    );
    return parkApprovals(
      frames,
      // An approval already decided here stays decided while the mount still has it pending.
      () => interrupts.filter((interrupt) => !decisions.has(interrupt.id)),
      opened.answerRowIds,
      announced,
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
      const events = readEvents(() =>
        send(`${AG_UI_PATH}/threads/${encodeURIComponent(threadId)}/run`, {
          headers: { accept: 'text/event-stream' },
          ...(signal === undefined ? {} : { signal }),
        }),
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
      const opened = [started.value, ...(snapshot.done === true ? [] : [snapshot.value])];
      const messages =
        snapshot.done !== true && isMessagesSnapshot(snapshot.value) ? snapshot.value.messages : [];
      const restored = mergeAGUIMessages(createConversationHistory({ id: threadId }), messages);
      attached = (async function* () {
        yield* opened;
        yield* events;
      })();
      return restored;
    },
    async history(threadId, signal) {
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
        throw new Error('The Bureau answered with messages this page cannot read.');
      }
      return mergeAGUIMessages(createConversationHistory({ id: threadId }), snapshot.messages);
    },
    detach() {
      detached = true;
    },
    holdAnswer,
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
