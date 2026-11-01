/**
 * What a run's question carries and how it is answered in the control its schema drew (COR-1857): the
 * interrupt's answer schema reaches the page, and an answer given in a control (a choice, an object, a
 * file's asset identifier) rides in the one resume with the others, with no row of the person's to
 * carry it. The stub mount answers the way the Bureau's does (`ag-ui-resume.ts`).
 */
import { validateSchemaFormValue } from '@lostgradient/cinder';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { afterEach, describe, expect, test } from 'bun:test';

import { CHAT_COPY } from '../../app/copy.ts';
import type { Fetcher } from '../../lib/bureau-client.ts';
import { ChatSessionState } from './chat-session.svelte.ts';

const THREAD = 'thread-1';
const NATIVE = 'native-1';
const meta = { '@lostgradient/bureau': { runId: NATIVE, sessionId: THREAD } };
const sse = (events: readonly unknown[]) =>
  new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });

/** The response schema of an interrupt parked with an answer schema (`responseSchemaFor`). */
function responseSchema(answer: unknown): unknown {
  return {
    type: 'object',
    properties: {
      decision: { enum: ['approve', 'deny', 'reject'] },
      reason: { type: 'string' },
      arguments: {},
      answer,
    },
    required: ['decision'],
  };
}

const ENVIRONMENT_SCHEMA = { type: 'string', enum: ['staging', 'production'] };
const environment = {
  id: `human-wait:${NATIVE}:environment:0`,
  reason: 'human-wait',
  message: 'Which environment?',
  responseSchema: responseSchema(ENVIRONMENT_SCHEMA),
};
const settings = {
  id: `human-wait:${NATIVE}:settings:0`,
  reason: 'human-wait',
  message: 'Which settings?',
  responseSchema: responseSchema({
    type: 'object',
    properties: { region: { type: 'string' }, replicas: { type: 'integer' } },
  }),
};
const region = {
  id: `human-wait:${NATIVE}:region:0`,
  reason: 'human-wait',
  message: 'Which region?',
};

type Body = {
  runId: string;
  messages: Array<{ id: string; role: string; content: unknown }>;
  resume?: Array<{ interruptId: string; status: string; payload: unknown }>;
};

let sessions: ChatSessionState[] = [];
afterEach(() => {
  for (const session of sessions) session.dispose();
  sessions = [];
});

function open(fetchAgUi: Fetcher, closed?: () => boolean): ChatSessionState {
  const session = new ChatSessionState({
    sessionId: THREAD,
    agentName: () => 'assistant',
    fetch: fetchAgUi,
    ...(closed === undefined ? {} : { closed }),
  });
  sessions.push(session);
  return session;
}

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

const success = (body: Body) =>
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

const invalidInput = () =>
  sse([
    {
      type: 'RUN_ERROR',
      message: 'The answer does not fit the schema.',
      code: 'INVALID_INPUT',
    },
  ]);

/** The attach a re-read makes of a thread whose run is still parked on `interrupts`. */
const stillParkedOn = (...interrupts: unknown[]) =>
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

