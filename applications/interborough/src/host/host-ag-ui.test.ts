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
    expect((await runEventTypes(host, 'assistant', 'thread-seeded')).at(-1)).toBe('RUN_FINISHED');
  });

  test('an extra agent is listed with the published ones', async () => {
    const host = await start({
      extraAgents: { agents: { extra: extraAgent }, published: ['extra'] },
    });
    const response = await fetch(new URL('/bureau/jsonrpc', host.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'bureau.agents.list', params: {} }),
    });
    const body = (await response.json()) as { result: { agents: Array<{ name: string }> } };
    expect(body.result.agents.map((agent) => agent.name).toSorted()).toEqual([
      'assistant',
      'extra',
      'request-human-input',
      'tool-runner',
    ]);
  });
});
