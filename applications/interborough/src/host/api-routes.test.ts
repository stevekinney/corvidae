/**
 * Interborough's own API (`api-routes.ts`): each of the seven operations answers what it did, refuses
 * a request it does not take with every issue, and refuses a session without its scope before it
 * reads anything. The Bureau is a stand-in that records each call, and the routes are served by a
 * real Bun listener so the paths and methods are routed as the host routes them.
 */
import { BureauError, WorkflowInputInvalidError } from '@lostgradient/bureau';
import { afterEach, describe, expect, test } from 'bun:test';

import { API_SCOPES, type ApiScope } from '../lib/api-scopes.ts';
import {
  apiRoutes,
  localApiPrincipal,
  type ApiBureau,
  type ApiPrincipal,
  type ApiTimelineEntry,
} from './api-routes.ts';

const RUN = {
  id: 'run-1-9f3a',
  workflow: 'order-refund',
  status: 'running',
  createdAt: '2026-11-06T09:41:00.000Z',
  updatedAt: '2026-11-06T09:41:02.000Z',
};

const TIMELINE: readonly ApiTimelineEntry[] = [
  {
    step: 0,
    operationType: 'activity',
    operationLabel: 'look-up-order',
    status: 'completed',
    timestamp: Date.parse('2026-11-06T09:41:00.500Z'),
    duration: 420,
  },
];

interface Recorded {
  readonly calls: { readonly name: string; readonly argument: unknown }[];
}

function fakeBureau(recorded: Recorded, overrides: Partial<ApiBureau> = {}): ApiBureau {
  const record = (name: string, argument: unknown) => recorded.calls.push({ name, argument });
  return {
    workflows: {
      listRuns: async (filter) => {
        record('workflows.listRuns', filter);
        return { runs: [RUN], nextOffset: null };
      },
      getRun: async (runId) => {
        record('workflows.getRun', runId);
        return runId === RUN.id ? RUN : undefined;
      },
      start: async (id, options) => {
        record('workflows.start', { id, ...options });
        if (id === 'missing') throw new BureauError('No such workflow.', 'NOT_FOUND');
        if (id === 'strict') {
          throw new WorkflowInputInvalidError('strict', [
            { path: ['order'], message: 'Expected a number.' },
          ]);
        }
        return { runId: RUN.id };
      },
    },
    contexts: {
      get: async (id) => {
        record('contexts.get', id);
        return id === 'chat-7c21' ? { agentName: 'assistant' } : undefined;
      },
    },
    tasks: {
      start: async (agentName, input, options) => {
        record('tasks.start', { agentName, input, ...options });
        return { id: 'task-2-b81e' };
      },
    },
    agents: {
      list: () => [
        {
          id: 'assistant',
          source: 'file',
          state: 'ready',
          name: 'Assistant',
          description: 'Answers questions.',
        },
        { id: 'broken', source: 'file', state: 'invalid', name: 'broken', description: null },
      ],
    },
    schedules: {
      list: async (filter) => {
        record('schedules.list', filter);
        return {
          items: [
            {
              id: 'weekly-refund-audit',
              workflowType: 'order-refund',
              description: 'Weekly refund audit',
              status: 'active',
              nextFireAt: Date.parse('2026-11-09T09:00:00.000Z'),
            },
          ],
          total: 3,
        };
      },
    },
    reviews: {
      resolve: async (input) => {
        record('reviews.resolve', input);
        if (input.id === 'gone') throw new BureauError('No such review.', 'NOT_FOUND');
        return { id: input.id, decision: input.decision };
      },
    },
    ...overrides,
  };
}

const servers: Bun.Server<unknown>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop(true);
});

function serve(options: { scopes?: readonly ApiScope[]; bureau?: Partial<ApiBureau> } = {}) {
  const recorded: Recorded = { calls: [] };
  const principal: ApiPrincipal = {
    subject: 'anonymous:local',
    scopes: new Set(options.scopes ?? API_SCOPES),
  };
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    routes: apiRoutes(
      {
        bureau: fakeBureau(recorded, options.bureau),
        timeline: async (runId) => (runId === RUN.id ? TIMELINE : []),
        principal: () => principal,
      },
      () => undefined,
    ),
    fetch: () => new Response('Not found', { status: 404 }),
  });
  servers.push(server);
  const call = (path: string, init?: { method?: string; body?: unknown }) =>
    fetch(new URL(path, server.url), {
      method: init?.method ?? 'GET',
      ...(init?.body === undefined
        ? {}
        : {
            headers: { 'content-type': 'application/json' },
            body: typeof init.body === 'string' ? init.body : JSON.stringify(init.body),
          }),
    });
  return { call, recorded };
}

/** The status a call answers with. */
async function statusOf(answer: Promise<Response>): Promise<number> {
  const response = await answer;
  return response.status;
}

const without = (scope: ApiScope) => API_SCOPES.filter((candidate) => candidate !== scope);

