/**
 * What a message typed after a refused resume does (COR-1590). The wiring holds what the resume
 * owes, so the session replays it from the entries held, as a request of its own, and then sends
 * the message as a start. It does not look on screen for the row that carried the resume: a Stop
 * leaves no row marked failed, a failed follow-up is not the row that owns a decision, and a
 * question the thread surfaced is answered by the message itself. The stub mount keeps a model of
 * the thread the way the real one does: a start appends the rows the thread lacks, a resume reads
 * `resume` only and appends the run's own answer rows. What the agent received is the order of the
 * person's rows the thread gained.
 */
import { afterEach, describe, expect, test } from 'bun:test';

import { RESUME_ATTEMPT_FAILED_MESSAGES } from '@lostgradient/bureau';

import { waitUntil } from '@lostgradient/testing/wait-until';
import type { Fetcher } from '../../lib/bureau-client.ts';
import { withTypedAnswers } from './answer-rows.ts';
import { ChatSessionState } from './chat-session.svelte.ts';

const THREAD = 'thread-1';
const NATIVE = 'native-1';
const meta = { '@lostgradient/bureau': { runId: NATIVE, sessionId: THREAD } };
const encode = (event: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
const sse = (events: readonly unknown[]) =>
  new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });

const environment = {
  id: `human-wait:${NATIVE}:environment:0`,
  reason: 'human-wait',
  message: 'Which environment?',
};
const approval = {
  id: `approval:${NATIVE}:call-refund`,
  reason: 'tool-approval',
  toolCallId: 'call-refund',
  message: 'Refund order-1001?',
};
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

type Row = { id: string; role: string; content: unknown };
type Body = {
  runId: string;
  messages: Row[];
  resume?: Array<{ interruptId: string; payload?: { answer?: unknown } }>;
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

function userRows(session: ChatSessionState): string[] {
  const shown = withTypedAnswers(session.conversation);
  return shown.ids
    .map((id) => shown.messages[id])
    .filter((message) => message?.role === 'user' && !message.hidden)
    .map((message) => (typeof message?.content === 'string' ? message.content : '<parts>'));
}

/** The thread as the mount holds it. */
class Thread {
  rows: Row[] = [];
  /** What the agent received, in order. */
  delivered: string[] = [];
  append(row: Row) {
    if (this.rows.some((held) => held.id === row.id)) return;
    this.rows.push(row);
    if (row.role !== 'user') return;
    const text = String(row.content);
    const typed = /^\[signal:[^\]]+\] (.*)$/s.exec(text);
    this.delivered.push(typed === null ? text : `answer:${String(JSON.parse(typed[1] ?? '""'))}`);
  }
}

type Answer = (body: Body, thread: Thread) => Response;

const refused =
  (code: string, message: string): Answer =>
  () =>
    sse([{ type: 'RUN_ERROR', message, code }]);

/** A resume the mount takes: the run appends its answer rows and replies, and the snapshot carries them. */
const continuedResume: Answer = (body, thread) => {
  for (const entry of body.resume ?? []) {
    // Only a question's answer is a row the run appends; a decision on an approval is not.
    if (!entry.interruptId.startsWith('human-wait:')) continue;
    const signal = entry.interruptId.split(':')[2] ?? '';
    thread.append({
      id: `${NATIVE}:signal:${signal}:0`,
      role: 'user',
      content: `[signal:${signal}] ${JSON.stringify(entry.payload?.answer)}`,
    });
  }
  thread.append({
    id: `${NATIVE}:step:r${thread.rows.length}`,
    role: 'assistant',
    content: 'Done.',
  });
  return sse([
    { type: 'RUN_STARTED', threadId: THREAD, runId: body.runId, metadata: meta },
    { type: 'MESSAGES_SNAPSHOT', messages: thread.rows },
    {
      type: 'RUN_FINISHED',
      threadId: THREAD,
      runId: body.runId,
      outcome: { type: 'success' },
      metadata: meta,
    },
  ]);
};

