import { createAgent, type GenerateFunction } from '@lostgradient/operative';
import { describe, expect, it } from 'bun:test';

import { createBureau } from '../create-bureau.ts';
import { createBureauHandler } from './create-bureau-handler.ts';

const AGENT_NAME = 'assistant';
const THREAD_ID = 'thread-named-option';

const generate: GenerateFunction = async () => ({ content: 'Done.', toolCalls: [] });

/** A Bureau with one published-able agent, with or without a durable engine. */
async function buildBureau(options: { durable: boolean }) {
  return createBureau({
    id: 'ag-ui-mount-test',
    agents: { [AGENT_NAME]: createAgent({ generate, name: AGENT_NAME }) },
    generate,
    ...(options.durable ? { storage: { type: 'memory' as const }, durableExecution: true } : {}),
  });
}

type TestBureau = Awaited<ReturnType<typeof buildBureau>>;

async function withBureau<T>(
  options: { durable: boolean },
  run: (bureau: TestBureau) => Promise<T> | T,
): Promise<T> {
  const bureau = await buildBureau(options);
  try {
    return await run(bureau);
  } finally {
    await bureau.dispose();
  }
}

const SERVER_SENT_EVENTS = { Accept: 'text/event-stream' };

/** The four requests the `agUi` option mounts, against a prefix and a native run id. */
function mountRequests(prefix: string, runId: string): Record<string, Request> {
  const runAgentInput = {
    threadId: THREAD_ID,
    runId: 'client-run-1',
    messages: [{ id: 'user-1', role: 'user', content: 'hello' }],
    tools: [],
    context: [],
    state: {},
    forwardedProps: {},
  };
  return {
    start: new Request(`http://localhost${prefix}/agents/${AGENT_NAME}/run`, {
      method: 'POST',
      headers: { ...SERVER_SENT_EVENTS, 'content-type': 'application/json' },
      body: JSON.stringify(runAgentInput),
    }),
    attachByThread: new Request(`http://localhost${prefix}/threads/${THREAD_ID}/run`, {
      headers: SERVER_SENT_EVENTS,
    }),
    attachByRun: new Request(`http://localhost${prefix}/runs/${runId}`, {
      headers: SERVER_SENT_EVENTS,
    }),
    cancel: new Request(`http://localhost${prefix}/runs/${runId}/cancel`, { method: 'POST' }),
  };
}

describe('the agUi option on createBureauHandler', () => {
  it('serves the four routes under the default prefix when agUi is set', async () => {
    // The Bureau's own generate holds a bare `createRun` live until released, so the
    // cancel route has a live run to answer for. The published agent answers at once.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const bureau = await createBureau({
      id: 'ag-ui-mount-test',
      agents: { [AGENT_NAME]: createAgent({ generate, name: AGENT_NAME }) },
      generate: async () => {
        await gate;
        return { content: 'Done.', toolCalls: [] };
      },
      storage: { type: 'memory' },
      durableExecution: true,
    });
    try {
      const handler = createBureauHandler(bureau, {
        unauthenticatedAccess: 'allow',
        publish: [AGENT_NAME],
        agUi: {},
      });
      const run = await bureau.createRun({ message: 'hold' });
      const requests = mountRequests('/ag-ui', run.id);

      const cancel = await handler(requests['cancel'] as Request);
      expect(cancel.status).toBe(200);
      expect(await cancel.json()).toEqual({ runId: run.id, status: 'aborting' });

      release();
      for (const name of ['start', 'attachByThread', 'attachByRun'] as const) {
        const response = await handler(requests[name] as Request);
        expect(response.status, name).toBe(200);
        expect(response.headers.get('content-type'), name).toContain('text/event-stream');
        await response.text();
      }
    } finally {
      release();
      await bureau.dispose();
    }
  });

  it('serves nothing under the prefix when agUi is omitted', async () => {
    await withBureau({ durable: true }, async (bureau) => {
      const handler = createBureauHandler(bureau, {
        unauthenticatedAccess: 'allow',
        publish: [AGENT_NAME],
      });
      const requests = mountRequests('/ag-ui', 'any-run');

      for (const [name, request] of Object.entries(requests)) {
        const response = await handler(request);
        expect(response.status, name).toBe(404);
        await response.text();
      }
    });
  });

  it('moves every route under a custom pathPrefix', async () => {
    await withBureau({ durable: true }, async (bureau) => {
      const handler = createBureauHandler(bureau, {
        unauthenticatedAccess: 'allow',
        publish: [AGENT_NAME],
        agUi: { pathPrefix: '/agent-ui' },
      });

      const moved = await handler(
        mountRequests('/agent-ui', 'any-run')['attachByThread'] as Request,
      );
      expect(moved.status).toBe(200);
      await moved.text();

      const old = await handler(mountRequests('/ag-ui', 'any-run')['attachByThread'] as Request);
      expect(old.status).toBe(404);
      await old.text();
    });
  });

  it('throws at construction when the Bureau has no durable engine', async () => {
    await withBureau({ durable: false }, (bureau) => {
      expect(() =>
        createBureauHandler(bureau, {
          unauthenticatedAccess: 'allow',
          publish: [AGENT_NAME],
          agUi: {},
        }),
      ).toThrow(/durable/);
    });
  });
});