function mount(starts: Array<(body: Body) => Response>, attaches: Array<() => Response> = []) {
  const bodies: Body[] = [];
  const requests: string[] = [];
  const fetchStub: Fetcher = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    requests.push(`${init?.method ?? 'GET'} ${url}`);
    if (url.endsWith('/messages')) {
      return Response.json({ threadId: THREAD, messages: bodies[0]?.messages ?? [] });
    }
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

describe('the schema a question carries', () => {
  test('is the answer property of the interrupt’s response schema', async () => {
    const mounted = mount([parkedStart([environment, settings])]);
    const session = open(mounted.fetch);

    await session.adapter.sendMessage({ role: 'user', content: 'Ship it' }, []);

    expect(session.humanRequests.map((request) => request.schema)).toEqual([
      ENVIRONMENT_SCHEMA,
      {
        type: 'object',
        properties: { region: { type: 'string' }, replicas: { type: 'integer' } },
      },
    ]);
  });

  test('is absent for an interrupt that carries none, or only the generic resume schema', async () => {
    const generic = { ...region, responseSchema: responseSchema({}) };
    const mounted = mount([parkedStart([region, generic])]);
    const session = open(mounted.fetch);

    await session.adapter.sendMessage({ role: 'user', content: 'Ship it' }, []);

    expect(session.humanRequests).toEqual([
      { interruptId: region.id, message: region.message },
      { interruptId: generic.id, message: generic.message },
    ]);
  });
});

describe('a question answered in its control', () => {
  test('resumes the run with the value, and adds no row of the person’s', async () => {
    const mounted = mount([parkedStart([settings]), success]);
    const session = open(mounted.fetch);
    await session.adapter.sendMessage({ role: 'user', content: 'Ship it' }, []);
    const rows = session.conversation.ids.length;

    const answered = await session.answerQuestion(settings.id, { region: 'eu', replicas: 3 });

    expect(answered).toBe(true);
    expect(mounted.bodies).toHaveLength(2);
    expect(mounted.bodies[1]?.messages).toEqual([]);
    expect(mounted.bodies[1]?.resume).toEqual([
      {
        interruptId: settings.id,
        status: 'resolved',
        payload: { decision: 'approve', answer: { region: 'eu', replicas: 3 } },
      },
    ]);
    expect(session.humanRequests).toEqual([]);
    expect(session.failure).toBeUndefined();
    expect(session.conversation.ids.length).toBe(rows);
  });

  test('is held while another question waits, and the one resume carries both answers', async () => {
    const mounted = mount([parkedStart([environment, region]), success]);
    const session = open(mounted.fetch);
    await session.adapter.sendMessage({ role: 'user', content: 'Ship it' }, []);

    expect(await session.answerQuestion(environment.id, 'staging')).toBe(true);

    expect(mounted.bodies).toHaveLength(1);
    expect(session.humanRequests.map((request) => request.interruptId)).toEqual([region.id]);

    await session.adapter.sendMessage({ role: 'user', content: 'eu' }, []);

    expect(mounted.bodies).toHaveLength(2);
    expect(mounted.bodies[1]?.resume?.map((entry) => entry.payload)).toEqual([
      { decision: 'approve', answer: 'staging' },
      { decision: 'approve', answer: 'eu' },
    ]);
  });

  test('answers a file question with the asset the upload returned', async () => {
    const file = {
      ...environment,
      responseSchema: responseSchema({
        type: 'string',
        contentMediaType: 'image/png',
        'x-asset': true,
      }),
    };
    const mounted = mount([parkedStart([file]), success]);
    const session = open(mounted.fetch);
    await session.adapter.sendMessage({ role: 'user', content: 'Ship it' }, []);

    await session.answerQuestion(file.id, 'asset-42');

    expect(mounted.bodies[1]?.resume?.[0]?.payload).toEqual({
      decision: 'approve',
      answer: 'asset-42',
    });
  });

  test('is not taken for a question the run does not wait on, and sends nothing', async () => {
    const mounted = mount([parkedStart([environment]), success]);
    const session = open(mounted.fetch);
    await session.adapter.sendMessage({ role: 'user', content: 'Ship it' }, []);

    expect(await session.answerQuestion('human-wait:other', 'staging')).toBe(false);

    expect(mounted.bodies).toHaveLength(1);
    expect(session.humanRequests.map((request) => request.interruptId)).toEqual([environment.id]);
  });

  test('is asked again, with the failure told, when the mount refuses it as not fitting', async () => {
    const mounted = mount(
      [parkedStart([environment]), invalidInput],
      [() => stillParkedOn(environment)],
    );
    const session = open(mounted.fetch);
    await session.adapter.sendMessage({ role: 'user', content: 'Ship it' }, []);

    await session.answerQuestion(environment.id, 'nowhere');
    await waitUntil(
      () =>
        mounted.requests.some((entry) => entry.includes('/threads/')) &&
        !session.attaching &&
        !session.streaming &&
        session.humanRequests.length === 1,
      { message: 'the question to be asked again' },
    );

    expect(session.failure).toContain('does not fit');
    expect(session.humanRequests.map((request) => request.interruptId)).toEqual([environment.id]);
    // The answer that did not fit is not sent a second time.
    expect(mounted.bodies).toHaveLength(2);
  });
});

/**
 * A question whose answer schema keeps its definitions apart and refers to itself, as the mount
 * sends it: every local reference rebased under `#/properties/answer` (`responseSchemaFor`).
 */
const REBASED_SCHEMA = {
  type: 'object',
  properties: {
    region: { $ref: '#/properties/answer/$defs/region' },
    children: { type: 'array', items: { $ref: '#/properties/answer' } },
    note: { type: 'string', default: '#/properties/answer/$defs/region' },
  },
  required: ['region'],
  $defs: { region: { type: 'string', enum: ['eu', 'us'] } },
};
const rebased = {
  id: `human-wait:${NATIVE}:rebased:0`,
  reason: 'human-wait',
  message: 'Which region?',
  responseSchema: responseSchema(REBASED_SCHEMA),
};

describe('a question whose schema refers to itself', () => {
  test('is handed to the form with its references back at the schema’s own root', async () => {
    const mounted = mount([parkedStart([rebased])]);
    const session = open(mounted.fetch);

    await session.adapter.sendMessage({ role: 'user', content: 'Ship it' }, []);

    const schema = session.humanRequests[0]?.schema;
    expect(schema).toEqual({
      type: 'object',
      properties: {
        region: { $ref: '#/$defs/region' },
        children: { type: 'array', items: { $ref: '#' } },
        // Data under a `default` is not a reference.
        note: { type: 'string', default: '#/properties/answer/$defs/region' },
      },
      required: ['region'],
      $defs: { region: { type: 'string', enum: ['eu', 'us'] } },
    });
  });

  test('can be answered: the form’s validator resolves its references and checks the answer', async () => {
    const mounted = mount([parkedStart([rebased])]);
    const session = open(mounted.fetch);
    await session.adapter.sendMessage({ role: 'user', content: 'Ship it' }, []);
    const schema = session.humanRequests[0]?.schema ?? {};

    const fits = await validateSchemaFormValue(schema, {
      region: 'eu',
      children: [{ region: 'us' }],
    });
    const wrong = await validateSchemaFormValue(schema, { region: 'mars' });
    const nestedWrong = await validateSchemaFormValue(schema, {
      region: 'eu',
      children: [{ region: 'mars' }],
    });

    expect(fits.valid).toBe(true);
    expect(wrong.valid).toBe(false);
    expect(nestedWrong.valid).toBe(false);
  });
});

describe('a question answered in its control when the resume is not applied', () => {
  /** The thread's attach after a refusal: the run is still parked on `environment`. */
  const stillParked = () => stillParkedOn(environment);

  test('comes back with the reason when the request fails with a 500', async () => {
    const mounted = mount([
      parkedStart([environment]),
      () => new Response('boom', { status: 500 }),
    ]);
    const session = open(mounted.fetch);
    await session.adapter.sendMessage({ role: 'user', content: 'Ship it' }, []);

    const answered = await session.answerQuestion(environment.id, 'staging');

    expect(answered).toBe(false);
    expect(session.humanRequests.map((request) => request.interruptId)).toEqual([environment.id]);
    expect(session.failure).toBeDefined();
    expect(session.failure).not.toBe('');
  });

  test('comes back with the reason when the request is rejected', async () => {
    const mounted = mount([
      parkedStart([environment]),
      () => {
        throw new TypeError('network down');
      },
    ]);
    const session = open(mounted.fetch);
    await session.adapter.sendMessage({ role: 'user', content: 'Ship it' }, []);

    const answered = await session.answerQuestion(environment.id, 'staging');

    expect(answered).toBe(false);
    expect(session.humanRequests.map((request) => request.interruptId)).toEqual([environment.id]);
    expect(session.failure).toBeDefined();
  });

  test('comes back with the reason when the thread is busy', async () => {
    const busy = () =>
      sse([{ type: 'RUN_ERROR', message: 'Thread has a run in progress', code: 'THREAD_BUSY' }]);
    const mounted = mount([parkedStart([environment]), busy], [stillParked]);
    const session = open(mounted.fetch);
    await session.adapter.sendMessage({ role: 'user', content: 'Ship it' }, []);

    const answered = await session.answerQuestion(environment.id, 'staging');

    // The thread is read again after the refusal, and says the run still waits on the question.
    await waitUntil(() => session.humanRequests.length === 1 && !session.streaming, {
      message: 'the question to be offered again',
    });
    expect(answered).toBe(false);
    expect(session.humanRequests.map((request) => request.interruptId)).toEqual([environment.id]);
    expect(session.failure).toBe(CHAT_COPY.answerNotSent);
  });

  test('is answered again from the control that came back, once, without the failed value', async () => {
    const mounted = mount([
      parkedStart([environment]),
      () => new Response('boom', { status: 500 }),
      success,
    ]);
    const session = open(mounted.fetch);
    await session.adapter.sendMessage({ role: 'user', content: 'Ship it' }, []);
    await session.answerQuestion(environment.id, 'staging');

    const answered = await session.answerQuestion(environment.id, 'production');

    expect(answered).toBe(true);
    expect(mounted.bodies).toHaveLength(3);
    expect(mounted.bodies[2]?.resume).toEqual([
      {
        interruptId: environment.id,
        status: 'resolved',
        payload: { decision: 'approve', answer: 'production' },
      },
    ]);
    expect(session.humanRequests).toEqual([]);
  });
});

describe('a question answered in a chat that was deleted', () => {
  test('sends nothing and says why', async () => {
    let deleted = false;
    const mounted = mount([parkedStart([environment]), success]);
    const session = open(mounted.fetch, () => deleted);
    await session.adapter.sendMessage({ role: 'user', content: 'Ship it' }, []);
    deleted = true;

    const answered = await session.answerQuestion(environment.id, 'staging');

    expect(answered).toBe(false);
    expect(mounted.bodies).toHaveLength(1);
    expect(session.failure).toBe(CHAT_COPY.gone.title);
  });
});