/** A start: the mount appends the rows the thread lacks, then replies. A start with `resume` is a resume. */
const plainStart: Answer = (body, thread) => {
  if (body.resume !== undefined) return continuedResume(body, thread);
  for (const row of body.messages) thread.append(row);
  thread.append({ id: `${NATIVE}:step:p${thread.rows.length}`, role: 'assistant', content: 'Ok.' });
  return sse([
    { type: 'RUN_STARTED', threadId: THREAD, runId: body.runId, metadata: meta },
    {
      type: 'RUN_FINISHED',
      threadId: THREAD,
      runId: body.runId,
      outcome: { type: 'success' },
      metadata: meta,
    },
  ]);
};

/** The start that ends on `interrupts`, after the tool call when there is one. */
const parkedStart =
  (interrupts: unknown[], withCall = false): Answer =>
  (body, thread) => {
    for (const row of body.messages) thread.append(row);
    thread.append({ id: `${NATIVE}:step:0`, role: 'assistant', content: 'Asking.' });
    return sse([
      { type: 'RUN_STARTED', threadId: THREAD, runId: body.runId, metadata: meta },
      ...(withCall ? toolCall : []),
      {
        type: 'RUN_FINISHED',
        threadId: THREAD,
        runId: body.runId,
        outcome: { type: 'interrupt', interrupts },
        metadata: meta,
      },
    ]);
  };

const attachParkedOn =
  (interrupts: unknown[], withCall = false) =>
  (messages: Row[] = []) =>
    sse([
      { type: 'RUN_STARTED', threadId: THREAD, runId: 'attach', metadata: meta },
      { type: 'MESSAGES_SNAPSHOT', messages },
      ...(withCall ? toolCall : []),
      {
        type: 'RUN_FINISHED',
        threadId: THREAD,
        runId: 'attach',
        outcome: { type: 'interrupt', interrupts },
      },
    ]);

function mount(starts: Answer[], attaches: Array<(messages: Row[]) => Response> = []) {
  const thread = new Thread();
  const bodies: Body[] = [];
  const requests: string[] = [];
  const fetchStub: Fetcher = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    // A task read after an attach (COR-1987) is not the mount; it has nothing to say here.
    if (url.endsWith('/jsonrpc')) return new Response('', { status: 404 });
    requests.push(`${init?.method ?? 'GET'} ${url}`);
    if (url.endsWith('/messages'))
      return Response.json({ threadId: THREAD, messages: thread.rows });
    if (url.includes('/threads/') && url.endsWith('/run')) {
      return (
        attaches.shift()?.(thread.rows) ??
        sse([{ type: 'RUN_ERROR', message: 'none', code: 'RUN_NOT_FOUND' }])
      );
    }
    if (url.includes('/runs/')) {
      return sse([{ type: 'RUN_ERROR', message: 'over', code: 'RUN_NOT_FOUND' }]);
    }
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Body;
    bodies.push(body);
    return (starts.shift() ?? plainStart)(body, thread);
  };
  return { fetch: fetchStub, bodies, requests, thread };
}

const summary = (bodies: readonly Body[]) =>
  bodies.map((body) =>
    body.resume === undefined
      ? `start[${body.messages
          .filter((message) => message.role === 'user')
          .map((message) => String(message.content))
          .join('|')}]`
      : `resume[${body.resume.map((entry) => entry.interruptId.split(':')[2]).join('|')}]`,
  );

const afterReread = (session: ChatSessionState, requests: readonly string[]) =>
  until(
    () =>
      requests.some((entry) => entry.includes('/threads/')) &&
      !session.attaching &&
      !session.streaming,
  );

