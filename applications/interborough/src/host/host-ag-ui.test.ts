import { createAgent, createScriptedGenerate, stopWhen } from '@lostgradient/operative';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startHost, type Host } from './host.ts';

const directories: string[] = [];
const hosts: Host[] = [];

const extraAgent = createAgent({
  name: 'extra',
  description: 'An agent a test brought.',
  generate: createScriptedGenerate([
    { kind: 'respond', response: { content: 'Hello from the extra agent.', toolCalls: [] } },
  ]),
  stopWhen: stopWhen.noToolCalls(),
});

async function start(options: Parameters<typeof startHost>[0] = {}): Promise<Host> {
  const home = await mkdtemp(join(tmpdir(), 'interborough-ag-ui-'));
  directories.push(home);
  const host = await startHost({ environment: { INTERBOROUGH_HOME: home }, port: 0, ...options });
  hosts.push(host);
  return host;
}

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

/** The event types of the stream a run answers with, read to its end. */
async function runEventTypes(host: Host, agent: string, threadId: string): Promise<string[]> {
  const response = await fetch(new URL(`/bureau/ag-ui/agents/${agent}/run`, host.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({
      threadId,
      runId: `run-${crypto.randomUUID()}`,
      messages: [{ id: `user-${crypto.randomUUID()}`, role: 'user', content: 'Hello' }],
      tools: [],
      context: [],
      state: {},
      forwardedProps: {},
    }),
  });
  expect(response.status).toBe(200);
  const text = await response.text();
  return [...text.matchAll(/"type":"([A-Z_]+)"/g)].map((match) => match[1]!);
}

describe('the AG-UI mount', () => {
  test('streams a published seeded agent’s run under the /bureau prefix', async () => {
    const host = await start();
    const types = await runEventTypes(host, 'assistant', 'thread-assistant');
    expect(types[0]).toBe('RUN_STARTED');
    expect(types).toContain('TEXT_MESSAGE_START');
    expect(types.at(-1)).toBe('RUN_FINISHED');
  });

  test('refuses an agent that is not published as a thread that does not exist', async () => {
    const host = await start();
    const types = await runEventTypes(host, 'internal', 'thread-internal');
    expect(types).toEqual(['RUN_ERROR']);
  });
});

describe('extra agents', () => {
  test('an extra agent that is published runs over the mount', async () => {
    const host = await start({
      extraAgents: { agents: { extra: extraAgent }, published: ['extra'] },
    });
    const types = await runEventTypes(host, 'extra', 'thread-extra');
    expect(types[0]).toBe('RUN_STARTED');
    expect(types.at(-1)).toBe('RUN_FINISHED');
  });

  test('an extra agent that is not published is refused, and the seeded ones are unchanged', async () => {
    const host = await start({ extraAgents: { agents: { extra: extraAgent }, published: [] } });
    expect(await runEventTypes(host, 'extra', 'thread-hidden')).toEqual(['RUN_ERROR']);
    const seeded = await runEventTypes(host, 'assistant', 'thread-seeded');
    expect(seeded.at(-1)).toBe('RUN_FINISHED');
  });

  test('an extra agent is listed with the published ones, and the unpublished one is listed as such', async () => {
    const host = await start({
      extraAgents: { agents: { extra: extraAgent }, published: ['extra'] },
    });
    const response = await fetch(new URL('/bureau/jsonrpc', host.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'bureau.agents.list', params: {} }),
    });
    const body = (await response.json()) as {
      result: { agents: Array<{ name: string; kind: string; publishState: string }> };
    };
    const listed = body.result.agents
      .map((agent) => [agent.name, agent.kind, agent.publishState] as const)
      .toSorted(([left], [right]) => left.localeCompare(right));
    expect(listed).toEqual([
      ['assistant', 'code', 'published'],
      ['extra', 'code', 'published'],
      ['internal', 'code', 'unpublished'],
      ['request-human-input', 'code', 'published'],
      ['tool-runner', 'code', 'published'],
    ]);
  });
});

/** A `RunAgentInput` body, with whatever `extra` adds, for the thread `threadId`. */
function body(threadId: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    threadId,
    runId: `run-${crypto.randomUUID()}`,
    messages: [{ id: `user-${crypto.randomUUID()}`, role: 'user', content: 'Refund order-1001' }],
    tools: [],
    context: [],
    state: {},
    forwardedProps: {},
    ...extra,
  });
}

async function streamOf(host: Host, agent: string, text: string): Promise<string> {
  const response = await fetch(new URL(`/bureau/ag-ui/agents/${agent}/run`, host.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: text,
  });
  return response.text();
}

const interruptOf = (stream: string): string =>
  /"interrupts":\[\{"id":"([^"]+)"/.exec(stream)?.[1] ?? '';

describe('the tool-runner approval over the mount', () => {
  test('approving the refund runs a run that reports it, and a later turn raises its own approval', async () => {
    const host = await start();
    const first = await streamOf(host, 'tool-runner', body('thread-refund'));
    expect(first).toContain('"type":"interrupt"');

    const approved = await streamOf(
      host,
      'tool-runner',
      body('thread-refund', {
        messages: [],
        resume: [
          { interruptId: interruptOf(first), status: 'resolved', payload: { decision: 'approve' } },
        ],
      }),
    );
    expect(approved).toContain('Order order-1001 was refunded.');
    expect(approved).toContain('"type":"success"');

    // The next turn's calls are its own: a call identifier names one call in a conversation.
    const next = await streamOf(host, 'tool-runner', body('thread-refund'));
    expect(next).toContain('"type":"interrupt"');
    expect(next).toContain('seeded-issue-refund-2');
  });

  test('denying the refund reports that it was not issued', async () => {
    const host = await start();
    const first = await streamOf(host, 'tool-runner', body('thread-denied'));

    const denied = await streamOf(
      host,
      'tool-runner',
      body('thread-denied', {
        messages: [],
        resume: [
          { interruptId: interruptOf(first), status: 'resolved', payload: { decision: 'deny' } },
        ],
      }),
    );

    expect(denied).toContain('The refund of order order-1001 was not issued.');
  });
});

describe('the request-human-input question over the mount', () => {
  test('answering it finishes the run, and a later turn asks its own question', async () => {
    const host = await start();
    const first = await streamOf(host, 'request-human-input', body('thread-question'));
    expect(first).toContain('"reason":"human-wait"');

    const answered = await streamOf(
      host,
      'request-human-input',
      body('thread-question', {
        messages: [],
        resume: [
          {
            interruptId: interruptOf(first),
            status: 'resolved',
            payload: { decision: 'approve', answer: 'staging' },
          },
        ],
      }),
    );
    expect(answered).toContain('"type":"success"');

    // The next turn's call is its own: a call identifier names one call in a conversation, and a
    // run that repeated the first one's would fail without ever ending its stream.
    const next = await streamOf(host, 'request-human-input', body('thread-question'));
    expect(next).toContain('"reason":"human-wait"');
  });
});
