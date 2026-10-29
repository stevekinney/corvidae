/**
 * COR-1490's real-provider bullet: in development, a published file agent whose model is a
 * configured provider's can be chatted with. The provider path is a fake client (a test never
 * calls a model, and holds no real key); everything between the page's request and that client is
 * the real host: the AG-UI mount honouring the file's own publish state (COR-1526), the Bureau
 * running the file agent with the key from the secrets, and the management operations the agents
 * and chat views read.
 */
import { openBungalow } from '@lostgradient/bungalow';
import { resolveProviderGenerate, type ProviderConfiguration } from '@lostgradient/bureau';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startHost, type Host, type HostOptions } from './host.ts';

const FIXTURE_KEY = 'fixture-anthropic-key-chat-77aa';
const directories: string[] = [];
const hosts: Host[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

const agentFile = (name: string, published: boolean) =>
  [
    '---',
    `name: ${name}`,
    'description: A file agent the page can chat with.',
    'model: anthropic/sonnet',
    `published: ${published}`,
    '---',
    'You are a careful researcher.',
    '',
  ].join('\n');

async function startWithFileAgents(files: Record<string, string>) {
  const home = await mkdtemp(join(tmpdir(), 'interborough-chat-file-agent-'));
  directories.push(home);
  await writeFile(
    join(home, 'configuration.json'),
    JSON.stringify({ providers: { anthropic: { models: ['sonnet'] } } }),
  );
  const bungalow = await openBungalow({
    name: 'interborough',
    environment: { INTERBOROUGH_HOME: home },
  });
  try {
    bungalow.writeSecret('anthropic-api-key', FIXTURE_KEY);
  } finally {
    bungalow.close();
  }
  await mkdir(join(home, 'agents'), { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    await writeFile(join(home, 'agents', name), text);
  }
  const handed: ProviderConfiguration[] = [];
  const client = {
    messages: {
      create: async () => ({
        id: 'message-1',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-5',
        content: [{ type: 'text', text: 'Answered by the provider.' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 3, output_tokens: 5 },
      }),
    },
  };
  const resolver: NonNullable<HostOptions['resolveProviderGenerate']> = (
    definitions,
    provider,
    streamEventTarget,
    streaming,
  ) => {
    handed.push(provider);
    return resolveProviderGenerate(
      definitions,
      Object.assign({}, provider, { client }),
      streamEventTarget,
      streaming,
    );
  };
  const host = await startHost({
    environment: { INTERBOROUGH_HOME: home },
    port: 0,
    resolveProviderGenerate: resolver,
  });
  hosts.push(host);
  return { host, handed };
}

async function chat(host: Host, agent: string, threadId: string): Promise<string> {
  const response = await fetch(new URL(`/bureau/ag-ui/agents/${agent}/run`, host.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({
      threadId,
      runId: `run-${crypto.randomUUID()}`,
      messages: [{ id: 'user-1', role: 'user', content: 'Find me a source.' }],
      tools: [],
      context: [],
      state: {},
      forwardedProps: {},
    }),
  });
  return response.text();
}

async function operation(host: Host, method: string, params: unknown) {
  const response = await fetch(new URL('/bureau/jsonrpc', host.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = (await response.json()) as { result?: Record<string, unknown> };
  if (body.result === undefined) throw new Error(`${method} answered no result.`);
  return body.result;
}

describe('chatting with a published file agent whose model is a configured provider’s', () => {
  test('streams the provider’s answer over AG-UI, with the key from the secrets', async () => {
    const { host, handed } = await startWithFileAgents({
      'researcher.md': agentFile('Researcher', true),
    });

    const stream = await chat(host, 'researcher', 'thread-file-agent');

    expect(stream).toContain('"type":"RUN_STARTED"');
    expect(stream).toContain('Answered by the provider.');
    expect(stream).toContain('"type":"RUN_FINISHED"');
    expect(handed.length).toBeGreaterThan(0);
    expect(JSON.stringify(handed)).toContain(FIXTURE_KEY);
    // The session is the agent's, so the chat views list it under that agent.
    const sessions = await operation(host, 'bureau.contexts.list', { agentName: 'researcher' });
    expect((sessions['contexts'] as Array<{ id: string }>).map((entry) => entry.id)).toEqual([
      'thread-file-agent',
    ]);
  });

  test('is listed as a published file agent, and its model is what the agent’s page shows', async () => {
    const { host } = await startWithFileAgents({ 'researcher.md': agentFile('Researcher', true) });

    const agents = await operation(host, 'bureau.agents.list', {});
    const detail = await operation(host, 'bureau.agents.definitions.get', { id: 'researcher' });

    const researcher = (agents['agents'] as Array<Record<string, unknown>>).find(
      (agent) => agent['name'] === 'researcher',
    );
    expect(researcher).toMatchObject({ kind: 'file', publishState: 'published' });
    expect(detail['definition']).toMatchObject({ model: 'anthropic/sonnet' });
  });

  test('is refused over AG-UI while its file withdraws it, and is listed as withdrawn', async () => {
    const { host } = await startWithFileAgents({ 'quiet.md': agentFile('Quiet', false) });

    const stream = await chat(host, 'quiet', 'thread-withdrawn');
    const agents = await operation(host, 'bureau.agents.list', {});

    expect(stream).toContain('"type":"RUN_ERROR"');
    expect(stream).not.toContain('Answered by the provider.');
    const quiet = (agents['agents'] as Array<Record<string, unknown>>).find(
      (agent) => agent['name'] === 'quiet',
    );
    expect(quiet).toMatchObject({ kind: 'file', publishState: 'withdrawn' });
  });
});
