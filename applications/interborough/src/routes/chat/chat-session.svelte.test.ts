/**
 * One chat session's state over stubbed Bureau requests: what a follow-up sends, what an attach
 * restores, and which approvals the conversation is waiting on.
 */
import { afterEach, describe, expect, test } from 'bun:test';

import { waitUntil } from '@lostgradient/testing/wait-until';
import type { Fetcher } from '../../lib/bureau-client.ts';
import { installFetchImplementation } from '../../lib/live-source/fetch.test-support.ts';
import { ChatSessionState } from './chat-session.svelte.ts';

/** The text of a request's JSON body. */
function bodyText(init: RequestInit | undefined): string {
  if (typeof init?.body !== 'string') throw new Error('The request had no JSON body.');
  return init.body;
}

const THREAD = 'thread-1';
const sse = (events: readonly unknown[]) =>
  new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });

const started = { type: 'RUN_STARTED', threadId: THREAD, runId: 'run-1' };
const finished = {
  type: 'RUN_FINISHED',
  threadId: THREAD,
  runId: 'run-1',
  outcome: { type: 'success' },
};

let restore: (() => void) | undefined;
let sessions: ChatSessionState[] = [];
afterEach(() => {
  for (const session of sessions) session.dispose();
  sessions = [];
  restore?.();
  restore = undefined;
});

function open(fetchAgUi: Fetcher): ChatSessionState {
  const session = new ChatSessionState({
    sessionId: THREAD,
    agentName: () => 'assistant',
    fetch: fetchAgUi,
  });
  sessions.push(session);
  return session;
}

async function until(condition: () => boolean): Promise<void> {
  await waitUntil(condition, { message: 'until' });
}

describe('a message', () => {
  test('is answered by the agent, and the run’s end leaves the conversation not streaming', async () => {
    const session = open(async () =>
      sse([
        started,
        { type: 'TEXT_MESSAGE_START', messageId: 'reply', role: 'assistant' },
        { type: 'TEXT_MESSAGE_CONTENT', messageId: 'reply', delta: 'Hello.' },
        { type: 'TEXT_MESSAGE_END', messageId: 'reply' },
        finished,
      ]),
    );

    await session.controller.adapter.sendMessage({ role: 'user', content: 'Hi' }, []);

    const texts = session.conversation.ids.map((id) => session.conversation.messages[id]?.content);
    expect(texts).toEqual(['Hi', 'Hello.']);
    expect(session.streaming).toBe(false);
    expect(session.failure).toBeUndefined();
  });

  test('that fails leaves the reason for a person to read, and the row failed', async () => {
    const session = open(async () =>
      sse([{ type: 'RUN_ERROR', message: 'The thread is busy.', code: 'THREAD_BUSY' }]),
    );

    await session.controller.adapter
      .sendMessage({ role: 'user', content: 'Hi' }, [])
      .catch(() => undefined);

    expect(session.failure).toBe('The thread is busy.');
  });
});

