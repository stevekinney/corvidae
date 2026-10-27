/**
 * What the transcript holds, and what the agent is sent, when answers to a run's questions are held,
 * refused, and applied (COR-1590). The stub mount answers the way the Bureau's does
 * (`ag-ui-resume.ts`): a resume that continues a parked run streams the thread as a snapshot, whose
 * rows include the answer rows the run appends, under `<runId>:signal:<name>:<n>`, in the form
 * `renderSignalContinuation` writes. The page then shows each answer once, as it was typed, and
 * sends the agent none of them a second time.
 */
import {
  RESUME_ATTEMPT_FAILED_MESSAGES,
  RESUME_ATTEMPT_STILL_GOING_MESSAGES,
  RESUME_ROUND_CHANGED_MESSAGE,
} from '@lostgradient/bureau';
import { afterEach, describe, expect, test } from 'bun:test';

import { CHAT_COPY } from '../../app/copy.ts';

import { waitUntil } from '@lostgradient/testing/wait-until';
import type { Fetcher } from '../../lib/bureau-client.ts';
import { withTypedAnswers } from './answer-rows.ts';
import { ChatSessionState } from './chat-session.svelte.ts';

const THREAD = 'thread-1';
const NATIVE = 'native-1';
const meta = { '@lostgradient/bureau': { runId: NATIVE, sessionId: THREAD } };
const sse = (events: readonly unknown[]) =>
  new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });

const environment = {
  id: `human-wait:${NATIVE}:environment:0`,
  reason: 'human-wait',
  message: 'Which environment?',
};
const region = {
  id: `human-wait:${NATIVE}:region:0`,
  reason: 'human-wait',
  message: 'Which region?',
};

type Body = {
  runId: string;
  messages: Array<{ id: string; role: string; content: unknown }>;
  resume?: Array<{ interruptId: string }>;
};

