import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BARRIER_AGENT_NAME,
  BARRIER_FIRST_REPLY,
  BARRIER_FOLLOW_UP_REPLY,
  BARRIER_SHORT_AGENT_NAME,
  createBarrier,
  createBarrierAgents,
  type Barrier,
} from '../../tests/e2e/barrier-agent.ts';
import { startHost, type Host } from './host.ts';

const directories: string[] = [];
const hosts: Host[] = [];

async function start(barrier: Barrier): Promise<Host> {
  const home = await mkdtemp(join(tmpdir(), 'interborough-follow-up-'));
  directories.push(home);
  const host = await startHost({
    environment: { INTERBOROUGH_HOME: home },
    port: 0,
    extraAgents: {
      agents: createBarrierAgents(barrier),
      published: [BARRIER_AGENT_NAME, BARRIER_SHORT_AGENT_NAME],
    },
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

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400 && !condition(); attempt += 1) await Bun.sleep(10);
  expect(condition()).toBe(true);
}

/** Starts a run and returns the stream's text once it has ended. */
function startRun(host: Host, agent: string, threadId: string): Promise<string> {
  return fetch(new URL(`/bureau/ag-ui/agents/${agent}/run`, host.url), {
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

async function sendInput(host: Host, contextId: string, id: string) {
  const response = await fetch(new URL('/bureau/jsonrpc', host.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'bureau.contexts.input',
      params: { contextId, input: { id, payload: 'One more thing' } },
    }),
  });
  return (await response.json()) as { result?: { receipt: { state: string } } };
}

describe('a follow-up sent while a barrier run is waiting', () => {
  test('is delivered to the same run, which answers it after its first reply', async () => {
    const barrier = createBarrier();
    const host = await start(barrier);
    const run = startRun(host, BARRIER_AGENT_NAME, 'thread-delivered');
    await waitFor(() => barrier.waiting() === 1);

    const sent = await sendInput(host, 'thread-delivered', 'follow-up-1');
    barrier.release();
    const stream = await run;

    expect(sent.result?.receipt.state).toBe('accepted');
    expect(stream).toContain(BARRIER_FIRST_REPLY);
    expect(stream).toContain(BARRIER_FOLLOW_UP_REPLY);
    expect(stream.indexOf(BARRIER_FIRST_REPLY)).toBeLessThan(
      stream.indexOf(BARRIER_FOLLOW_UP_REPLY),
    );
  });

  test('is cancelled when a one-step run ends before it can be delivered', async () => {
    const barrier = createBarrier();
    const host = await start(barrier);
    const run = startRun(host, BARRIER_SHORT_AGENT_NAME, 'thread-short');
    await waitFor(() => barrier.waiting() === 1);

    const sent = await sendInput(host, 'thread-short', 'follow-up-1');
    barrier.release();
    const stream = await run;
    const session = await host.bureau.contexts.get('thread-short');

    expect(sent.result?.receipt.state).toBe('accepted');
    expect(stream).toContain(BARRIER_FIRST_REPLY);
    expect(stream).not.toContain(BARRIER_FOLLOW_UP_REPLY);
    expect(session?.conversationHistory.ids).not.toContain('follow-up-1');
  });
});