describe('a follow-up', () => {
  test('goes to the Bureau under the id of its own row, as text, while the run is going', async () => {
    const calls: Array<{
      method: string;
      params: { contextId: string; input: { id: string; payload: string } };
    }> = [];
    restore = installFetchImplementation(async (_input, init) => {
      calls.push(JSON.parse(bodyText(init)));
      return Response.json({
        jsonrpc: '2.0',
        id: 1,
        result: { outcome: 'admitted', receipt: { id: 'row', state: 'accepted' } },
      });
    });
    let finish: (() => void) | undefined;
    const open$ = new ReadableStream<Uint8Array>({
      start(controller) {
        const encode = (event: unknown) =>
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
        encode(started);
        finish = () => {
          encode(finished);
          controller.close();
        };
      },
    });
    const session = open(
      async () => new Response(open$, { headers: { 'content-type': 'text/event-stream' } }),
    );
    const turn = session.controller.adapter.sendMessage({ role: 'user', content: 'Start' }, []);
    await until(() => session.streaming);

    await session.controller.adapter.sendRunInput?.(THREAD, { role: 'user', content: 'More' }, []);

    const followUpId = session.conversation.ids.find(
      (id) => session.conversation.messages[id]?.content === 'More',
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('bureau.contexts.input');
    expect(calls[0]?.params).toEqual({
      contextId: THREAD,
      input: { id: followUpId!, payload: 'More' },
    });
    finish?.();
    await turn;
  });

  test('sends the text of a message made of parts', async () => {
    const calls: Array<{ params: { input: { payload: string } } }> = [];
    restore = installFetchImplementation(async (_input, init) => {
      calls.push(JSON.parse(bodyText(init)));
      return Response.json({
        jsonrpc: '2.0',
        id: 1,
        result: { outcome: 'admitted', receipt: { id: 'row', state: 'accepted' } },
      });
    });
    let finish: (() => void) | undefined;
    const open$ = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(started)}\n\n`));
        finish = () => {
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(finished)}\n\n`));
          controller.close();
        };
      },
    });
    const session = open(
      async () => new Response(open$, { headers: { 'content-type': 'text/event-stream' } }),
    );
    const turn = session.controller.adapter.sendMessage({ role: 'user', content: 'Start' }, []);
    await until(() => session.streaming);

    await session.controller.adapter.sendRunInput?.(
      THREAD,
      {
        role: 'user',
        content: [
          { type: 'text', text: 'One' },
          { type: 'text', text: 'Two' },
        ],
      },
      [],
    );

    expect(calls[0]?.params.input.payload).toBe('One\nTwo');
    finish?.();
    await turn;
  });
});

describe('an attach', () => {
  const snapshot = {
    type: 'MESSAGES_SNAPSHOT',
    messages: [{ id: 'user-1', role: 'user', content: 'Start the work' }],
  };

  test('restores the thread and then carries the run to its end', async () => {
    const session = open(async () =>
      sse([
        started,
        snapshot,
        { type: 'TEXT_MESSAGE_START', messageId: 'reply', role: 'assistant' },
        { type: 'TEXT_MESSAGE_CONTENT', messageId: 'reply', delta: 'Done.' },
        { type: 'TEXT_MESSAGE_END', messageId: 'reply' },
        finished,
      ]),
    );

    await session.attach();
    await until(() => !session.streaming && session.conversation.ids.length === 2);

    const texts = session.conversation.ids.map((id) => session.conversation.messages[id]?.content);
    expect(texts).toEqual(['Start the work', 'Done.']);
    expect(session.attaching).toBe(false);
  });

  const messages = [
    { id: 'u1', role: 'user', content: 'An earlier question' },
    { id: 'a1', role: 'assistant', content: 'An earlier answer.' },
  ];

  /** The mount for a thread with no run going: nothing to attach to, and its messages to read. */
  const settledThread =
    (answer: () => Response): Fetcher =>
    async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      return url.endsWith('/messages')
        ? answer()
        : sse([{ type: 'RUN_ERROR', message: 'none', code: 'RUN_NOT_FOUND' }]);
    };

  test('restores a finished session’s whole transcript when no run is going', async () => {
    const session = open(settledThread(() => Response.json({ threadId: THREAD, messages })));

    await session.attach();

    const texts = session.conversation.ids.map((id) => session.conversation.messages[id]?.content);
    expect(texts).toEqual(['An earlier question', 'An earlier answer.']);
    expect(session.streaming).toBe(false);
    expect(session.attaching).toBe(false);
  });

  test('leaves an empty conversation for a thread the Bureau has no record of', async () => {
    const session = open(settledThread(() => Response.json({}, { status: 404 })));

    await session.attach();

    expect(session.conversation.ids).toEqual([]);
  });

  test('keeps a row typed while the transcript was being read, behind the rows it restores', async () => {
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = open(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!url.endsWith('/messages')) {
        return sse([{ type: 'RUN_ERROR', message: 'none', code: 'RUN_NOT_FOUND' }]);
      }
      await held;
      return Response.json({ threadId: THREAD, messages });
    });

    const attaching = slow.attach();
    // A row appears on screen while the Bureau is still being asked.
    slow.conversation = {
      ...slow.conversation,
      ids: ['typed'],
      messages: {
        typed: {
          id: 'typed',
          role: 'user',
          content: 'Typed meanwhile',
          position: 0,
          createdAt: '2026-10-19T00:00:00.000Z',
          metadata: {},
          hidden: false,
        },
      },
    };
    release?.();
    await attaching;

    const texts = slow.conversation.ids.map((id) => slow.conversation.messages[id]?.content);
    expect(texts).toEqual(['An earlier question', 'An earlier answer.', 'Typed meanwhile']);
  });

  test('tells the page when a run it started begins', async () => {
    let begun = 0;
    const session = new ChatSessionState({
      sessionId: THREAD,
      agentName: () => 'assistant',
      fetch: async () => sse([started, finished]),
      onRunStarted: () => {
        begun += 1;
      },
    });
    sessions.push(session);

    await session.controller.adapter.sendMessage({ role: 'user', content: 'Hi' }, []);

    expect(begun).toBe(1);
  });
});

