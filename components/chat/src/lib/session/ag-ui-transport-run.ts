import {
  type Event as AGUIEvent,
  type TokenUsage as AGUITokenUsage,
  type EventType,
} from '@ag-ui/core';
import { mergeAGUIMessages, type TokenUsage } from 'conversationalist';
import type { ConversationHistory } from '../components/chat/conversation-model.ts';
import { AGUIChatTransportError } from './ag-ui-transport-error.ts';
import {
  protocolError,
  UNSTARTED_RUN_ID,
  wire,
  type MapperState,
} from './ag-ui-transport-state.ts';
import { isChatAgentRunErrorCode } from './stream-event-codec-validation.ts';
import type { ChatStreamEvent } from './stream-event-codec.ts';

export function* startRun(
  state: MapperState,
  event: Extract<AGUIEvent, { type: EventType.RUN_STARTED }>,
): Generator<ChatStreamEvent> {
  if (state.runId !== undefined) throw protocolError('RUN_STARTED arrived twice.');
  state.runId = event.runId;
  state.threadId = event.threadId;
  yield {
    type: 'run.started',
    runId: event.runId,
    threadId: event.threadId,
    ...(event.parentRunId === undefined ? {} : { parentRunId: event.parentRunId }),
    ...wire(state),
  };
}

export function* finishRun(
  state: MapperState,
  event: Extract<AGUIEvent, { type: EventType.RUN_FINISHED }>,
): Generator<ChatStreamEvent> {
  assertSameRun(state, event.runId, event.threadId, 'RUN_FINISHED');
  const open = [
    ...state.openText.keys(),
    ...state.foreignText,
    ...state.openCalls.keys(),
    ...state.openSteps.keys(),
    ...state.spans.keys(),
  ];
  if (open.length > 0)
    throw protocolError(`RUN_FINISHED arrived while ${open.join(', ')} was still open.`);
  state.finished = true;
  if (event.outcome?.type === 'cancelled') {
    yield { type: 'run.aborted', reason: 'cancelled', ...wire(state) };
    return;
  }
  yield {
    type: 'run.completed',
    conversation: assembleConversation(state),
    content: state.assistantTexts
      .map((entry) => entry.text)
      .filter((text) => text.length > 0)
      .join('\n\n'),
    usage: sumUsage(event.usage ?? []),
    finishReason: event.outcome?.type === 'interrupt' ? 'interrupt' : 'stop',
    ...wire(state),
  };
}

export function* failRun(
  state: MapperState,
  event: Extract<AGUIEvent, { type: EventType.RUN_ERROR }>,
): Generator<ChatStreamEvent> {
  const threadId = readString(event, 'threadId');
  // An error may be the backend's first word: a run that never started, refused
  // at the door. A version 3 stream still opens with `run.started`.
  if (state.runId === undefined) {
    state.runId = UNSTARTED_RUN_ID;
    state.threadId = threadId;
    yield {
      type: 'run.started',
      runId: UNSTARTED_RUN_ID,
      ...(threadId === undefined ? {} : { threadId }),
      ...wire(state),
    };
  }
  if (threadId !== undefined && state.threadId !== undefined && threadId !== state.threadId)
    throw protocolError(`RUN_ERROR named thread ${threadId}, not ${state.threadId}.`);
  state.finished = true;
  yield {
    type: 'run.error',
    error: {
      name: 'AGUIRunError',
      message: event.message,
      kind: 'generate',
      // The wire's code is a closed set, so the backend's code only becomes it
      // on an exact match; it always travels as itself too.
      code: isChatAgentRunErrorCode(event.code) ? event.code : 'UNKNOWN',
      ...(event.code === undefined ? {} : { backendCode: event.code }),
    },
    ...wire(state),
  };
}

function assertSameRun(state: MapperState, runId: string, threadId: string, type: string): void {
  if (runId !== state.runId) throw protocolError(`${type} named run ${runId}, not ${state.runId}.`);
  if (threadId !== state.threadId)
    throw protocolError(`${type} named thread ${threadId}, not ${state.threadId}.`);
}

