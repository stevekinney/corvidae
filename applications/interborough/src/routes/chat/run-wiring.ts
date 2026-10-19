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
 * `action_required`, which is what puts the approval in the conversation.
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
  type ChatSessionRequest,
  type ChatSessionTransport,
  type ChatStreamEvent,
  type ConversationHistory,
  type ToolResult,
} from '@lostgradient/chat';
import type { ApprovalResolution } from '@lostgradient/cinder';
import { HttpClientError } from '@lostgradient/weft';
import { agUiConversationAdapter, mergeAGUIMessages } from 'conversationalist';

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
 * The user turn that opened the run: the last user row that is not a follow-up. A follow-up row
 * can come after it, and the rows before it belong to turns that are over.
 */
export function openingTurn(
  conversation: ConversationHistory,
): ConversationHistory['messages'][string] | undefined {
  for (let index = conversation.ids.length - 1; index >= 0; index -= 1) {
    const message = conversation.messages[conversation.ids[index]!];
    if (message?.role === 'user' && !isFollowUp(message)) return message;
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

async function* parkApprovals(
  frames: AsyncIterable<ChatStreamEvent>,
  interrupts: () => readonly Interrupt[],
): AsyncGenerator<ChatStreamEvent> {
  for await (const frame of frames) {
    yield frame.type === 'run.completed'
      ? { ...frame, conversation: withApprovalRows(frame.conversation, interrupts()) }
      : frame;
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

export function createChatRunWiring(options: ChatRunWiringOptions): ChatRunWiring {
  const send = options.fetch ?? fetch;
  /** The interrupts the latest run ended on, read from its raw events. */
  let interrupts: readonly Interrupt[] = [];
  let pendingResume: ResumeEntry | undefined;
  let attached: AsyncGenerator<unknown> | undefined;

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

  async function* observe(
    events: AsyncIterable<unknown>,
    signal: AbortSignal,
    started: boolean,
  ): AsyncGenerator<unknown> {
    let nativeRunId: string | undefined;
    let held: ReadonlySet<string> | undefined;
    try {
      for await (const event of events) {
        // Read at the first event, not when the turn started: an attach restores the thread right
        // after it starts, and the calls this stream streams itself arrive after, never before.
        held ??= heldCalls(options.conversation());
        nativeRunId ??= nativeRunIdOf(event);
        if (started && isRecord(event) && event['type'] === 'RUN_STARTED') {
          options.onRunStarted?.();
        }
        const ended = interruptsOf(event);
        if (ended !== undefined) interrupts = ended;
        // A run that follows an approval shows the call it was waiting on again, for a client that
        // did not watch it run. This conversation holds the call, and holds it only once.
        if (isCallEventFor(event, held)) continue;
        yield event;
      }
    } finally {
      if (signal.aborted && nativeRunId !== undefined) await cancelRun(nativeRunId);
    }
  }

  function runInput(request: ChatSessionRequest, resume: ResumeEntry | undefined): RunAgentInput {
    const conversation = withoutHiddenRows(request.conversation);
    const opener = resume === undefined ? undefined : openingTurn(conversation);
    const base = {
      threadId: conversation.id,
      runId: `run-${crypto.randomUUID()}`,
      tools: [],
      context: [],
      state: {},
      forwardedProps: {},
    };
    if (resume === undefined) {
      return { ...base, messages: agUiConversationAdapter.export(conversation) };
    }
    return {
      ...base,
      messages:
        opener === undefined ? [] : agUiConversationAdapter.export(onlyRow(conversation, opener)),
      resume: [resume],
    };
  }

  function startEvents(request: ChatSessionRequest): AsyncGenerator<unknown> {
    const resume = pendingResume;
    pendingResume = undefined;
    const input = runInput(request, resume);
    return readEvents(() =>
      send(`${AG_UI_PATH}/agents/${encodeURIComponent(options.agentName())}/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify(input),
        signal: request.signal,
      }),
    );
  }

  const transport: ChatSessionTransport = (request) => {
    const attachedStream = attached;
    const events = attachedStream ?? startEvents(request);
    attached = undefined;
    // An attach reads a thread the page may know nothing of yet: its first rows come from the
    // snapshot, and the row the controller appended to start the turn is not one of them.
    const frames = mapAGUIEventsToChatStream(
      observe(events, request.signal, attachedStream === undefined),
      {
        conversation: withoutHiddenRows(request.conversation),
      },
    );
    return parkApprovals(frames, () => interrupts);
  };

  return {
    transport,
    async resolveToolApproval(toolCallId, resolution) {
      const interrupt = interrupts.find((entry) => entry.toolCallId === toolCallId);
      if (interrupt === undefined) {
        throw new Error('No approval is waiting for this tool call.');
      }
      pendingResume = resumeEntryFor(interrupt, resolution);
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
    async discardAttach() {
      const dropped = attached;
      attached = undefined;
      await dropped?.return(undefined);
    },
  };
}