describe('the approvals the conversation waits on', () => {
  test('are none for a conversation with no parked tool call', () => {
    const session = open(async () => sse([]));

    expect(session.approvals).toEqual([]);
  });
});

/** A fetch whose run stream starts and then waits, recording every request it is asked for. */
function runThatWaits(): { fetch: Fetcher; requests: string[]; finish: () => void } {
  const requests: string[] = [];
  let close: (() => void) | undefined;
  const fetchStub: Fetcher = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    requests.push(`${init?.method ?? 'GET'} ${url}`);
    if (!url.includes('/agents/')) return sse([{ type: 'RUN_ERROR', message: 'gone', code: 'X' }]);
    const open = new ReadableStream<Uint8Array>({
      start(controller) {
        const encode = (event: unknown) =>
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
        encode({
          ...started,
          metadata: { '@lostgradient/bureau': { runId: 'native-1', sessionId: THREAD } },
        });
        close = () => {
          encode(finished);
          controller.close();
        };
        init?.signal?.addEventListener('abort', () => controller.error(new Error('aborted')));
      },
    });
    return new Response(open, { headers: { 'content-type': 'text/event-stream' } });
  };
  return { fetch: fetchStub, requests, finish: () => close?.() };
}

/** A session over `run`, and a promise for the moment its run has begun and is being read. */
function openOver(run: { fetch: Fetcher }) {
  let begun: (() => void) | undefined;
  const running = new Promise<void>((resolve) => {
    begun = resolve;
  });
  const session = new ChatSessionState({
    sessionId: THREAD,
    agentName: () => 'assistant',
    fetch: run.fetch,
    onRunStarted: () => begun?.(),
  });
  sessions.push(session);
  return { session, running };
}

describe('leaving the session', () => {
  test('leaves the run going, and only a stop cancels it', async () => {
    const run = runThatWaits();
    const { session, running } = openOver(run);
    const turn = session.controller.adapter
      .sendMessage({ role: 'user', content: 'Start' }, [])
      .catch(() => undefined);
    await running;

    session.dispose();
    await turn;

    expect(run.requests.filter((entry) => entry.includes('/cancel'))).toEqual([]);
  });

  test('a stop cancels the run', async () => {
    const run = runThatWaits();
    const { session, running } = openOver(run);
    const turn = session.controller.adapter
      .sendMessage({ role: 'user', content: 'Start' }, [])
      .catch(() => undefined);
    await running;

    await session.controller.stop();
    await turn;

    expect(run.requests.some((entry) => entry.includes('/cancel'))).toBe(true);
  });
});

describe('a run that waits on a person’s answer', () => {
  const wait = {
    id: 'human-wait:native-1:environment:0',
    reason: 'human-wait',
    message: 'Which environment should the release go to?',
  };

  test('shows the question, and the next message answers it and not a new run', async () => {
    const bodies: Array<{ messages: unknown[]; resume?: unknown }> = [];
    const session = open(async (_input, init) => {
      bodies.push(JSON.parse(bodyText(init)));
      return bodies.length === 1
        ? sse([started, { ...finished, outcome: { type: 'interrupt', interrupts: [wait] } }])
        : sse([
            { ...started, runId: 'run-2' },
            { ...finished, runId: 'run-2' },
          ]);
    });
    await session.controller.adapter.sendMessage({ role: 'user', content: 'Ship it' }, []);

    expect(session.humanRequests).toEqual([{ interruptId: wait.id, message: wait.message }]);
    await session.controller.adapter.sendMessage({ role: 'user', content: 'staging' }, []);

    expect(bodies[1]?.messages).toEqual([]);
    expect(bodies[1]?.resume).toEqual([
      {
        interruptId: wait.id,
        status: 'resolved',
        payload: { decision: 'approve', answer: 'staging' },
      },
    ]);
    expect(session.humanRequests).toEqual([]);
    expect(session.failure).toBeUndefined();
  });
});