/** A string property the schema leaves open, read without trusting its type. */
function readString(event: object, key: string): string | undefined {
  const entry = Object.entries(event).find(([name]) => name === key);
  return typeof entry?.[1] === 'string' ? entry[1] : undefined;
}

/**
 * The conversation a finished run reconciles against: the history it was asked
 * from, grown by every snapshot, plus the messages it produced, merged by id.
 */
function assembleConversation(state: MapperState): ConversationHistory {
  try {
    const produced = state.slots.flatMap((slot) =>
      slot.message === undefined ? [] : [slot.message],
    );
    return mergeAGUIMessages(state.base, produced);
  } catch (error) {
    throw new AGUIChatTransportError(
      'history',
      'The messages this run produced could not be assembled into a conversation.',
      { cause: error },
    );
  }
}

/** Adds up what a run reported. A cache counter is only present if some entry reported one. */
function sumUsage(usages: ReadonlyArray<AGUITokenUsage>): TokenUsage {
  let prompt = 0;
  let completion = 0;
  let total = 0;
  let cacheRead: number | undefined;
  let cacheCreation: number | undefined;
  for (const usage of usages) {
    const input = usage.inputTokens ?? 0;
    const output = usage.outputTokens ?? 0;
    prompt += input;
    completion += output;
    total += usage.totalTokens ?? input + output;
    if (usage.cachedInputTokens !== undefined)
      cacheRead = (cacheRead ?? 0) + usage.cachedInputTokens;
    if (usage.cacheWriteInputTokens !== undefined)
      cacheCreation = (cacheCreation ?? 0) + usage.cacheWriteInputTokens;
  }
  return {
    prompt,
    completion,
    total,
    ...(cacheRead === undefined ? {} : { cacheReadTokens: cacheRead }),
    ...(cacheCreation === undefined ? {} : { cacheCreationTokens: cacheCreation }),
  };
}

export function adoptSnapshot(state: MapperState, messages: ReadonlyArray<SnapshotMessage>): void {
  // A subagent's messages are not the thread's, and a message still streaming
  // is not finished: its closed slot will write it whole, where a snapshot of
  // it now would install a partial row that the whole one is then skipped for.
  const streaming = new Set([
    ...state.openText.keys(),
    ...[...state.reasoningMessages].filter(([, message]) => message.open).map(([id]) => id),
  ]);
  const candidates = messages.filter(
    (message) => message.subagentRunId === undefined && !streaming.has(message.id),
  );
  // A snapshot that shares nothing with a thread the client already holds is
  // not a snapshot of this thread, and merging it would add the whole history
  // a second time under other ids.
  if (state.base.ids.length > 0 && !sharesAnyRow(state.base, candidates)) return;
  try {
    // The client's rows stand: a snapshot adds the rows the client lacks and
    // cannot delete or rewrite one.
    state.base = mergeAGUIMessages(state.base, candidates);
  } catch (error) {
    throw new AGUIChatTransportError(
      'history',
      'MESSAGES_SNAPSHOT could not be merged into the conversation.',
      { cause: error },
    );
  }
}

type SnapshotMessage = Extract<
  AGUIEvent,
  { type: EventType.MESSAGES_SNAPSHOT }
>['messages'][number];

/** Whether any message is one the conversation already holds, by id or by tool call. */
function sharesAnyRow(
  base: ConversationHistory,
  messages: ReadonlyArray<SnapshotMessage>,
): boolean {
  const calls = new Set(
    Object.values(base.messages).flatMap((row) => (row.toolCall ? [row.toolCall.id] : [])),
  );
  return messages.some(
    (message) =>
      base.messages[message.id] !== undefined ||
      (message.role === 'assistant' &&
        (message.toolCalls ?? []).some((call) => calls.has(call.id))),
  );
}
