/**
 * COR-2019 — `POST /api/chats/{chat}/messages` waits its turn like a message sent from Chat does.
 * Chat starts a turn under the chat's thread lease and refuses while a run is live on it (COR-1580,
 * COR-1588); the API starts its turn through the same admission. These tests run a real host and a
 * real Bureau, with an agent whose turn waits on a barrier, so a turn is genuinely in progress.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { waitUntil } from '@lostgradient/testing/wait-until';

import {
  BARRIER_AGENT_NAME,
  BARRIER_FIRST_REPLY,
  createBarrier,
  createBarrierAgents,
  type Barrier,
} from '../../tests/e2e/barrier-agent.ts';
import { startHost, type Host } from './host.ts';

const directories: string[] = [];
const hosts: Host[] = [];

async function start(barrier: Barrier): Promise<Host> {
  const home = await mkdtemp(join(tmpdir(), 'interborough-chat-messages-'));
  directories.push(home);
  const host = await startHost({
    environment: { INTERBOROUGH_HOME: home },
    port: 0,
    extraAgents: { agents: createBarrierAgents(barrier) },
  });
  hosts.push(host);
  return host;
}

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

/** Starts a turn from Chat's own send path and returns the stream's text once it has ended. */
function startFromChat(host: Host, threadId: string): Promise<string> {
  return fetch(new URL(`/bureau/ag-ui/agents/${BARRIER_AGENT_NAME}/run`, host.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({
      threadId,
      runId: `run-${crypto.randomUUID()}`,
      messages: [{ id: 'opener', role: 'user', content: 'Start' }],
      tools: [],
      context: [],
      state: {},
      forwardedProps: {},
    }),
  }).then((response) => response.text());
}

function sendMessage(host: Host, chat: string, text: string): Promise<Response> {
  return fetch(new URL(`/api/chats/${chat}/messages`, host.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  });
}

async function lastRunIdOf(host: Host, chat: string): Promise<unknown> {
  const session = await host.bureau.contexts.get(chat);
  return session?.metadata['lastRunId'];
}

async function runsOf(host: Host, chat: string): Promise<readonly string[]> {
  const page = await host.bureau.tasks.list({
    principal: 'anonymous:local',
    contextId: chat,
    limit: 50,
  });
  return page.tasks.map((task) => task.id).sort();
}

describe('POST /api/chats/{chat}/messages', () => {
  test('is refused with 409 while the chat has a turn in progress, and starts no second run', async () => {
    const barrier = createBarrier();
    const host = await start(barrier);
    const running = startFromChat(host, 'chat-busy');
    await waitUntil(() => barrier.waiting() === 1, { message: 'the first turn is waiting' });
    const runBefore = await lastRunIdOf(host, 'chat-busy');
    const runsBefore = await runsOf(host, 'chat-busy');
    expect(typeof runBefore).toBe('string');
    expect(runsBefore).toHaveLength(1);

    const response = await sendMessage(host, 'chat-busy', 'Is anyone there?');

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'conflict' });
    expect(barrier.waiting()).toBe(1);
    expect(await lastRunIdOf(host, 'chat-busy')).toBe(runBefore);
    expect(await runsOf(host, 'chat-busy')).toEqual(runsBefore);

    barrier.release();
    expect(await running).toContain(BARRIER_FIRST_REPLY);
    expect(await lastRunIdOf(host, 'chat-busy')).toBe(runBefore);
  });

  test('starts a turn on an idle chat, and answers the run that answers it', async () => {
    const barrier = createBarrier();
    const host = await start(barrier);
    const first = startFromChat(host, 'chat-idle');
    await waitUntil(() => barrier.waiting() === 1, { message: 'the first turn is waiting' });
    barrier.release();
    await first;
    const settledRun = await lastRunIdOf(host, 'chat-idle');
    await waitUntil(
      async () => {
        const session = await host.bureau.contexts.get('chat-idle');
        return session?.metadata['lastRunStatus'] !== 'running';
      },
      { message: 'the first turn has settled' },
    );

    const response = await sendMessage(host, 'chat-idle', 'And another thing.');

    expect(response.status).toBe(201);
    const body = (await response.json()) as { chat: string; run: string };
    expect(body.chat).toBe('chat-idle');
    expect(body.run).not.toBe(settledRun);
    expect(await lastRunIdOf(host, 'chat-idle')).toBe(body.run);
    await waitUntil(() => barrier.waiting() === 1, { message: 'the second turn is waiting' });
    barrier.release();
  });
});