describe('an attach that is still opening', () => {
  test('holds a message until it is done, so the message goes to the run the attach joins', async () => {
    const requests: string[] = [];
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const session = open(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      requests.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.includes('/threads/') && url.endsWith('/run')) {
        await held;
        return sse([{ type: 'RUN_ERROR', message: 'none', code: 'RUN_NOT_FOUND' }]);
      }
      if (url.endsWith('/messages')) return Response.json({ threadId: THREAD, messages: [] });
      return sse([started, finished]);
    });

    const attaching = session.attach();
    const sent = session.adapter.sendMessage({ role: 'user', content: 'Hello' }, []);
    for (let turn = 0; turn < 5; turn += 1) await Bun.sleep(0);

    expect(requests.some((entry) => entry.startsWith('POST'))).toBe(false);
    release?.();
    await attaching;
    await sent;
    expect(requests.some((entry) => entry.startsWith('POST'))).toBe(true);
  });
});

describe('a failed attach', () => {
  test('is the session’s failure, not an unhandled rejection', async () => {
    const session = open(async () => {
      throw new TypeError('Failed to fetch');
    });

    await session.attach();

    expect(session.failure).toContain('Failed to fetch');
    expect(session.attaching).toBe(false);
  });
});

describe('the failure a person is told of', () => {
  const fail = () => sse([{ type: 'RUN_ERROR', message: 'The thread is busy.', code: 'X' }]);

  test('is cleared when a later turn goes through', async () => {
    let healthy = false;
    const session = open(async () => (healthy ? sse([started, finished]) : fail()));
    await session.adapter.sendMessage({ role: 'user', content: 'Hi' }, []).catch(() => undefined);
    expect(session.failure).toBe('The thread is busy.');

    healthy = true;
    await session.adapter.sendMessage({ role: 'user', content: 'Again' }, []);

    expect(session.failure).toBeUndefined();
  });

  test('is shown again when the same thing fails again after it was dismissed', async () => {
    const session = open(async () => fail());
    await session.adapter.sendMessage({ role: 'user', content: 'Hi' }, []).catch(() => undefined);

    session.dismissFailure();
    expect(session.failure).toBeUndefined();
    await session.adapter
      .sendMessage({ role: 'user', content: 'Again' }, [])
      .catch(() => undefined);

    expect(session.failure).toBe('The thread is busy.');
  });
});

/** A fetch over the mount that answers each route as `answers` says, and records what it was asked. */
function mountOver(answers: {
  start: Array<() => Response>;
  attach?: Array<() => Response>;
  history?: () => Response;
}) {
  const requests: string[] = [];
  const bodies: Array<{ messages: unknown[]; resume?: Array<{ interruptId: string }> }> = [];
  const fetchStub: Fetcher = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    requests.push(`${init?.method ?? 'GET'} ${url}`);
    if (url.endsWith('/messages')) {
      return answers.history?.() ?? Response.json({ threadId: THREAD, messages: [] });
    }
    if (url.includes('/threads/') && url.endsWith('/run')) {
      return (
        answers.attach?.shift()?.() ??
        sse([{ type: 'RUN_ERROR', message: 'none', code: 'RUN_NOT_FOUND' }])
      );
    }
    bodies.push(JSON.parse(bodyText(init)));
    const answer = answers.start.shift();
    return answer === undefined ? new Response('', { status: 404 }) : answer();
  };
  return { fetch: fetchStub, requests, bodies };
}

const refusalOf =
  (code: string, message = 'No.') =>
  () =>
    sse([{ type: 'RUN_ERROR', message, code }]);
