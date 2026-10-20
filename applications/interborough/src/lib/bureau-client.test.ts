import { rejectionOf } from '@lostgradient/testing';
import { HttpClientError } from '@lostgradient/weft';
import { describe, expect, test } from 'bun:test';

import {
  callBureau,
  type Fetcher,
  getContext,
  getThreadMessages,
  listAgents,
  listContexts,
  sendContextInput,
} from './bureau-client.ts';
import { classifyFault } from './faults.ts';
import { installFetchImplementation } from './live-source/fetch.test-support.ts';

/** The text of a request's JSON body. */
function bodyText(init: RequestInit | undefined): string {
  if (typeof init?.body !== 'string') throw new Error('The request had no JSON body.');
  return init.body;
}

type Call = {
  url: string;
  body: { jsonrpc?: string; id?: string; method: string; params: unknown };
};

/** A fetch that records the JSON-RPC call it was given and answers with `answer`. */
function answering(answer: () => Response) {
  const calls: Call[] = [];
  const stub: Fetcher = async (input, init) => {
    calls.push({
      url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      body: JSON.parse(bodyText(init)),
    });
    return answer();
  };
  return { calls, fetch: stub };
}

const result = (value: unknown) => () => Response.json({ jsonrpc: '2.0', id: 1, result: value });

const fault =
  (status: number, code: string, message: string, data: object = {}) =>
  () =>
    Response.json({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32000, message, data: { weftCode: code, httpStatus: status, ...data } },
    });