describe('GET /api/runs', () => {
  test('lists runs a page at a time', async () => {
    const { call, recorded } = serve();
    const response = await call('/api/runs?workflow=order-refund&status=running&limit=10');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      runs: [
        {
          run: RUN.id,
          workflow: 'order-refund',
          status: 'running',
          createdAt: RUN.createdAt,
          updatedAt: RUN.updatedAt,
        },
      ],
      nextOffset: null,
    });
    expect(recorded.calls).toEqual([
      {
        name: 'workflows.listRuns',
        argument: { workflow: 'order-refund', status: 'running', limit: 10, offset: 0 },
      },
    ]);
  });

  test('refuses a query it does not take, naming each issue', async () => {
    const { call, recorded } = serve();
    const response = await call('/api/runs?status=sleeping&limit=0&colour=red');
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; issues: { path: string }[] };
    expect(body.error).toBe('invalid');
    expect(body.issues.map((issue) => issue.path).toSorted()).toEqual(['', 'limit', 'status']);
    expect(recorded.calls).toEqual([]);
  });

  test('refuses a session without runs:read', async () => {
    const { call, recorded } = serve({ scopes: without('runs:read') });
    const response = await call('/api/runs');
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: 'forbidden',
      message: 'This session does not hold runs:read.',
      scope: 'runs:read',
    });
    expect(recorded.calls).toEqual([]);
  });

  test('says the Bureau runs no workflows when it has none', async () => {
    const { call } = serve({ bureau: { workflows: undefined } });
    const response = await call('/api/runs');
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: 'unavailable' });
  });
});

describe('POST /api/runs', () => {
  test('starts a run as the session, from the API, and answers 201 with its identifier and status', async () => {
    const { call, recorded } = serve();
    const response = await call('/api/runs', {
      method: 'POST',
      body: { workflow: 'order-refund', input: { order: 4471 } },
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ run: RUN.id, status: 'running' });
    expect(recorded.calls[0]).toEqual({
      name: 'workflows.start',
      argument: {
        id: 'order-refund',
        input: { order: 4471 },
        owner: 'anonymous:local',
        surface: 'api',
      },
    });
  });

  test('refuses a body that is not JSON, or lacks the workflow', async () => {
    const { call, recorded } = serve();
    const broken = await call('/api/runs', { method: 'POST', body: '{"workflow":' });
    expect(broken.status).toBe(400);
    expect(await broken.json()).toMatchObject({ message: 'The request body is not valid JSON.' });
    const missing = await call('/api/runs', { method: 'POST', body: { input: {} } });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({
      error: 'invalid',
      issues: [{ path: 'workflow' }],
    });
    expect(recorded.calls).toEqual([]);
  });

  test('answers an input the workflow refuses with each issue, and a workflow that does not exist with 404', async () => {
    const { call } = serve();
    const refused = await call('/api/runs', {
      method: 'POST',
      body: { workflow: 'strict', input: { order: 'x' } },
    });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({
      error: 'invalid',
      issues: [{ path: 'input.order', message: 'Expected a number.' }],
    });
    const missing = await call('/api/runs', { method: 'POST', body: { workflow: 'missing' } });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: 'not-found' });
  });

  test('refuses a session without runs:write before it reads the body', async () => {
    const { call, recorded } = serve({ scopes: without('runs:write') });
    const response = await call('/api/runs', { method: 'POST', body: 'not json' });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ scope: 'runs:write' });
    expect(recorded.calls).toEqual([]);
  });
});

