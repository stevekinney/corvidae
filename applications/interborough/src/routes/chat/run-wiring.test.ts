/**
 * The wiring between the chat session controller and the Bureau's AG-UI mount: what each turn sends,
 * how an approval is carried, and what an attach restores. The mount is a stub `fetch` that
 * answers with the events a real one writes (`packages/bureau/src/http/ag-ui-mount.ts`).
 */
import type { ChatSessionRequest, ChatStreamEvent, ConversationHistory } from '@lostgradient/chat';
import {
  appendMessages,
  appendToolCall,
  appendToolResult,
  appendUserMessage,
  createConversationHistory,
} from '@lostgradient/chat';
import { describe, expect, test } from 'bun:test';

import type { Fetcher } from '../../lib/bureau-client.ts';
import { AG_UI_PATH, createChatRunWiring, openingTurn } from './run-wiring.ts';

const THREAD = 'thread-1';

type Sent = { url: string; method: string; body: unknown };

type SentInput = {
  runId: string;
  messages: Array<{ id: string; content?: string }>;
  resume?: Array<{ interruptId: string; status: string; payload?: unknown }>;
};

/** The `RunAgentInput` a request carried. */
function inputOf(entry: Sent | undefined): SentInput {
  if (entry === undefined || typeof entry.body !== 'object' || entry.body === null) {
    throw new Error('The request carried no run input.');
  }
  return entry.body as SentInput;
}

