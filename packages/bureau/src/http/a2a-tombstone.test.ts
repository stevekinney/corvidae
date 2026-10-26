/**
 * Tombstone mounts for withdrawn agents (COR-903): a withdrawn agent that still has a task keeps
 * its A2A path for those tasks, with no card and no new task, until the last task has passed its
 * retention.
 */
import { createDefaultRuntimeServices } from '@lostgradient/lifecycle';
import type { GenerateFunction } from '@lostgradient/operative';
import { afterEach, describe, expect, it } from 'bun:test';

import { waitForCondition } from '../test';
import {
  type FileBureauHarness,
  startFileBureau,
} from '../testing/agent-file-bureau.test-support.ts';
import { agentFileText, KNOWN_MODEL } from '../testing/agent-file-fixtures.test-support.ts';
import { createBureauHandler } from './create-bureau-handler.ts';
import { authentication } from './management/management-fixtures.test-support.ts';

// A JSON-RPC body read back from the wire: each test asserts the shape it needs.
type Json = any;

/** Parks a task whose first message says `park` on a human wait once; answers anything else. */
const parksOnRequest: GenerateFunction = async ({ conversation }) => {
  const messages = conversation.getMessages();
  const first = JSON.stringify(messages.find((message) => message.role === 'user')?.content);
  const answered = messages.some((message) => message.role === 'tool-result');
  return first.includes('park') && !answered
    ? {
        content: '',
        toolCalls: [
          {
            id: 'wait-1',
            name: 'requestHumanInput',
            arguments: { signalName: 'human-response', prompt: 'Which?' },
          },
        ],
      }
    : { content: 'done', toolCalls: [] };
};

const harnesses: FileBureauHarness[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.dispose();
});

type Served = {
  readonly harness: FileBureauHarness;
  readonly handler: (request: Request) => Promise<Response>;
  /** Advances the Bureau's clock by this many milliseconds. */
  readonly advance: (milliseconds: number) => void;
};

async function serveWriter(): Promise<Served> {
  let offset = 0;
  const runtime = createDefaultRuntimeServices();
  const harness = await startFileBureau({
    overrides: {
      id: 'tombstone-bureau',
      models: { generate: () => parksOnRequest },
      runtime: { ...runtime, clock: { ...runtime.clock, now: () => runtime.clock.now() + offset } },
    },
  });
  harnesses.push(harness);
  await harness.put(
    'writer.md',
    agentFileText({ name: 'Writer', model: KNOWN_MODEL, published: 'true' }, 'Write.\n'),
  );
  await harness.bureau.agents.refresh();
  expect(
    harness.bureau.agents.list().some((agent) => agent.id === 'writer' && agent.published),
  ).toBe(true);
  const handler = createBureauHandler(harness.bureau, {
    authentication,
    publicUrl: 'http://localhost',
  });
  return {
    harness,
    handler: (request) => Promise.resolve(handler(request)),
    advance: (milliseconds) => {
      offset += milliseconds;
    },
  };
}

let counter = 0;
function message(text: string, extra: Json = {}): Json {
  counter += 1;
  return { messageId: `t-${counter}`, role: 'ROLE_USER', parts: [{ text }], ...extra };
}

function rpc(served: Served, method: string, params: Json): Promise<Response> {
  return served.handler(
    new Request('http://localhost/a2a/writer', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'A2A-Version': '1.0',
        'X-API-Key': 'alice-key',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }),
  );
}

async function call(served: Served, method: string, params: Json): Promise<Json> {
  const response = await rpc(served, method, params);
  return response.json();
}

/** The task a send answered with. */
async function sent(served: Served, sentMessage: Json): Promise<Json> {
  const body = await call(served, 'SendMessage', { message: sentMessage });
  return body.result.task;
}

/** A task as `GetTask` reads it. */
async function got(served: Served, id: string): Promise<Json> {
  const body = await call(served, 'GetTask', { id });
  return body.result;
}

async function card(served: Served): Promise<number> {
  const response = await served.handler(
    new Request('http://localhost/a2a/writer/.well-known/agent-card.json'),
  );
  return response.status;
}