describe('GET /api/runs/{run}', () => {
  test('reads one run and its steps', async () => {
    const { call } = serve();
    const response = await call(`/api/runs/${RUN.id}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      run: RUN.id,
      workflow: 'order-refund',
      status: 'running',
      createdAt: RUN.createdAt,
      updatedAt: RUN.updatedAt,
      steps: [
        {
          step: 0,
          operation: 'look-up-order',
          type: 'activity',
          status: 'completed',
          startedAt: '2026-11-06T09:41:00.500Z',
          durationMilliseconds: 420,
        },
      ],
    });
  });

  test('answers a run that does not exist with 404, and a query it does not take with 400', async () => {
    const { call } = serve();
    expect(await statusOf(call('/api/runs/run-nope'))).toBe(404);
    expect(await statusOf(call(`/api/runs/${RUN.id}?expand=all`))).toBe(400);
  });

  test('refuses a session without runs:read', async () => {
    const { call } = serve({ scopes: without('runs:read') });
    expect(await statusOf(call(`/api/runs/${RUN.id}`))).toBe(403);
  });
});

describe('POST /api/chats/{chat}/messages', () => {
  test('sends the message as a turn of the chat’s agent, and answers 201 with the run that answers it', async () => {
    const { call, recorded } = serve();
    const response = await call('/api/chats/chat-7c21/messages', {
      method: 'POST',
      body: { text: 'Refund order 4471 in full.' },
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ chat: 'chat-7c21', run: 'task-2-b81e' });
    expect(recorded.calls.at(-1)).toEqual({
      name: 'tasks.start',
      argument: {
        agentName: 'assistant',
        input: 'Refund order 4471 in full.',
        contextId: 'chat-7c21',
        principal: 'anonymous:local',
      },
    });
  });

  test('refuses an empty message, and answers a chat that does not exist with 404', async () => {
    const { call } = serve();
    const empty = await call('/api/chats/chat-7c21/messages', {
      method: 'POST',
      body: { text: '' },
    });
    expect(empty.status).toBe(400);
    expect(await empty.json()).toMatchObject({ issues: [{ path: 'text' }] });
    const missing = await call('/api/chats/chat-nope/messages', {
      method: 'POST',
      body: { text: 'Hello' },
    });
    expect(missing.status).toBe(404);
  });

  test('refuses a session without chats:write', async () => {
    const { call, recorded } = serve({ scopes: without('chats:write') });
    const response = await call('/api/chats/chat-7c21/messages', {
      method: 'POST',
      body: { text: 'Hello' },
    });
    expect(response.status).toBe(403);
    expect(recorded.calls).toEqual([]);
  });
});

describe('GET /api/agents', () => {
  test('lists the agents that are ready', async () => {
    const { call } = serve();
    const response = await call('/api/agents');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      agents: [
        { agent: 'assistant', name: 'Assistant', description: 'Answers questions.', kind: 'file' },
      ],
    });
  });

  test('refuses a query, and a session without agents:read', async () => {
    expect(await statusOf(serve().call('/api/agents?all=1'))).toBe(400);
    expect(await statusOf(serve({ scopes: without('agents:read') }).call('/api/agents'))).toBe(403);
  });
});

describe('GET /api/schedules', () => {
  test('lists the schedules with when each next runs, and the offset of the next page', async () => {
    const { call, recorded } = serve();
    const response = await call('/api/schedules?limit=1');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      schedules: [
        {
          schedule: 'weekly-refund-audit',
          workflow: 'order-refund',
          description: 'Weekly refund audit',
          status: 'active',
          nextRunAt: '2026-11-09T09:00:00.000Z',
        },
      ],
      nextOffset: 1,
    });
    expect(recorded.calls).toEqual([{ name: 'schedules.list', argument: { limit: 1, offset: 0 } }]);
  });

  test('refuses a negative offset, and a session without schedules:read', async () => {
    expect(await statusOf(serve().call('/api/schedules?offset=-1'))).toBe(400);
    expect(
      await statusOf(serve({ scopes: without('schedules:read') }).call('/api/schedules')),
    ).toBe(403);
  });
});

describe('POST /api/reviews/{review}/decision', () => {
  test('approves a review as the session', async () => {
    const { call, recorded } = serve();
    const response = await call('/api/reviews/review-3-0d4c/decision', {
      method: 'POST',
      body: { decision: 'deny', reason: 'Wrong order.' },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ review: 'review-3-0d4c', decision: 'deny' });
    expect(recorded.calls).toEqual([
      {
        name: 'reviews.resolve',
        argument: {
          id: 'review-3-0d4c',
          decision: 'deny',
          principal: 'anonymous:local',
          reason: 'Wrong order.',
        },
      },
    ]);
  });

  test('refuses a decision it does not know, and answers a review that is gone with 404', async () => {
    const { call } = serve();
    const unknown = await call('/api/reviews/review-3-0d4c/decision', {
      method: 'POST',
      body: { decision: 'maybe' },
    });
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toMatchObject({ issues: [{ path: 'decision' }] });
    const gone = await call('/api/reviews/gone/decision', {
      method: 'POST',
      body: { decision: 'approve' },
    });
    expect(gone.status).toBe(404);
  });

  test('refuses a session without reviews:write', async () => {
    const { call, recorded } = serve({ scopes: without('reviews:write') });
    const response = await call('/api/reviews/review-3-0d4c/decision', {
      method: 'POST',
      body: { decision: 'approve' },
    });
    expect(response.status).toBe(403);
    expect(recorded.calls).toEqual([]);
  });
});

describe('GET /host/session', () => {
  test('names the session and the scopes it holds, in the catalog’s order', async () => {
    const response = await serve({ scopes: ['reviews:write', 'runs:read'] }).call('/host/session');
    expect(await response.json()).toEqual({
      subject: 'anonymous:local',
      scopes: ['runs:read', 'reviews:write'],
    });
  });

  test('the local person holds every scope', () => {
    expect([...localApiPrincipal('anonymous:local').scopes]).toEqual([...API_SCOPES]);
  });
});

describe('the request guard', () => {
  test('answers before the scope or the operation', async () => {
    const recorded: Recorded = { calls: [] };
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      routes: apiRoutes(
        {
          bureau: fakeBureau(recorded),
          timeline: async () => [],
          principal: () => ({ subject: 'anonymous:local', scopes: new Set() }),
        },
        () => new Response('Forbidden', { status: 403 }),
      ),
      fetch: () => new Response('Not found', { status: 404 }),
    });
    servers.push(server);
    const response = await fetch(new URL('/api/runs', server.url), {
      method: 'POST',
      body: '{}',
    });
    expect(await response.text()).toBe('Forbidden');
    expect(recorded.calls).toEqual([]);
  });
});