/** The events of one run, written as the mount writes them. */
function stream(events: readonly unknown[]): Response {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

const started = (runId = 'run-1') => ({
  type: 'RUN_STARTED',
  threadId: THREAD,
  runId,
  metadata: { '@lostgradient/bureau': { runId: 'native-1', sessionId: THREAD, durable: false } },
});
const finished = (outcome: unknown = { type: 'success' }, runId = 'run-1') => ({
  type: 'RUN_FINISHED',
  threadId: THREAD,
  runId,
  outcome,
});
const text = (messageId: string, delta: string) => [
  { type: 'TEXT_MESSAGE_START', messageId, role: 'assistant' },
  { type: 'TEXT_MESSAGE_CONTENT', messageId, delta },
  { type: 'TEXT_MESSAGE_END', messageId },
];

const INTERRUPT = {
  id: 'approval:native-1:call-refund',
  reason: 'tool-approval',
  toolCallId: 'call-refund',
  message: 'Refund order-1001?',
};

/** A fetch that records each request and answers with the next queued response. */
function mount(answers: Array<Response | ((init?: RequestInit) => Response)>) {
  const sent: Sent[] = [];
  const fetchStub: Fetcher = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    sent.push({
      url,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    const answer = answers.shift();
    if (answer === undefined) return new Response('', { status: 404 });
    return typeof answer === 'function' ? answer(init) : answer;
  };
  return { sent, fetch: fetchStub };
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

async function frames(
  wiring: ReturnType<typeof createChatRunWiring>,
  conversation: ConversationHistory,
  signal?: AbortSignal,
): Promise<ChatStreamEvent[]> {
  return Array.fromAsync(
    (await wiring.transport(request(conversation, signal))) as AsyncIterable<ChatStreamEvent>,
  );
}

function wiringOver(
  answers: Array<Response | (() => Response)>,
  conversation: () => ConversationHistory,
) {
  const stubbed = mount(answers);
  return {
    sent: stubbed.sent,
    wiring: createChatRunWiring({
      agentName: () => 'assistant',
      fetch: stubbed.fetch,
      conversation,
    }),
  };
}

const empty = () => createConversationHistory({ id: THREAD });

describe('a start', () => {
  test('posts the thread to the agent’s run route as a RunAgentInput, and maps the reply', async () => {
    const conversation = appendUserMessage(empty(), 'Hello');
    const { wiring, sent } = wiringOver(
      [stream([started(), ...text('reply-1', 'Hi there.'), finished()])],
      () => conversation,
    );

    const result = await frames(wiring, conversation);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe(`${AG_UI_PATH}/agents/assistant/run`);
    expect(sent[0]?.method).toBe('POST');
    expect(sent[0]?.body).toMatchObject({
      threadId: THREAD,
      tools: [],
      messages: [{ id: conversation.ids[0], role: 'user', content: 'Hello' }],
    });
    expect(result.at(-1)).toMatchObject({ type: 'run.completed', content: 'Hi there.' });
  });

  test('sends a fresh run identifier each time, and names the agent as the session’s agent', async () => {
    const conversation = appendUserMessage(empty(), 'Hello');
    const { wiring, sent } = wiringOver(
      [stream([started(), finished()]), stream([started(), finished()])],
      () => conversation,
    );

    await frames(wiring, conversation);
    await frames(wiring, conversation);

    const [first, second] = sent.map((entry) => inputOf(entry).runId);
    expect(first).not.toBe(second);
  });

  test('leaves a hidden row out of what it sends', async () => {
    const conversation = appendMessages(appendUserMessage(empty(), 'Hello'), {
      role: 'user',
      content: '',
      hidden: true,
    });
    const { wiring, sent } = wiringOver([stream([started(), finished()])], () => conversation);

    await frames(wiring, conversation);

    expect(inputOf(sent[0]).messages).toHaveLength(1);
  });

  test('a stream that is refused at the door fails the turn with the mount’s code', async () => {
    const conversation = appendUserMessage(empty(), 'Hello');
    const { wiring } = wiringOver(
      [stream([{ type: 'RUN_ERROR', message: 'busy', code: 'THREAD_BUSY' }])],
      () => conversation,
    );

    const result = await frames(wiring, conversation);

    expect(result.at(-1)).toMatchObject({
      type: 'run.error',
      error: { message: 'busy', backendCode: 'THREAD_BUSY' },
    });
  });
});

describe('a run that stops on a tool approval', () => {
  const withCall = () => {
    let conversation = appendUserMessage(empty(), 'Refund it');
    conversation = appendToolCall(conversation, {
      id: 'call-refund',
      name: 'issue-refund',
      arguments: { cents: 4200 },
    });
    return conversation;
  };
  const toolEvents = [
    { type: 'TOOL_CALL_START', toolCallId: 'call-refund', toolCallName: 'issue-refund' },
    { type: 'TOOL_CALL_ARGS', toolCallId: 'call-refund', delta: '{"cents":4200}' },
    { type: 'TOOL_CALL_END', toolCallId: 'call-refund' },
    {
      type: 'TOOL_CALL_RESULT',
      messageId: 'result-1',
      toolCallId: 'call-refund',
      content: 'requires approval',
      role: 'tool',
    },
  ];

  test('parks the call on its approval in the history the run ends with', async () => {
    const conversation = appendUserMessage(empty(), 'Refund it');
    const { wiring } = wiringOver(
      [
        stream([
          started(),
          ...toolEvents,
          finished({ type: 'interrupt', interrupts: [INTERRUPT] }),
        ]),
      ],
      () => conversation,
    );

    const result = await frames(wiring, conversation);

    const terminal = result.at(-1);
    if (terminal?.type !== 'run.completed') throw new Error('Expected a completed run.');
    const parked = Object.values(terminal.conversation.messages).find(
      (message) => message.toolResult?.callId === 'call-refund',
    );
    expect(parked?.toolResult).toMatchObject({
      outcome: 'action_required',
      action: { type: 'approval', idempotencyKey: INTERRUPT.id, message: INTERRUPT.message },
    });
  });

  test('sends the user’s decision as a resume that carries the opening turn, never a follow-up', async () => {
    const opener = appendUserMessage(empty(), 'Refund it');
    const withFollowUp = appendMessages(opener, {
      role: 'user',
      content: 'And another thing',
      metadata: { _followUp: true },
    });
    const { wiring, sent } = wiringOver(
      [
        stream([
          started(),
          ...toolEvents,
          finished({ type: 'interrupt', interrupts: [INTERRUPT] }),
        ]),
        stream([started('run-2'), ...text('reply-2', 'Refunded.'), finished(undefined, 'run-2')]),
      ],
      () => withFollowUp,
    );
    await frames(wiring, opener);

    const result = await wiring.resolveToolApproval('call-refund', {
      decision: 'approve',
      remember: false,
    });
    await frames(wiring, withFollowUp);

    expect(result).toMatchObject({ callId: 'call-refund', outcome: 'success' });
    const continuation = inputOf(sent[1]);
    expect(continuation.messages.map((message) => message.id)).toEqual([opener.ids[0]!]);
    expect(continuation.resume).toEqual([
      { interruptId: INTERRUPT.id, status: 'resolved', payload: { decision: 'approve' } },
    ]);
  });

  test('a denial is a deny with the reason, and the call’s result is an error', async () => {
    const conversation = appendUserMessage(empty(), 'Refund it');
    const { wiring, sent } = wiringOver(
      [
        stream([
          started(),
          ...toolEvents,
          finished({ type: 'interrupt', interrupts: [INTERRUPT] }),
        ]),
        stream([started('run-2'), finished(undefined, 'run-2')]),
      ],
      () => conversation,
    );
    await frames(wiring, conversation);

    const result = await wiring.resolveToolApproval('call-refund', {
      decision: 'deny',
      reason: 'Too much',
      remember: false,
    });
    await frames(wiring, conversation);

    expect(result).toMatchObject({ outcome: 'error', error: { message: 'Too much' } });
    expect(inputOf(sent[1]).resume).toEqual([
      {
        interruptId: INTERRUPT.id,
        status: 'resolved',
        payload: { decision: 'deny', reason: 'Too much' },
      },
    ]);
  });

  test('approving with edits sends the edited arguments', async () => {
    const conversation = appendUserMessage(empty(), 'Refund it');
    const { wiring, sent } = wiringOver(
      [
        stream([
          started(),
          ...toolEvents,
          finished({ type: 'interrupt', interrupts: [INTERRUPT] }),
        ]),
        stream([started('run-2'), finished(undefined, 'run-2')]),
      ],
      () => conversation,
    );
    await frames(wiring, conversation);

    await wiring.resolveToolApproval('call-refund', {
      decision: 'approve_with_edits',
      editedArgs: { cents: 100 },
      remember: false,
    });
    await frames(wiring, conversation);

    expect(inputOf(sent[1]).resume?.[0]?.payload).toEqual({
      decision: 'approve',
      arguments: { cents: 100 },
    });
  });

  test('refuses a decision for a call no approval is waiting on', async () => {
    const { wiring } = wiringOver([], empty);

    const failure = await wiring
      .resolveToolApproval('call-unknown', { decision: 'approve', remember: false })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(String(failure)).toContain('No approval is waiting');
  });

  test('does not show a call the conversation already holds a second time', async () => {
    const held = withCall();
    const { wiring } = wiringOver(
      [
        stream([
          started('run-2'),
          ...toolEvents,
          ...text('reply-2', 'Refunded.'),
          finished(undefined, 'run-2'),
        ]),
      ],
      () => held,
    );

    const result = await frames(wiring, held);

    expect(result.filter((frame) => frame.type === 'tool_call')).toEqual([]);
    expect(result.at(-1)).toMatchObject({ type: 'run.completed', content: 'Refunded.' });
  });

  test('a result the conversation holds for the call is not rewritten by the run that follows', async () => {
    const held = appendToolResult(withCall(), {
      callId: 'call-refund',
      outcome: 'success',
      content: { decision: 'approved' },
    });
    const { wiring } = wiringOver(
      [stream([started('run-2'), ...toolEvents, finished(undefined, 'run-2')])],
      () => held,
    );

    const result = await frames(wiring, held);

    expect(result.filter((frame) => frame.type === 'tool_result')).toEqual([]);
  });
});

describe('the turn that opened a run', () => {
  test('is the last user row that is not a follow-up', () => {
    let conversation = appendUserMessage(empty(), 'First');
    conversation = appendUserMessage(conversation, 'Second');
    conversation = appendMessages(conversation, {
      role: 'user',
      content: 'Late',
      metadata: { _followUp: true },
    });

    expect(openingTurn(conversation)?.content).toBe('Second');
  });

  test('is nothing in a conversation with no user row', () => {
    expect(openingTurn(empty())).toBeUndefined();
  });
});

describe('an attach', () => {
  const snapshot = {
    type: 'MESSAGES_SNAPSHOT',
    messages: [{ id: 'user-1', role: 'user', content: 'Start the work' }],
  };

  test('opens the thread’s run stream and hands back the snapshot it opens with', async () => {
    const { wiring, sent } = wiringOver(
      [stream([started(), snapshot, ...text('reply-1', 'Done.'), finished()])],
      empty,
    );

    const restored = await wiring.attach(THREAD);

    expect(sent[0]).toMatchObject({ url: `${AG_UI_PATH}/threads/${THREAD}/run`, method: 'GET' });
    expect(restored?.ids.map((id) => restored.messages[id]?.content)).toEqual(['Start the work']);
  });

  test('is read by the next turn, which ends with the thread and the reply', async () => {
    const { wiring, sent } = wiringOver(
      [stream([started(), snapshot, ...text('reply-1', 'Done.'), finished()])],
      empty,
    );
    await wiring.attach(THREAD);

    const result = await frames(wiring, empty());

    expect(sent).toHaveLength(1);
    const terminal = result.at(-1);
    if (terminal?.type !== 'run.completed') throw new Error('Expected a completed run.');
    expect(terminal.conversation.ids).toHaveLength(2);
    expect(terminal.content).toBe('Done.');
  });

  test('opens nothing for a thread with no run to attach to', async () => {
    const { wiring } = wiringOver(
      [stream([{ type: 'RUN_ERROR', message: 'none', code: 'RUN_NOT_FOUND' }])],
      empty,
    );

    expect(await wiring.attach(THREAD)).toBeUndefined();
  });

  test('can be dropped unread, and the next turn starts a run of its own', async () => {
    const conversation = appendUserMessage(empty(), 'Hello');
    const { wiring, sent } = wiringOver(
      [stream([started(), snapshot, finished()]), stream([started(), finished()])],
      () => conversation,
    );
    await wiring.attach(THREAD);

    await wiring.discardAttach();
    await frames(wiring, conversation);

    expect(sent[1]?.method).toBe('POST');
  });
});

/** A response whose stream carries the start of a run and then waits, and fails when the request is aborted. */
function waiting(init?: RequestInit): Response {
  const open = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(started())}\n\n`));
      init?.signal?.addEventListener('abort', () => controller.error(new Error('aborted')));
    },
  });
  return new Response(open, { headers: { 'content-type': 'text/event-stream' } });
}

describe('a stop', () => {
  test('cancels the Bureau’s run by its own identifier and waits for the run to end', async () => {
    const conversation = appendUserMessage(empty(), 'Hello');
    const controller = new AbortController();
    const { wiring, sent } = wiringOver(
      [
        waiting,
        new Response('{"runId":"native-1","status":"aborting"}'),
        stream([{ type: 'RUN_ERROR', message: 'over', code: 'RUN_NOT_FOUND' }]),
      ],
      () => conversation,
    );
    const turn = frames(wiring, conversation, controller.signal).then(
      () => undefined,
      (error: unknown) => error,
    );
    // The turn is reading the run once its request is out and its first event has arrived.
    await expectEventually(() => sent.length === 1);
    await Bun.sleep(10);

    controller.abort();
    await turn;

    expect(sent.map((entry) => `${entry.method} ${entry.url}`)).toEqual([
      `POST ${AG_UI_PATH}/agents/assistant/run`,
      `POST ${AG_UI_PATH}/runs/native-1/cancel`,
      `GET ${AG_UI_PATH}/runs/native-1`,
    ]);
  });

  test('leaves the Bureau’s run going when the page detaches, as it does when its chat is left', async () => {
    const conversation = appendUserMessage(empty(), 'Hello');
    const controller = new AbortController();
    const { wiring, sent } = wiringOver([waiting], () => conversation);
    const turn = frames(wiring, conversation, controller.signal).then(
      () => undefined,
      (error: unknown) => error,
    );
    await expectEventually(() => sent.length === 1);
    await Bun.sleep(10);

    wiring.detach();
    controller.abort();
    await turn;

    expect(sent.map((entry) => `${entry.method} ${entry.url}`)).toEqual([
      `POST ${AG_UI_PATH}/agents/assistant/run`,
    ]);
  });
});

async function expectEventually(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !condition(); attempt += 1) await Bun.sleep(5);
  expect(condition()).toBe(true);
}

describe('the thread’s history', () => {
  const messages = [
    { id: 'u1', role: 'user', content: 'Hello' },
    { id: 'a1', role: 'assistant', content: 'Hi there.' },
  ];
  const json = (body: unknown, status = 200) => Response.json(body, { status });

  test('is the conversation the mount returns, in order, under the thread’s id', async () => {
    const { wiring, sent } = wiringOver([json({ threadId: THREAD, messages })], empty);

    const history = await wiring.history(THREAD);

    expect(sent[0]).toMatchObject({
      url: `${AG_UI_PATH}/threads/${THREAD}/messages`,
      method: 'GET',
    });
    expect(history?.id).toBe(THREAD);
    expect(history?.ids.map((id) => history.messages[id]?.content)).toEqual(['Hello', 'Hi there.']);
  });

  test('is nothing for a thread the mount does not know or will not show', async () => {
    const { wiring } = wiringOver([json({ code: 'NotFound' }, 404)], empty);

    expect(await wiring.history(THREAD)).toBeUndefined();
  });

  test('is an error for any other answer', async () => {
    const { wiring } = wiringOver([json({}, 500)], empty);

    const failure = await wiring.history(THREAD).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toMatchObject({ status: 500 });
  });

  test('is an error for messages this page cannot read', async () => {
    const { wiring } = wiringOver(
      [json({ threadId: THREAD, messages: [{ role: 'nobody' }] })],
      empty,
    );

    const failure = await wiring.history(THREAD).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(String(failure)).toContain('cannot read');
  });
});

describe('a run’s beginning', () => {
  test('is told to the page when a run it started begins', async () => {
    const conversation = appendUserMessage(empty(), 'Hello');
    let begun = 0;
    const stubbed = mount([stream([started(), finished()])]);
    const wiring = createChatRunWiring({
      agentName: () => 'assistant',
      fetch: stubbed.fetch,
      conversation: () => conversation,
      onRunStarted: () => {
        begun += 1;
      },
    });

    await frames(wiring, conversation);

    expect(begun).toBe(1);
  });

  test('is not told for a run the page attached to, which began elsewhere', async () => {
    let begun = 0;
    const stubbed = mount([
      stream([started(), { type: 'MESSAGES_SNAPSHOT', messages: [] }, finished()]),
    ]);
    const wiring = createChatRunWiring({
      agentName: () => 'assistant',
      fetch: stubbed.fetch,
      conversation: empty,
      onRunStarted: () => {
        begun += 1;
      },
    });
    await wiring.attach(THREAD);

    await frames(wiring, empty());

    expect(begun).toBe(0);
  });
});

describe('several approvals', () => {
  const SECOND = {
    id: 'approval:native-1:call-void',
    reason: 'tool-approval',
    toolCallId: 'call-void',
    message: 'Void invoice-7?',
  };
  const calls = ['call-refund', 'call-void'].flatMap((toolCallId) => [
    { type: 'TOOL_CALL_START', toolCallId, toolCallName: 'issue-refund' },
    { type: 'TOOL_CALL_ARGS', toolCallId, delta: '{}' },
    { type: 'TOOL_CALL_END', toolCallId },
  ]);

  test('are all answered by the one resume the run continues with', async () => {
    const conversation = appendUserMessage(empty(), 'Refund it and void the invoice');
    const { wiring, sent } = wiringOver(
      [
        stream([
          started(),
          ...calls,
          finished({ type: 'interrupt', interrupts: [INTERRUPT, SECOND] }),
        ]),
        stream([started('run-2'), finished(undefined, 'run-2')]),
      ],
      () => conversation,
    );
    await frames(wiring, conversation);

    await wiring.resolveToolApproval('call-refund', { decision: 'approve', remember: false });
    await wiring.resolveToolApproval('call-void', {
      decision: 'deny',
      reason: 'Not this one',
      remember: false,
    });
    await frames(wiring, conversation);

    expect(inputOf(sent[1]).resume).toEqual([
      { interruptId: INTERRUPT.id, status: 'resolved', payload: { decision: 'approve' } },
      {
        interruptId: SECOND.id,
        status: 'resolved',
        payload: { decision: 'deny', reason: 'Not this one' },
      },
    ]);
  });

  test('a second decision on the same approval replaces the first', async () => {
    const conversation = appendUserMessage(empty(), 'Refund it');
    const { wiring, sent } = wiringOver(
      [
        stream([started(), ...calls, finished({ type: 'interrupt', interrupts: [INTERRUPT] })]),
        stream([started('run-2'), finished(undefined, 'run-2')]),
      ],
      () => conversation,
    );
    await frames(wiring, conversation);

    await wiring.resolveToolApproval('call-refund', { decision: 'deny', remember: false });
    await wiring.resolveToolApproval('call-refund', { decision: 'approve', remember: false });
    await frames(wiring, conversation);

    expect(inputOf(sent[1]).resume).toEqual([
      { interruptId: INTERRUPT.id, status: 'resolved', payload: { decision: 'approve' } },
    ]);
  });
});

describe('a request the mount has not acknowledged', () => {
  const unreachable = (): Response => {
    throw new TypeError('Failed to fetch');
  };
  const interruptedRun = () =>
    stream([started(), finished({ type: 'interrupt', interrupts: [INTERRUPT] })]);

  /** A wiring whose first run stopped on an approval the user has approved. */
  async function approved(answers: Array<Response | ((init?: RequestInit) => Response)>) {
    const conversation = appendUserMessage(empty(), 'Refund it');
    const over = wiringOver([interruptedRun(), ...answers], () => conversation);
    await frames(over.wiring, conversation);
    await over.wiring.resolveToolApproval('call-refund', { decision: 'approve', remember: false });
    return { ...over, conversation };
  }

  test('keeps the user’s decision, so a retry still answers the approval', async () => {
    const { wiring, sent, conversation } = await approved([
      unreachable,
      stream([started('run-2'), finished(undefined, 'run-2')]),
    ]);

    await frames(wiring, conversation).catch(() => undefined);
    await frames(wiring, conversation);

    expect(inputOf(sent[1]).resume).toHaveLength(1);
    expect(inputOf(sent[2]).resume).toEqual(inputOf(sent[1]).resume);
  });

  test('is sent once the mount has answered it, and the decision is not sent again', async () => {
    const { wiring, sent, conversation } = await approved([
      stream([started('run-2'), finished(undefined, 'run-2')]),
      stream([started('run-3'), finished(undefined, 'run-3')]),
    ]);

    await frames(wiring, conversation);
    await frames(wiring, conversation);

    expect(inputOf(sent[1]).resume).toHaveLength(1);
    expect(inputOf(sent[2]).resume).toBeUndefined();
  });

  test('keeps its run identifier, so a start the mount did admit is joined and not refused as busy', async () => {
    const conversation = appendUserMessage(empty(), 'Hello');
    const { wiring, sent } = wiringOver(
      [unreachable, stream([started(), finished()])],
      () => conversation,
    );

    await frames(wiring, conversation).catch(() => undefined);
    await frames(wiring, conversation);

    expect(inputOf(sent[1]).runId).toBe(inputOf(sent[0]).runId);
  });

  test('gets a new run identifier when the retry asks for something else', async () => {
    const first = appendUserMessage(empty(), 'Hello');
    const second = appendUserMessage(first, 'Hello again');
    let conversation = first;
    const { wiring, sent } = wiringOver(
      [unreachable, stream([started(), finished()])],
      () => conversation,
    );

    await frames(wiring, first).catch(() => undefined);
    conversation = second;
    await frames(wiring, second);

    expect(inputOf(sent[1]).runId).not.toBe(inputOf(sent[0]).runId);
  });

  test('is acknowledged by a refusal too, so the next request is a new run', async () => {
    const conversation = appendUserMessage(empty(), 'Hello');
    const { wiring, sent } = wiringOver(
      [
        stream([{ type: 'RUN_ERROR', message: 'busy', code: 'THREAD_BUSY' }]),
        stream([started(), finished()]),
      ],
      () => conversation,
    );

    await frames(wiring, conversation);
    await frames(wiring, conversation);

    expect(inputOf(sent[1]).runId).not.toBe(inputOf(sent[0]).runId);
  });
});

describe('a run that waits on a person’s answer', () => {
  const WAIT = {
    id: 'human-wait:native-1:environment:0',
    reason: 'human-wait',
    message: 'Which environment should the release go to?',
  };
  const waitingRun = () => stream([started(), finished({ type: 'interrupt', interrupts: [WAIT] })]);

  function over(answers: Array<Response | ((init?: RequestInit) => Response)>) {
    const requests: Array<ReadonlyArray<{ interruptId: string; message: string }>> = [];
    const stubbed = mount(answers);
    let conversation = appendUserMessage(empty(), 'Ship it');
    const wiring = createChatRunWiring({
      agentName: () => 'request-human-input',
      fetch: stubbed.fetch,
      conversation: () => conversation,
      onHumanRequests: (waits) => requests.push(waits),
    });
    return {
      wiring,
      sent: stubbed.sent,
      requests,
      conversation: () => conversation,
      type(textOfAnswer: string) {
        conversation = appendUserMessage(conversation, textOfAnswer);
        return conversation;
      },
    };
  }

  test('tells the page the question, and that it is gone once the run goes on', async () => {
    const run = over([waitingRun(), stream([started('run-2'), finished(undefined, 'run-2')])]);

    await frames(run.wiring, run.conversation());
    expect(run.requests.at(-1)).toEqual([{ interruptId: WAIT.id, message: WAIT.message }]);

    await frames(run.wiring, run.type('staging'));
    expect(run.requests.at(-1)).toEqual([]);
  });

  test('sends the next message as the answer to it, a resume and not a new run', async () => {
    const run = over([waitingRun(), stream([started('run-2'), finished(undefined, 'run-2')])]);
    await frames(run.wiring, run.conversation());

    await frames(run.wiring, run.type('staging'));

    expect(run.sent).toHaveLength(2);
    expect(run.sent[1]?.url).toBe(`${AG_UI_PATH}/agents/request-human-input/run`);
    expect(inputOf(run.sent[1]).messages).toEqual([]);
    expect(inputOf(run.sent[1]).resume).toEqual([
      {
        interruptId: WAIT.id,
        status: 'resolved',
        payload: { decision: 'approve', answer: 'staging' },
      },
    ]);
  });

  test('answers it again with the same text when the request failed before the mount answered', async () => {
    const run = over([
      waitingRun(),
      () => {
        throw new TypeError('Failed to fetch');
      },
      stream([started('run-2'), finished(undefined, 'run-2')]),
    ]);
    await frames(run.wiring, run.conversation());
    const typed = run.type('staging');

    await frames(run.wiring, typed).catch(() => undefined);
    await frames(run.wiring, typed);

    expect(inputOf(run.sent[2]).resume).toEqual(inputOf(run.sent[1]).resume);
    expect(inputOf(run.sent[2]).runId).toBe(inputOf(run.sent[1]).runId);
  });

  test('leaves the answer out of the history the run ends with, which holds it as the run rows it', async () => {
    const answerRow = {
      id: 'native-1:signal:environment:0',
      role: 'user',
      content: '[signal:environment] "staging"',
    };
    const run: ReturnType<typeof over> = over([
      waitingRun(),
      () =>
        stream([
          started('run-2'),
          {
            type: 'MESSAGES_SNAPSHOT',
            messages: [
              { id: run.conversation().ids[0]!, role: 'user', content: 'Ship it' },
              answerRow,
            ],
          },
          ...text('reply-2', 'Thanks.'),
          finished(undefined, 'run-2'),
        ]),
    ]);
    await frames(run.wiring, run.conversation());
    const typed = run.type('staging');

    const result = await frames(run.wiring, typed);

    const terminal = result.at(-1);
    if (terminal?.type !== 'run.completed') throw new Error('Expected a completed run.');
    const texts = terminal.conversation.ids.map(
      (id) => terminal.conversation.messages[id]?.content,
    );
    // The typed text is not a second row beside the one the run appended for the answer.
    expect(texts).not.toContain('staging');
    expect(texts).toContain(answerRow.content);
  });

  test('is a plain start again once the run has gone on, so a later message is not an answer', async () => {
    const run = over([
      waitingRun(),
      stream([started('run-2'), finished(undefined, 'run-2')]),
      stream([started('run-3'), finished(undefined, 'run-3')]),
    ]);
    await frames(run.wiring, run.conversation());
    await frames(run.wiring, run.type('staging'));

    await frames(run.wiring, run.type('Thanks'));

    expect(inputOf(run.sent[2]).resume).toBeUndefined();
    expect(inputOf(run.sent[2]).messages.length).toBeGreaterThan(0);
  });

  test('does not offer a tool approval as a question', async () => {
    const run = over([
      stream([started(), finished({ type: 'interrupt', interrupts: [INTERRUPT] })]),
    ]);

    await frames(run.wiring, run.conversation());

    expect(run.requests.at(-1)).toEqual([]);
  });
});