describe('a message typed while a refused resume is owed', () => {
  test('after a Stop before the answer’s first event, replays the answer from the held entries and sends the message after it', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const thread = new Thread();
    const bodies: Body[] = [];
    const requests: string[] = [];
    const fetchStub: Fetcher = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      // A task read after an attach (COR-1987) is not the mount; it has nothing to say here.
      if (url.endsWith('/jsonrpc')) return new Response('', { status: 404 });
      requests.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.endsWith('/messages'))
        return Response.json({ threadId: THREAD, messages: thread.rows });
      if (url.includes('/threads/') && url.endsWith('/run')) return attachParkedOn([environment])();
      if (url.includes('/runs/')) {
        return sse([{ type: 'RUN_ERROR', message: 'over', code: 'RUN_NOT_FOUND' }]);
      }
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Body;
      bodies.push(body);
      if (bodies.length === 1) return parkedStart([environment])(body, thread);
      if (bodies.length === 2) {
        // The resume is refused, but only after the person has pressed Stop.
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            await held;
            controller.enqueue(
              encode({
                type: 'RUN_ERROR',
                message: 'Thread has a run in progress',
                code: 'THREAD_BUSY',
              }),
            );
            controller.close();
          },
        });
        return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
      }
      return plainStart(body, thread);
    };
    const session = open(fetchStub);
    await session.adapter.sendMessage({ role: 'user', content: 'Ship it' }, []);
    const answering = session.adapter
      .sendMessage({ role: 'user', content: 'staging' }, [])
      .catch(() => undefined);
    await until(() => bodies.length === 2);
    const stopped = session.adapter.stopGenerating?.('x');
    release();
    await stopped;
    await answering;
    await afterReread(session, requests);
    // A stopped turn marks no row failed, so nothing on screen says a resume is owed.
    const failedRows = session.conversation.ids.filter(
      (id) => session.conversation.messages[id]?.metadata?.['_deliveryStatus'] === 'failed',
    );
    expect(failedRows).toEqual([]);

    await session.adapter.sendMessage({ role: 'user', content: 'Go on' }, []);

    expect(summary(bodies)).toEqual([
      'start[Ship it]',
      'resume[environment]',
      'resume[environment]',
      expect.stringMatching(/^start\[.*Go on\]$/) as unknown as string,
    ]);
    expect(thread.delivered).toEqual(['Ship it', 'answer:staging', 'Go on']);
    expect(userRows(session)).toEqual(['Ship it', 'staging', 'Go on']);
  });

  test('after a failed follow-up beside the row that owns a refused decision, replays the decision and does not promote the follow-up', async () => {
    let finish!: () => void;
    const thread = new Thread();
    const bodies: Body[] = [];
    const requests: string[] = [];
    const fetchStub: Fetcher = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      // A task read after an attach (COR-1987) is not the mount; it has nothing to say here.
      if (url.endsWith('/jsonrpc')) return new Response('', { status: 404 });
      requests.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.endsWith('/messages'))
        return Response.json({ threadId: THREAD, messages: thread.rows });
      if (url.includes('/threads/') && url.endsWith('/run'))
        return attachParkedOn([approval], true)(thread.rows);
      if (url.includes('/runs/')) {
        return sse([{ type: 'RUN_ERROR', message: 'over', code: 'RUN_NOT_FOUND' }]);
      }
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Body;
      bodies.push(body);
      if (bodies.length === 1) {
        for (const row of body.messages) thread.append(row);
        // The run stays open while the follow-up is sent, and ends on the approval after.
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encode({ type: 'RUN_STARTED', threadId: THREAD, runId: body.runId, metadata: meta }),
            );
            for (const event of toolCall) controller.enqueue(encode(event));
            finish = () => {
              controller.enqueue(
                encode({
                  type: 'RUN_FINISHED',
                  threadId: THREAD,
                  runId: body.runId,
                  outcome: { type: 'interrupt', interrupts: [approval] },
                  metadata: meta,
                }),
              );
              controller.close();
            };
          },
        });
        return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
      }
      if (bodies.length === 2) {
        return refused('THREAD_BUSY', 'Thread has a run in progress')(body, thread);
      }
      return plainStart(body, thread);
    };
    const session = open(fetchStub);
    const first = session.controller.adapter
      .sendMessage({ role: 'user', content: 'Refund it' }, [])
      .catch(() => undefined);
    await until(() => session.streaming && bodies.length === 1);
    // The run does not take the follow-up, so its row is marked failed beside the row it follows.
    await session.controller.adapter
      .sendRunInput?.(THREAD, { role: 'user', content: 'Also this' }, [])
      .catch(() => undefined);
    finish();
    await first;
    await session.controller.adapter
      .resolveToolApproval?.('call-refund', { decision: 'approve', remember: false })
      .catch(() => undefined);
    await afterReread(session, requests);

    await session.adapter.sendMessage({ role: 'user', content: 'Go on' }, []);

    // The decision is replayed from what is held, and is not carried by the follow-up's row.
    expect(bodies.map((body) => (body.resume === undefined ? 'start' : 'resume'))).toEqual([
      'start',
      'resume',
      'resume',
      'start',
    ]);
    expect(bodies[2]?.messages.map((message) => message.content) ?? []).not.toContain('Also this');
    expect(bodies[2]?.resume?.map((entry) => entry.interruptId)).toEqual([approval.id]);
    // The authoritative snapshot removes an unaccepted local follow-up; its text
    // was not promoted into a new request when the held decision was retried.
    const followUp = session.conversation.ids
      .map((id) => session.conversation.messages[id])
      .find((message) => message?.content === 'Also this');
    expect(followUp).toBeUndefined();
  });

  test('is the answer to a question the thread surfaced beside a decision that is kept', async () => {
    const mounted = mount(
      [
        parkedStart([approval], true),
        refused(
          'INTERRUPTS_UNADDRESSED',
          `The resume leaves interrupts unanswered: ${environment.id}`,
        ),
        continuedResume,
      ],
      [attachParkedOn([approval, environment], true)],
    );
    const session = open(mounted.fetch);
    await session.controller.adapter.sendMessage({ role: 'user', content: 'Refund it' }, []);
    await session.controller.adapter
      .resolveToolApproval?.('call-refund', { decision: 'approve', remember: false })
      .catch(() => undefined);
    await afterReread(session, mounted.requests);
    await until(() => session.humanRequests.length > 0);
    expect(session.humanRequests.map((request) => request.interruptId)).toEqual([environment.id]);

    const sent = await session.adapter.sendMessage({ role: 'user', content: 'staging' }, []).then(
      () => 'sent',
      (error: unknown) => String(error),
    );

    // One resume carries the decision and the typed answer, and the message is not refused.
    expect(sent).toBe('sent');
    expect(mounted.bodies).toHaveLength(3);
    expect(mounted.bodies[2]?.resume?.map((entry) => entry.interruptId)).toEqual([
      approval.id,
      environment.id,
    ]);
    expect(session.humanRequests).toEqual([]);
  });
});

describe('an answer whose resume was refused and whose question the re-read finds gone', () => {
  test('is dropped from the transcript, so the next start sends the agent no stale answer', async () => {
    const mounted = mount([
      parkedStart([environment]),
      refused('RUN_FAILED', RESUME_ATTEMPT_FAILED_MESSAGES.answersNotApplied),
    ]);
    const session = open(mounted.fetch);
    await session.adapter.sendMessage({ role: 'user', content: 'Ship it' }, []);
    await session.adapter
      .sendMessage({ role: 'user', content: 'staging' }, [])
      .catch(() => undefined);
    await afterReread(session, mounted.requests);

    // The thread holds no run to attach to, so the question is gone and the typed row is no answer.
    expect(userRows(session)).toEqual(['Ship it']);
    await session.adapter.sendMessage({ role: 'user', content: 'Next please' }, []);
    expect(mounted.thread.delivered).toEqual(['Ship it', 'Next please']);
  });
});