const parkedOn =
  (...interrupts: unknown[]) =>
  () =>
    sse([
      started,
      { type: 'MESSAGES_SNAPSHOT', messages: [] },
      { ...finished, outcome: { type: 'interrupt', interrupts } },
    ]);
const toolCall = [
  { type: 'TOOL_CALL_START', toolCallId: 'call-refund', toolCallName: 'issue-refund' },
  { type: 'TOOL_CALL_ARGS', toolCallId: 'call-refund', delta: '{}' },
  { type: 'TOOL_CALL_END', toolCallId: 'call-refund' },
  {
    type: 'TOOL_CALL_RESULT',
    messageId: 'result-1',
    toolCallId: 'call-refund',
    content: 'requires approval',
    role: 'tool',
  },
];
const approval = {
  id: 'approval:native-1:call-refund',
  reason: 'tool-approval',
  toolCallId: 'call-refund',
  message: 'Refund order-1001?',
};
const environment = {
  id: 'human-wait:native-1:environment:0',
  reason: 'human-wait',
  message: 'Which environment?',
};
const region = {
  id: 'human-wait:native-1:region:0',
  reason: 'human-wait',
  message: 'Which region?',
};
const second =
  (events: readonly unknown[] = []) =>
  () =>
    sse([{ ...started, runId: 'run-2' }, ...events, { ...finished, runId: 'run-2' }]);

describe('a run that waits on several questions', () => {
  function sessionWaitingOn(...interrupts: unknown[]) {
    const mounted = mountOver({
      start: [
        () => sse([started, { ...finished, outcome: { type: 'interrupt', interrupts } }]),
        second(),
      ],
    });
    return { mounted, session: open(mounted.fetch) };
  }

  test('holds each answer typed, shows the next question, and sends one resume for all of them', async () => {
    const { mounted, session } = sessionWaitingOn(environment, region);
    await session.controller.adapter.sendMessage({ role: 'user', content: 'Ship it' }, []);
    expect(session.humanRequests.map((request) => request.interruptId)).toEqual([
      environment.id,
      region.id,
    ]);

    await session.adapter.sendMessage({ role: 'user', content: 'staging' }, []);

    // The first answer is a row in the transcript, and nothing was sent for it.
    expect(mounted.bodies).toHaveLength(1);
    expect(session.humanRequests.map((request) => request.interruptId)).toEqual([region.id]);
    const typed = () =>
      session.conversation.ids
        .map((id) => session.conversation.messages[id]?.content)
        .filter((content) => content === 'staging' || content === 'eu');
    expect(typed()).toEqual(['staging']);

    await session.adapter.sendMessage({ role: 'user', content: 'eu' }, []);

    expect(mounted.bodies).toHaveLength(2);
    expect(mounted.bodies[1]?.messages).toEqual([]);
    expect(mounted.bodies[1]?.resume?.map((entry) => entry.interruptId)).toEqual([
      environment.id,
      region.id,
    ]);
    expect(session.humanRequests).toEqual([]);
    expect(session.failure).toBeUndefined();
  });
});

describe('a run that waits on a question and an approval', () => {
  const parked =
    (...interrupts: unknown[]) =>
    () =>
      sse([started, ...toolCall, { ...finished, outcome: { type: 'interrupt', interrupts } }]);

  test('holds the answer typed while the approval waits, and one resume carries both once it is decided', async () => {
    const mounted = mountOver({ start: [parked(environment, approval), second()] });
    const session = open(mounted.fetch);
    await session.controller.adapter.sendMessage({ role: 'user', content: 'Ship it' }, []);
    expect(session.approvals).toHaveLength(1);

    await session.adapter.sendMessage({ role: 'user', content: 'staging' }, []);
    expect(session.failure).toBeUndefined();
    expect(mounted.bodies).toHaveLength(1);
    expect(session.humanRequests).toEqual([]);

    await session.controller.adapter.resolveToolApproval?.('call-refund', {
      decision: 'approve',
      remember: false,
    });

    expect(mounted.bodies).toHaveLength(2);
    expect(mounted.bodies[1]?.resume?.map((entry) => entry.interruptId)).toEqual([
      environment.id,
      approval.id,
    ]);
    expect(session.failure).toBeUndefined();
  });

  test('holds the decision until the question is answered, and the answer then sends both', async () => {
    const mounted = mountOver({ start: [parked(environment, approval), second()] });
    const session = open(mounted.fetch);
    await session.controller.adapter.sendMessage({ role: 'user', content: 'Ship it' }, []);

    await session.controller.adapter.resolveToolApproval?.('call-refund', {
      decision: 'approve',
      remember: false,
    });
    expect(mounted.bodies).toHaveLength(1);
    expect(session.streaming).toBe(false);
    expect(session.failure).toBeUndefined();
    expect(session.humanRequests.map((request) => request.interruptId)).toEqual([environment.id]);

    await session.adapter.sendMessage({ role: 'user', content: 'staging' }, []);

    expect(mounted.bodies).toHaveLength(2);
    expect(mounted.bodies[1]?.resume?.map((entry) => entry.interruptId)).toEqual([
      environment.id,
      approval.id,
    ]);
  });
});