let sessions: ChatSessionState[] = [];
afterEach(() => {
  for (const session of sessions) session.dispose();
  sessions = [];
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

/** What the page shows as the person's rows: the conversation as `chat-conversation.svelte` lays it out. */
function userRows(session: ChatSessionState): string[] {
  const shown = withTypedAnswers(session.conversation);
  return shown.ids
    .map((id) => shown.messages[id])
    .filter((message) => message?.role === 'user' && !message.hidden)
    .map((message) => (typeof message?.content === 'string' ? message.content : '<parts>'));
}

/** The opening start: the run asks, and parks on `interrupts`. */
const parkedStart = (interrupts: unknown[]) => () =>
  sse([
    { type: 'RUN_STARTED', threadId: THREAD, runId: 'run-a', metadata: meta },
    { type: 'TEXT_MESSAGE_START', messageId: `${NATIVE}:step:0`, role: 'assistant' },
    { type: 'TEXT_MESSAGE_CONTENT', messageId: `${NATIVE}:step:0`, delta: 'Asking.' },
    { type: 'TEXT_MESSAGE_END', messageId: `${NATIVE}:step:0` },
    {
      type: 'RUN_FINISHED',
      threadId: THREAD,
      runId: 'run-a',
      outcome: { type: 'interrupt', interrupts },
      metadata: meta,
    },
  ]);

/** The success of a resume that continued the parked run: the thread's snapshot with the run's answer rows, then a reply. */
function continuedResume(opener: () => { id: string; content: unknown }, answers: string[][]) {
  return (body: Body) =>
    sse([
      { type: 'RUN_STARTED', threadId: THREAD, runId: body.runId, metadata: meta },
      {
        type: 'MESSAGES_SNAPSHOT',
        messages: [
          { id: opener().id, role: 'user', content: opener().content },
          { id: `${NATIVE}:step:0`, role: 'assistant', content: 'Asking.' },
          ...answers.map(([signal, text]) => ({
            id: `${NATIVE}:signal:${signal}:0`,
            role: 'user',
            content: `[signal:${signal}] ${JSON.stringify(text)}`,
          })),
        ],
      },
      { type: 'TEXT_MESSAGE_START', messageId: `${NATIVE}:step:1`, role: 'assistant' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: `${NATIVE}:step:1`, delta: 'Done.' },
      { type: 'TEXT_MESSAGE_END', messageId: `${NATIVE}:step:1` },
      {
        type: 'RUN_FINISHED',
        threadId: THREAD,
        runId: body.runId,
        outcome: { type: 'success' },
        metadata: meta,
      },
    ]);
}

const plainSuccess = (body: Body) =>
  sse([
    { type: 'RUN_STARTED', threadId: THREAD, runId: body.runId, metadata: meta },
    {
      type: 'RUN_FINISHED',
      threadId: THREAD,
      runId: body.runId,
      outcome: { type: 'success' },
      metadata: meta,
    },
  ]);

const refusal = (code: string, message: string) => () =>
  sse([{ type: 'RUN_ERROR', message, code }]);

const BUSY = refusal('THREAD_BUSY', 'Thread has a run in progress');

function mount(starts: Array<(body: Body) => Response>, attaches: Array<() => Response> = []) {
  const bodies: Body[] = [];
  const requests: string[] = [];
  const fetchStub: Fetcher = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    requests.push(`${init?.method ?? 'GET'} ${url}`);
    if (url.endsWith('/messages')) return Response.json({ threadId: THREAD, messages: [] });
    if (url.includes('/threads/') && url.endsWith('/run')) {
      return (
        attaches.shift()?.() ?? sse([{ type: 'RUN_ERROR', message: 'none', code: 'RUN_NOT_FOUND' }])
      );
    }
    if (url.includes('/runs/')) {
      return sse([{ type: 'RUN_ERROR', message: 'over', code: 'RUN_NOT_FOUND' }]);
    }
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Body;
    bodies.push(body);
    const answer = starts.shift();
    return answer === undefined ? new Response('', { status: 404 }) : answer(body);
  };
  return { fetch: fetchStub, bodies, requests };
}

/** The attach a re-read makes of a thread whose run is still parked on `interrupts`. */
const stillParkedOn =
  (...interrupts: unknown[]) =>
  () =>
    sse([
      { type: 'RUN_STARTED', threadId: THREAD, runId: 'attach', metadata: meta },
      { type: 'MESSAGES_SNAPSHOT', messages: [] },
      {
        type: 'RUN_FINISHED',
        threadId: THREAD,
        runId: 'attach',
        outcome: { type: 'interrupt', interrupts },
      },
    ]);

/** The rows of a plain start the mount would append: the person's rows whose ids the thread lacks. */
function appendedBy(body: Body | undefined, held: readonly string[]): string[] {
  if (body === undefined || body.resume !== undefined) return [];
  return body.messages
    .filter((message) => message.role === 'user' && !held.includes(message.id))
    .map((message) => String(message.content));
}

/** Waits for the read a refused resume is answered with. */
async function afterReread(session: ChatSessionState, requests: readonly string[]): Promise<void> {
  await until(
    () =>
      requests.some((entry) => entry.includes('/threads/')) &&
      !session.attaching &&
      !session.streaming,
  );
}

describe('answers that a resume carried', () => {
  test('are shown once each when two questions are answered and one resume succeeds, and none is sent again', async () => {
    const mounted = mount([
      parkedStart([environment, region]),
      continuedResume(
        () => mounted.bodies[0]!.messages.at(-1)!,
        [
          ['environment', 'staging'],
          ['region', 'eu'],
        ],
      ),
      plainSuccess,
    ]);
    const session = open(mounted.fetch);
    await session.adapter.sendMessage({ role: 'user', content: 'Ship it' }, []);
    await session.adapter.sendMessage({ role: 'user', content: 'staging' }, []);
    await session.adapter.sendMessage({ role: 'user', content: 'eu' }, []);

    expect(mounted.bodies).toHaveLength(2);
    expect(userRows(session)).toEqual(['Ship it', 'staging', 'eu']);

    await session.adapter.sendMessage({ role: 'user', content: 'Next please' }, []);

    const thread = [
      mounted.bodies[0]!.messages.at(-1)!.id,
      `${NATIVE}:step:0`,
      `${NATIVE}:signal:environment:0`,
      `${NATIVE}:signal:region:0`,
      `${NATIVE}:step:1`,
    ];
    expect(appendedBy(mounted.bodies[2], thread)).toEqual(['Next please']);
  });

  test('are shown once when the resume was refused as busy, a new message was typed, and the resume then succeeded', async () => {
    const mounted = mount(
      [
        parkedStart([environment]),
        BUSY,
        continuedResume(() => mounted.bodies[0]!.messages.at(-1)!, [['environment', 'staging']]),
        plainSuccess,
        plainSuccess,
      ],
      [stillParkedOn(environment)],
    );
    const session = open(mounted.fetch);
    await session.adapter.sendMessage({ role: 'user', content: 'Ship it' }, []);
    await session.adapter
      .sendMessage({ role: 'user', content: 'staging' }, [])
      .catch(() => undefined);
    await afterReread(session, mounted.requests);
    expect(session.failure).toBeUndefined();

    await session.adapter.sendMessage({ role: 'user', content: 'Go on' }, []);

    expect(userRows(session)).toEqual(['Ship it', 'staging', 'Go on']);
    await session.adapter.sendMessage({ role: 'user', content: 'Next please' }, []);
    const thread = [
      mounted.bodies[0]!.messages.at(-1)!.id,
      `${NATIVE}:step:0`,
      `${NATIVE}:signal:environment:0`,
      `${NATIVE}:step:1`,
    ];
    // Each of the three is sent once: the answer in the resume, the message as a start, and the next.
    expect(mounted.bodies[2]?.resume?.map((entry) => entry.interruptId)).toEqual([environment.id]);
    expect(
      appendedBy(mounted.bodies[4], [...thread, mounted.bodies[3]!.messages.at(-1)!.id]),
    ).toEqual(['Next please']);
  });
});

describe('a message typed after a refusal that kept what the person had answered', () => {
  test('reaches the agent once, as a start of its own, after the resume has applied', async () => {
    const mounted = mount(
      [
        parkedStart([environment]),
        BUSY,
        continuedResume(() => mounted.bodies[0]!.messages.at(-1)!, [['environment', 'staging']]),
        plainSuccess,
      ],
      [stillParkedOn(environment)],
    );
    const session = open(mounted.fetch);
    await session.adapter.sendMessage({ role: 'user', content: 'Ship it' }, []);
    await session.adapter
      .sendMessage({ role: 'user', content: 'staging' }, [])
      .catch(() => undefined);
    await afterReread(session, mounted.requests);

    await session.adapter.sendMessage({ role: 'user', content: 'Go on' }, []);

    expect(mounted.bodies.map((body) => (body.resume === undefined ? 'start' : 'resume'))).toEqual([
      'start',
      'resume',
      'resume',
      'start',
    ]);
    expect(mounted.bodies[3]?.messages.map((message) => message.content)).toContain('Go on');
    // The answer is the resume's, and is no row of the start that follows.
    expect(mounted.bodies[3]?.messages.map((message) => message.content)).not.toContain('staging');
  });

  test('is not sent, and says why, while the resume is still refused, and the answer is still owed', async () => {
    const mounted = mount(
      [parkedStart([environment]), BUSY, BUSY],
      [stillParkedOn(environment), stillParkedOn(environment)],
    );
    const session = open(mounted.fetch);
    await session.adapter.sendMessage({ role: 'user', content: 'Ship it' }, []);
    await session.adapter
      .sendMessage({ role: 'user', content: 'staging' }, [])
      .catch(() => undefined);
    await afterReread(session, mounted.requests);

    const sent = session.adapter.sendMessage({ role: 'user', content: 'Go on' }, []).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(await sent).toEqual(new Error(CHAT_COPY.answersNotApplied));
    expect(mounted.bodies).toHaveLength(3);
    expect(userRows(session)).toEqual(['Ship it', 'staging']);
  });
});

describe('a RUN_FAILED refusal of a resume', () => {
  const parked = (message: string) => {
    const mounted = mount(
      [parkedStart([environment]), refusal('RUN_FAILED', message)],
      [stillParkedOn(environment)],
    );
    return { mounted, session: open(mounted.fetch) };
  };

  test.each(Object.values(RESUME_ATTEMPT_FAILED_MESSAGES))(
    'is told when an attempt failed, though the run is still parked: %s',
    async (message) => {
      const { mounted, session } = parked(message);
      await session.adapter.sendMessage({ role: 'user', content: 'Ship it' }, []);
      await session.adapter
        .sendMessage({ role: 'user', content: 'staging' }, [])
        .catch(() => undefined);
      await afterReread(session, mounted.requests);

      expect(session.failure).toBe(message);
    },
  );

  test('is told that an approval changed while it was read and was not decided (COR-1714)', async () => {
    const mounted = mount(
      [parkedStart([environment]), refusal('REVIEW_ROUND_CHANGED', RESUME_ROUND_CHANGED_MESSAGE)],
      [stillParkedOn(environment)],
    );
    const session = open(mounted.fetch);
    await session.adapter.sendMessage({ role: 'user', content: 'Ship it' }, []);
    await session.adapter
      .sendMessage({ role: 'user', content: 'staging' }, [])
      .catch(() => undefined);
    await afterReread(session, mounted.requests);

    expect(session.failure).toBe(RESUME_ROUND_CHANGED_MESSAGE);
    expect(session.failure).toContain('changed while you read it');
    expect(session.failure).toContain('not decided');
  });

  test.each(Object.values(RESUME_ATTEMPT_STILL_GOING_MESSAGES))(
    'is not told while an earlier attempt is still applying it: %s',
    async (message) => {
      const { mounted, session } = parked(message);
      await session.adapter.sendMessage({ role: 'user', content: 'Ship it' }, []);
      await session.adapter
        .sendMessage({ role: 'user', content: 'staging' }, [])
        .catch(() => undefined);
      await afterReread(session, mounted.requests);

      expect(session.failure).toBeUndefined();
    },
  );
});

describe('a question answered somewhere else', () => {
  test('is no longer open after the thread is read again, so the next message is a new turn and not its answer', async () => {
    const mounted = mount([parkedStart([environment]), plainSuccess]);
    const session = open(mounted.fetch);
    await session.adapter.sendMessage({ role: 'user', content: 'Ship it' }, []);
    expect(session.humanRequests.map((request) => request.interruptId)).toEqual([environment.id]);

    // `/reviews` answered it: the thread has nothing going or waiting.
    expect(await session.refresh()).toBe(true);

    expect(session.humanRequests).toEqual([]);
    await session.adapter.sendMessage({ role: 'user', content: 'Something else' }, []);
    // A start with the person's message, and no resume that answers an interrupt the Bureau settled.
    expect(mounted.bodies).toHaveLength(2);
    expect(mounted.bodies[1]?.resume).toBeUndefined();
    expect(appendedBy(mounted.bodies[1], [])).toContain('Something else');
    expect(session.failure).toBeUndefined();
  });

  test('is still open after the thread is read again when the run still waits on it', async () => {
    const mounted = mount([parkedStart([environment])], [stillParkedOn(environment)]);
    const session = open(mounted.fetch);
    await session.adapter.sendMessage({ role: 'user', content: 'Ship it' }, []);

    expect(await session.refresh()).toBe(true);
    await until(() => !session.attaching && !session.streaming);

    expect(session.humanRequests.map((request) => request.interruptId)).toEqual([environment.id]);
  });

  test('is not reported as read when the thread could not be read again', async () => {
    const mounted = mount([parkedStart([environment])]);
    const session = open(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      // The run's own stream is gone with the network; the transcript is still readable.
      if (url.includes('/threads/') && url.endsWith('/run')) throw new TypeError('Failed to fetch');
      return mounted.fetch(input, init);
    });
    await session.adapter.sendMessage({ role: 'user', content: 'Ship it' }, []);

    expect(await session.refresh()).toBe(false);
  });
});