async function withdraw(served: Served): Promise<void> {
  const { bureau } = served.harness;
  const hash = bureau.agents.list().find((agent) => agent.id === 'writer')?.definitionHash;
  if (hash === undefined) throw new Error('expected the writer’s file');
  await bureau.agents.withdraw('writer', { expectedHash: hash });
  await bureau.agents.refresh();
  expect(bureau.agents.list().some((agent) => agent.id === 'writer' && !agent.published)).toBe(
    true,
  );
}

async function settles(served: Served, id: string, state: string): Promise<void> {
  await waitForCondition(async () => {
    const task = await got(served, id);
    return task.status.state === state;
  }, `task ${id} never reached ${state}`);
}

describe('a withdrawn agent with tasks', () => {
  it('serves its remaining tasks, with no card and no new task', async () => {
    const served = await serveWriter();
    const parked = await sent(served, message('park here'));
    const finished = await sent(served, message('quick'));
    expect(parked.status.state).toBe('TASK_STATE_INPUT_REQUIRED');
    expect(finished.status.state).toBe('TASK_STATE_COMPLETED');

    await withdraw(served);

    expect(await card(served)).toBe(404);
    const kept = await got(served, finished.id);
    expect(kept.id).toBe(finished.id);
    const subscribed = await rpc(served, 'SubscribeToTask', { id: parked.id });
    expect(subscribed.headers.get('content-type')).toContain('text/event-stream');
    const reader = subscribed.body!.getReader();
    const first = await reader.read();
    await reader.cancel();
    expect(new TextDecoder().decode(first.value)).toContain(parked.id);
    const refused = await call(served, 'SendMessage', { message: message('new') });
    expect(refused.error.code).toBe(-32001);
    const canceled = await call(served, 'CancelTask', { id: parked.id });
    expect(canceled.result.id).toBe(parked.id);
    await settles(served, parked.id, 'TASK_STATE_CANCELED');
  });

  it('resolves an exact retry of a send whose response was lost to its original task', async () => {
    const served = await serveWriter();
    const original = message('quick');
    const created = await sent(served, original);

    await withdraw(served);

    const retried = await sent(served, original);
    expect(retried.id).toBe(created.id);
  });

  it('completes a task that was waiting for input with a continuation', async () => {
    const served = await serveWriter();
    const parked = await sent(served, message('park here'));
    expect(parked.status.state).toBe('TASK_STATE_INPUT_REQUIRED');

    await withdraw(served);

    const answered = await sent(served, message('blue', { taskId: parked.id }));
    expect(answered.id).toBe(parked.id);
    await settles(served, parked.id, 'TASK_STATE_COMPLETED');
  });

  it('reads as not found once its last task has passed its retention', async () => {
    const served = await serveWriter();
    const finished = await sent(served, message('quick'));
    await withdraw(served);
    const kept = await got(served, finished.id);
    expect(kept.id).toBe(finished.id);

    served.advance(31 * 86_400_000);
    // The first pass expires the task's creation binding, which holds the task; the second removes it.
    await served.harness.bureau.runDurableMaintenance();
    await served.harness.bureau.runDurableMaintenance();

    const response = await rpc(served, 'GetTask', { id: finished.id });
    expect(response.status).toBe(404);
  });

  it('reads as not found when it was withdrawn with no task', async () => {
    const served = await serveWriter();
    expect(await card(served)).toBe(200);
    await withdraw(served);
    expect(await card(served)).toBe(404);
    const response = await rpc(served, 'GetTask', { id: 'anything' });
    expect(response.status).toBe(404);
  });

  it('reads as not found when its only tasks never came through A2A', async () => {
    const served = await serveWriter();
    const run = await served.harness.bureau.createRun({
      agentName: 'writer',
      principal: 'api-key:alice',
      message: 'quick',
    });
    await waitForCondition(async () => {
      const view = await served.harness.bureau.tasks.get(run.id);
      return view?.status === 'completed';
    }, 'the run never completed');
    await withdraw(served);

    // A task another surface made is not A2A's to serve, so no tombstone is kept for it.
    const response = await rpc(served, 'GetTask', { id: run.id });
    expect(response.status).toBe(404);
  });
});