describe('a resume the mount refused', () => {
  const parked =
    (...interrupts: unknown[]) =>
    () =>
      sse([started, ...toolCall, { ...finished, outcome: { type: 'interrupt', interrupts } }]);

  /** A session whose run stopped on an approval, and the decision on it, over what the mount answers next. */
  async function approvedWith(
    answers: Parameters<typeof mountOver>[0]['start'],
    attach: Array<() => Response>,
  ) {
    const mounted = mountOver({ start: [parked(approval), ...answers], attach });
    const session = open(mounted.fetch);
    await session.controller.adapter.sendMessage({ role: 'user', content: 'Refund it' }, []);
    await session.controller.adapter
      .resolveToolApproval?.('call-refund', { decision: 'approve', remember: false })
      .catch(() => undefined);
    // The refusal is answered by reading the thread again, and a message waits for that.
    await until(
      () =>
        mounted.requests.some((entry) => entry.includes('/threads/')) &&
        !session.attaching &&
        !session.streaming,
    );
    return { mounted, session };
  }

  test('for a busy thread shows no failure, keeps the decision, and the next send applies it', async () => {
    const { mounted, session } = await approvedWith(
      [refusalOf('THREAD_BUSY', 'Thread has a run in progress'), second(), second()],
      [parkedOn(approval)],
    );

    expect(session.failure).toBeUndefined();
    await session.adapter.sendMessage({ role: 'user', content: 'Go on' }, []);

    // The decision is sent again first, and the message after it as a start of its own.
    expect(mounted.bodies).toHaveLength(4);
    expect(mounted.bodies[2]?.resume).toEqual(mounted.bodies[1]?.resume);
    expect(mounted.bodies[3]?.resume).toBeUndefined();
    expect(session.failure).toBeUndefined();
  });

  test('that failed after the approvals were applied tells the person, keeps no decision, and the next send is a plain message', async () => {
    const { mounted, session } = await approvedWith(
      [
        refusalOf('RUN_FAILED', 'The approval was applied, but its outcome was not written'),
        second(),
      ],
      [],
    );

    expect(session.failure).toBe('The approval was applied, but its outcome was not written');
    await session.adapter.sendMessage({ role: 'user', content: 'Continue' }, []);

    expect(mounted.bodies[2]?.resume).toBeUndefined();
    expect(mounted.bodies[2]?.messages.length).toBeGreaterThan(0);
  });

  test('that failed while an attempt is still applying it shows no failure and keeps the decision', async () => {
    const { mounted, session } = await approvedWith(
      [
        refusalOf(
          'RUN_FAILED',
          'An earlier attempt at this resume is still being applied; try again shortly',
        ),
        second(),
        second(),
      ],
      [parkedOn(approval)],
    );

    expect(session.failure).toBeUndefined();
    await session.adapter.sendMessage({ role: 'user', content: 'Go on' }, []);

    expect(mounted.bodies[2]?.resume).toEqual(mounted.bodies[1]?.resume);
  });

  test('that left an interrupt unanswered shows the failure and surfaces the question the page lacked', async () => {
    const { session } = await approvedWith(
      [
        refusalOf(
          'INTERRUPTS_UNADDRESSED',
          `The resume leaves interrupts unanswered: ${environment.id}`,
        ),
      ],
      [parkedOn(approval, environment)],
    );
    await until(() => session.humanRequests.length > 0);

    expect(session.failure).toContain('interrupts unanswered');
    expect(session.humanRequests).toEqual([
      { interruptId: environment.id, message: environment.message },
    ]);
  });
});

