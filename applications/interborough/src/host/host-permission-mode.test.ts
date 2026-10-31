/**
 * COR-1947 — a chat's permission mode holds for the demo plugin's `tool-runner`, a code agent
 * whose toolbox was built without any mention of a mode. The chat is opened over the AG-UI mount,
 * steered with `bureau.contexts.steer`, and the next turn is held to it. The `tool-runner` script
 * looks an order up and then refunds it, so a stream tells which of the two calls got how far.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { enableDemoPlugin } from './demo-plugin.test-support.ts';
import { startHost, type Host } from './host.ts';

const directories: string[] = [];
const hosts: Host[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function start(): Promise<Host> {
  const home = await mkdtemp(join(tmpdir(), 'interborough-permission-mode-'));
  directories.push(home);
  await enableDemoPlugin(home);
  const host = await startHost({ environment: { INTERBOROUGH_HOME: home }, port: 0 });
  hosts.push(host);
  return host;
}

async function call(host: Host, method: string, params: object): Promise<unknown> {
  const response = await fetch(new URL('/bureau/jsonrpc', host.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = (await response.json()) as { result?: unknown; error?: unknown };
  if (body.error !== undefined) throw new Error(JSON.stringify(body.error));
  return body.result;
}

async function turn(host: Host, threadId: string, extra: object = {}): Promise<string> {
  const response = await fetch(new URL('/bureau/ag-ui/agents/demo:tool-runner/run', host.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({
      threadId,
      runId: `run-${crypto.randomUUID()}`,
      messages: [{ id: `user-${crypto.randomUUID()}`, role: 'user', content: 'Refund it.' }],
      tools: [],
      context: [],
      state: {},
      forwardedProps: {},
      ...extra,
    }),
  });
  return response.text();
}

const interruptOf = (stream: string): string =>
  /"interrupts":\[\{"id":"([^"]+)"/.exec(stream)?.[1] ?? '';

/** A `tool-runner` chat steered to `permissionMode`, its first turn's refund denied and over. */
async function chatIn(host: Host, threadId: string, permissionMode: string): Promise<void> {
  const first = await turn(host, threadId);
  await turn(host, threadId, {
    messages: [],
    resume: [
      { interruptId: interruptOf(first), status: 'resolved', payload: { decision: 'deny' } },
    ],
  });
  expect(
    await call(host, 'bureau.contexts.steer', {
      contextId: threadId,
      commandId: `steer-${crypto.randomUUID()}`,
      permissionMode,
    }),
  ).toMatchObject({ outcome: 'accepted' });
}

describe('a chat’s permission mode on the demo tool-runner', () => {
  test('read-only denies the refund and lets the lookup run', async () => {
    const host = await start();
    await chatIn(host, 'thread-read-only', 'read-only');

    const stream = await turn(host, 'thread-read-only');

    expect(stream).toContain('The refund of order order-1001 was not issued.');
    expect(stream).toContain('delivered');
    expect(stream).not.toContain('"type":"interrupt"');
  });

  test('always asks about the lookup, which on-changes would run', async () => {
    const host = await start();
    await chatIn(host, 'thread-always', 'always');

    const stream = await turn(host, 'thread-always');

    expect(stream).toContain('"type":"interrupt"');
    expect(stream).toContain('lookup-order');
    expect(stream).not.toContain('issue-refund');
  });

  test('allow-all skips the ask the refund raises under on-changes', async () => {
    const host = await start();
    await chatIn(host, 'thread-allow-all', 'allow-all');

    const stream = await turn(host, 'thread-allow-all');

    expect(stream).toContain('Order order-1001 was refunded.');
    expect(stream).not.toContain('"type":"interrupt"');
  });
});