async function failureOf(pending: Promise<unknown>): Promise<unknown> {
  return pending.then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe('callBureau', () => {
  test('posts a JSON-RPC call to the Bureau’s own route and returns its result', async () => {
    const stub = answering(result({ ok: true }));

    const value = await callBureau(
      'bureau.contexts.get',
      { contextId: 'c1' },
      { fetch: stub.fetch },
    );

    expect(value).toEqual({ ok: true });
    expect(stub.calls[0]?.url).toBe('/bureau/jsonrpc');
    expect(stub.calls[0]?.body).toMatchObject({
      method: 'bureau.contexts.get',
      params: { contextId: 'c1' },
    });
  });

  test('throws a fault as an HttpClientError with the status the fault carries and its code and data', async () => {
    const stub = answering(fault(409, 'Conflict', 'Used', { reason: 'session-terminal' }));

    const error = await failureOf(callBureau('bureau.contexts.input', {}, { fetch: stub.fetch }));

    expect(error).toBeInstanceOf(HttpClientError);
    expect(error).toMatchObject({
      status: 409,
      message: 'Used',
      data: { reason: 'session-terminal' },
    });
  });

  test('a fault is classified by the console as the treatment its code names', async () => {
    const stub = answering(fault(404, 'NotFound', 'No context'));

    const error = await failureOf(callBureau('bureau.contexts.get', {}, { fetch: stub.fetch }));

    expect(classifyFault(error)?.kind).toBe('not-found');
  });

  test('a body that is not JSON-RPC is an error with the response’s status', async () => {
    const stub = answering(() => new Response('Forbidden', { status: 403 }));

    const error = await failureOf(callBureau('bureau.contexts.get', {}, { fetch: stub.fetch }));

    expect(error).toMatchObject({ status: 403 });
  });

  test('a JSON body with no result and no error is an error', async () => {
    const stub = answering(() => Response.json({ jsonrpc: '2.0', id: 1 }));

    const error = await failureOf(callBureau('bureau.contexts.get', {}, { fetch: stub.fetch }));

    expect(error).toBeInstanceOf(HttpClientError);
  });

  test('an error with no message or data still carries the status', async () => {
    const stub = answering(() => Response.json({ error: {} }, { status: 500 }));

    const error = await failureOf(callBureau('bureau.contexts.get', {}, { fetch: stub.fetch }));

    expect(error).toMatchObject({ status: 500, message: 'HTTP 500' });
  });
});

describe('the Bureau’s context operations', () => {
  async function withStub<T>(stub: Fetcher, body: () => Promise<T>): Promise<T> {
    const restore = installFetchImplementation(stub);
    try {
      return await body();
    } finally {
      restore();
    }
  }

  test('getContext asks for one context by its identifier', async () => {
    const stub = answering(
      result({
        id: 'c1',
        owner: 'anonymous:local',
        agentName: 'assistant',
        title: 'Hi',
        lastMessagePreview: null,
        messageCount: 2,
        createdAt: '2026-10-19T00:00:00.000Z',
        updatedAt: '2026-10-19T00:00:00.000Z',
        activity: 'idle',
      }),
    );

    const context = await withStub(stub.fetch, () => getContext('c1'));

    expect(context).toMatchObject({ id: 'c1', agentName: 'assistant' });
    expect(stub.calls[0]?.body).toMatchObject({
      method: 'bureau.contexts.get',
      params: { contextId: 'c1' },
    });
  });

  test('sendContextInput sends the input under the caller’s identifier, and nothing about delivery', async () => {
    const stub = answering(
      result({ outcome: 'admitted', receipt: { id: 'row-1', state: 'accepted' } }),
    );

    const sent = await withStub(stub.fetch, () =>
      sendContextInput('c1', { id: 'row-1', payload: 'More' }),
    );

    expect(sent.receipt.state).toBe('accepted');
    expect(stub.calls[0]?.body).toEqual({
      jsonrpc: '2.0',
      id: 'bureau.contexts.input',
      method: 'bureau.contexts.input',
      params: { contextId: 'c1', input: { id: 'row-1', payload: 'More' } },
    });
  });
});

describe('the lists and details the chat and agents views read', () => {
  async function withStub<T>(stub: Fetcher, body: () => Promise<T>): Promise<T> {
    const restore = installFetchImplementation(stub);
    try {
      return await body();
    } finally {
      restore();
    }
  }

  test('listContexts asks for a page, optionally of one agent, and reads the next offset', async () => {
    const stub = answering(result({ contexts: [], nextOffset: 20 }));

    const page = await withStub(stub.fetch, () =>
      listContexts({ agentName: 'assistant', limit: 20, offset: 20 }),
    );

    expect(page).toEqual({ contexts: [], nextOffset: 20 });
    expect(stub.calls[0]?.body).toMatchObject({
      method: 'bureau.contexts.list',
      params: { agentName: 'assistant', limit: 20, offset: 20 },
    });
  });

  test('listContexts refuses a page that is not one', async () => {
    const stub = answering(result({ items: [] }));

    const error = await failureOf(withStub(stub.fetch, () => listContexts()));

    expect(String(error)).toContain('contexts');
  });

  test('listAgents returns the agents with their kind and publish state', async () => {
    const agent = {
      name: 'internal',
      displayName: 'internal',
      description: null,
      definitionRevision: 1,
      kind: 'code',
      publishState: 'unpublished',
    };
    const stub = answering(result({ agents: [agent] }));

    const agents = await withStub(stub.fetch, () => listAgents());

    // An answer with no `media` is an agent that names no model, which can take no attachment.
    expect(agents).toEqual([{ ...agent, media: null } as never]);
    expect(stub.calls[0]?.body.method).toBe('bureau.agents.list');
  });

  test.each([-1, 1.5])('listAgents refuses a per-part byte limit of %s', async (maxBytes) => {
    const agent = {
      name: 'seer',
      displayName: 'Seer',
      description: null,
      definitionRevision: 1,
      kind: 'code',
      publishState: 'published',
      media: {
        modalities: {},
        mimeFamilies: [],
        mediaLimits: [{ modality: 'image', maxBytes }],
      },
    };

    const refusal = await rejectionOf(
      withStub(answering(result({ agents: [agent] })).fetch, () => listAgents()),
    );

    expect(refusal).toBeInstanceOf(Error);
  });

  test('listAgents carries what each agent’s model takes in the way of media', async () => {
    const media = {
      modalities: { image: { input: true, output: false } },
      mimeFamilies: ['image'],
      mediaLimits: [{ modality: 'image', maxBytes: 1024 }],
    };
    const agent = {
      name: 'seer',
      displayName: 'Seer',
      description: null,
      definitionRevision: 1,
      kind: 'code',
      publishState: 'published',
      media,
    };

    const agents = await withStub(answering(result({ agents: [agent] })).fetch, () => listAgents());

    expect(agents[0]?.media).toEqual(media);
  });

  test('getThreadMessages returns the messages the mount gives for a thread', async () => {
    const urls: string[] = [];
    const stub: Fetcher = async (input) => {
      urls.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      return Response.json({
        threadId: 't 1',
        messages: [{ id: 'm', role: 'user', content: 'Hi' }],
      });
    };

    const messages = await getThreadMessages('t 1', { fetch: stub });

    expect(messages).toHaveLength(1);
    expect(urls).toEqual(['/bureau/ag-ui/threads/t%201/messages']);
  });

  test('getThreadMessages throws the status of a thread the mount refuses', async () => {
    const stub: Fetcher = async () => new Response('{}', { status: 404 });

    const error = await failureOf(getThreadMessages('nope', { fetch: stub }));

    expect(error).toMatchObject({ status: 404 });
  });
});