describe('a stop before the run’s first event', () => {
  /** A mount that has admitted the start and not yet answered it, until the test lets it. */
  function heldMount(first: unknown) {
    const requests: string[] = [];
    const signals: Array<AbortSignal | null | undefined> = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchStub: Fetcher = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      requests.push(`${init?.method ?? 'GET'} ${url}`);
      if (!url.includes('/agents/')) {
        return url.includes('/runs/')
          ? sse([{ type: 'RUN_ERROR', message: 'over', code: 'RUN_NOT_FOUND' }])
          : sse([{ type: 'RUN_ERROR', message: 'none', code: 'RUN_NOT_FOUND' }]);
      }
      signals.push(init?.signal);
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          init?.signal?.addEventListener('abort', () => controller.error(new Error('aborted')));
          await held;
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(first)}\n\n`));
          if ((first as { type: string }).type === 'RUN_ERROR') controller.close();
        },
      });
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    };
    return { fetch: fetchStub, requests, signals, release };
  }

  const named = {
    ...started,
    metadata: { '@lostgradient/bureau': { runId: 'native-1', sessionId: THREAD } },
  };

  test('keeps the turn going until the first event, then cancels the run it names, with no failure shown', async () => {
    const mounted = heldMount(named);
    const session = open(mounted.fetch);
    const turn = session.adapter
      .sendMessage({ role: 'user', content: 'Start' }, [])
      .catch(() => undefined);
    await until(() => mounted.signals.length === 1);

    const stopped = session.controller.stop();
    await Bun.sleep(10);

    // The request was not aborted, and the page still holds the turn: nothing can be sent yet.
    expect(mounted.signals[0]?.aborted).toBe(false);
    expect(session.streaming).toBe(true);
    expect(mounted.requests.some((entry) => entry.includes('/cancel'))).toBe(false);

    mounted.release();
    await stopped;
    await turn;

    expect(mounted.requests.filter((entry) => entry.includes('/cancel'))).toEqual([
      'POST /bureau/ag-ui/runs/native-1/cancel',
    ]);
    expect(session.streaming).toBe(false);
    expect(session.failure).toBeUndefined();
  });

  test('cancels nothing when the first event is a refusal, and the page can send again', async () => {
    const mounted = heldMount({ type: 'RUN_ERROR', message: 'busy', code: 'THREAD_BUSY' });
    const session = open(mounted.fetch);
    const turn = session.adapter
      .sendMessage({ role: 'user', content: 'Start' }, [])
      .catch(() => undefined);
    await until(() => mounted.signals.length === 1);

    const stopped = session.controller.stop();
    mounted.release();
    await stopped;
    await turn;

    expect(mounted.requests.some((entry) => entry.includes('/cancel'))).toBe(false);
    expect(session.streaming).toBe(false);
    expect(session.failure).toBeUndefined();
  });

  test('cancels nothing when the response fails with no event, and leaves the page usable', async () => {
    let calls = 0;
    const requests: string[] = [];
    const session = open(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      requests.push(`${init?.method ?? 'GET'} ${url}`);
      if (!url.includes('/agents/')) {
        return sse([{ type: 'RUN_ERROR', message: 'none', code: 'RUN_NOT_FOUND' }]);
      }
      calls += 1;
      if (calls === 1) throw new TypeError('Failed to fetch');
      return sse([started, finished]);
    });
    const turn = session.adapter
      .sendMessage({ role: 'user', content: 'Start' }, [])
      .catch(() => undefined);
    const stopped = session.controller.stop();
    await stopped;
    await turn;

    expect(requests.some((entry) => entry.includes('/cancel'))).toBe(false);
    expect(session.streaming).toBe(false);

    await session.adapter.sendMessage({ role: 'user', content: 'Again' }, []);

    expect(calls).toBe(2);
    expect(session.streaming).toBe(false);
  });
});
