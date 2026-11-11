/**
 * The cursor an attach resumes from (COR-2293): the cursor of the last event Chat's mapper accepted
 * for the transport that is still current, never one a stopped or superseded transport only read.
 */
import type { ChatSessionRequest, ChatStreamEvent, ConversationHistory } from '@lostgradient/chat';
import { appendUserMessage, createConversationHistory } from '@lostgradient/chat';
import { describe, expect, test } from 'bun:test';

import type { Fetcher } from '../../lib/bureau-client.ts';
import { BureauClock } from '../../lib/bureau-clock.ts';
import { AG_UI_PATH, createChatRunWiring } from './run-wiring.ts';

const THREAD = 'thread-cursor';

/** An SSE response whose frames carry the given cursors, as the Bureau writes them. */
const sse = (frames: ReadonlyArray<readonly [unknown, string?]>): Response =>
  new Response(
    frames
      .map(
        ([event, id]) =>
          `${id === undefined ? '' : `id: ${id}\n`}data: ${JSON.stringify(event)}\n\n`,
      )
      .join(''),
    { headers: { 'content-type': 'text/event-stream' } },
  );

const started = {
  type: 'RUN_STARTED',
  threadId: THREAD,
  runId: 'run-1',
  metadata: { '@lostgradient/bureau': { runId: 'native-1', sessionId: THREAD, durable: false } },
};
const finished = {
  type: 'RUN_FINISHED',
  threadId: THREAD,
  runId: 'run-1',
  outcome: { type: 'success' },
};
const stepStarted = { type: 'STEP_STARTED', stepName: 'plan' };
const stepFinished = { type: 'STEP_FINISHED', stepName: 'plan' };

/** The run the agent's route answers with: a step, then the end, each with its cursor. */
const run = (): Response =>
  sse([[started], [stepStarted, 'c-plan'], [stepFinished, 'c-plan-done'], [finished, 'c-end']]);

const isType = (event: unknown, type: string): boolean =>
  typeof event === 'object' && event !== null && 'type' in event && event.type === type;

/**
 * A clock that also tells the test of each event the wiring has read and let through, at the point
 * between reading an event and handing it to Chat's mapper.
 */
class WatchingClock extends BureauClock {
  watch: (event: unknown) => void = () => undefined;

  override observe(event: unknown): void {
    super.observe(event);
    this.watch(event);
  }
}

/**
 * A mount whose agent route answers with {@link run}, and whose thread route records the cursor an
 * attach resumes from and answers that the thread has no run.
 */
function mount() {
  const attachCursors: Array<string | null> = [];
  const fetchStub: Fetcher = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === `${AG_UI_PATH}/agents/assistant/run`) return run();
    if (url === `${AG_UI_PATH}/threads/${THREAD}/run`) {
      attachCursors.push(new Headers(init?.headers).get('Last-Event-ID'));
      return sse([[{ type: 'RUN_ERROR', message: 'none', code: 'RUN_NOT_FOUND' }]]);
    }
    // A Stop's cancel and the read of the run's end: there is nothing to cancel here.
    return new Response('', { status: 404 });
  };
  return { attachCursors, fetch: fetchStub };
}

function request(conversation: ConversationHistory, signal?: AbortSignal): ChatSessionRequest {
  return {
    conversation,
    signal: signal ?? new AbortController().signal,
    turn: 1,
    attachments: [],
    submissionId: 'submission-1',
    historyToken: { conversationId: conversation.id, generation: 0, revision: 0 },
    isCurrent: () => true,
  };
}

/** Reads a turn to its end, whatever the end is: these tests read only the cursor it leaves. */
async function drain(frames: AsyncIterable<ChatStreamEvent>): Promise<void> {
  await Array.fromAsync(frames).catch(() => []);
}

describe('the cursor an attach resumes from', () => {
  test('is the terminal’s, once the run’s end has been accepted', async () => {
    const conversation = appendUserMessage(createConversationHistory({ id: THREAD }), 'Hello');
    const { attachCursors, fetch } = mount();
    const wiring = createChatRunWiring({
      agentName: () => 'assistant',
      fetch,
      conversation: () => conversation,
    });

    await drain((await wiring.transport(request(conversation))) as AsyncIterable<ChatStreamEvent>);
    await wiring.attach(THREAD);

    expect(attachCursors).toEqual(['c-end']);
  });

  test('stays before an event a Stop cut off between reading it and accepting it', async () => {
    const conversation = appendUserMessage(createConversationHistory({ id: THREAD }), 'Hello');
    const stop = new AbortController();
    const clock = new WatchingClock();
    clock.watch = (event) => {
      if (isType(event, 'STEP_FINISHED')) stop.abort();
    };
    const { attachCursors, fetch } = mount();
    const wiring = createChatRunWiring({
      agentName: () => 'assistant',
      fetch,
      conversation: () => conversation,
      clock,
    });

    await drain(
      (await wiring.transport(
        request(conversation, stop.signal),
      )) as AsyncIterable<ChatStreamEvent>,
    );
    await wiring.attach(THREAD);

    // The step's end was read and never accepted, so a resume replays it after its start.
    expect(attachCursors).toEqual(['c-plan']);
  });

  test('is not moved by a transport that a newer one superseded after reading its event', async () => {
    const conversation = appendUserMessage(createConversationHistory({ id: THREAD }), 'Hello');
    const clock = new WatchingClock();
    const { attachCursors, fetch } = mount();
    const wiring = createChatRunWiring({
      agentName: () => 'assistant',
      fetch,
      conversation: () => conversation,
      clock,
    });
    let superseded = false;
    clock.watch = (event) => {
      if (superseded || !isType(event, 'STEP_FINISHED')) return;
      superseded = true;
      // A newer turn takes over the wiring while the older one still holds an event it read. The
      // newer turn is never read, so it sends nothing.
      void wiring.transport(request(conversation));
    };

    await drain((await wiring.transport(request(conversation))) as AsyncIterable<ChatStreamEvent>);
    await wiring.attach(THREAD);

    expect(superseded).toBe(true);
    // The older transport's acceptance of the step's end came after it was superseded.
    expect(attachCursors).toEqual(['c-plan']);
  });
});
