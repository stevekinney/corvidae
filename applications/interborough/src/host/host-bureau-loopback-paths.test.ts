/**
 * COR-2169 — the local owner's `/bureau/*` paths, which carry identifiers the client
 * percent-encodes: a thread id, an agent name, a run id, an asset id. `withoutBureauPrefix` must cut
 * the `/bureau` prefix and nothing more, so an id that holds a slash, a dot or a percent sign
 * (`team/standup` is `team%2Fstandup` on the wire) reaches the Bureau as it did before the
 * public-origin guards: the refusal of an ambiguous path belongs to the public-origin guards alone.
 * The identifiers are the ones `bureau-client.ts`, `bureau-assets.ts`, `cli-chat.ts` and
 * `cli-assets.ts` encode into a `/bureau` path.
 */
import { createAgent, stopWhen } from '@lostgradient/operative';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { enableDemoPlugin } from './demo-plugin-home.ts';
import { startHost, type Host } from './host.ts';

const directories: string[] = [];
const hosts: Host[] = [];

const echo = createAgent({
  name: 'echo',
  description: 'Answers every turn.',
  generate: async () => ({ content: 'Heard you.', toolCalls: [] }),
  stopWhen: stopWhen.noToolCalls(),
});

async function start(): Promise<Host> {
  const home = await mkdtemp(join(tmpdir(), 'interborough-loopback-paths-'));
  directories.push(home);
  await enableDemoPlugin(home);
  const host = await startHost({
    environment: { INTERBOROUGH_HOME: home },
    port: 0,
    extraAgents: { agents: { echo } },
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

/** The text of the host's own refusal of a path (`host.ts`, the `/bureau/*` route). */
const REFUSAL = 'Forbidden: this path is not accepted.';

/** What a request answered, and whether it was the host's refusal of the path. */
async function send(host: Host, path: string, init: RequestInit = {}) {
  const response = await fetch(new URL(path, host.url), init);
  const text = await response.text();
  return { status: response.status, text, refused: text.startsWith(REFUSAL) };
}

/** A run of `echo` on thread `threadId`, as the CLI's `chat --thread` and the chat page send it. */
function run(host: Host, threadId: string) {
  return send(host, '/bureau/ag-ui/agents/echo/run', {
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
}

describe('a thread whose id holds a slash, on loopback', () => {
  test('is created, read and reattached through the paths the page and the CLI build', async () => {
    const host = await start();
    for (const threadId of ['standup', 'team/standup', 'rate/100%', 'a/b/c']) {
      const created = await run(host, threadId);
      expect(created.status, `create ${threadId}`).toBe(200);

      // `getThreadMessages` in bureau-client.ts.
      const read = await send(
        host,
        `/bureau/ag-ui/threads/${encodeURIComponent(threadId)}/messages`,
      );
      expect(read.refused, `read ${threadId}`).toBe(false);
      expect(read.status, `read ${threadId}`).toBe(200);
      expect(JSON.parse(read.text).threadId).toBe(threadId);

      // The CLI's `chat --thread <id> --cursor <n>` in cli-chat.ts.
      const reattached = await send(
        host,
        `/bureau/ag-ui/threads/${encodeURIComponent(threadId)}/run`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
      );
      expect(reattached.refused, `reattach ${threadId}`).toBe(false);
    }
  });

  test('reads and reattaches as the thread with no slash does: the same status for each', async () => {
    const host = await start();
    await run(host, 'standup');
    await run(host, 'team/standup');
    for (const suffix of ['messages', 'run']) {
      const init: RequestInit =
        suffix === 'run'
          ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }
          : {};
      const control = await send(host, `/bureau/ag-ui/threads/standup/${suffix}`, init);
      const slashed = await send(host, `/bureau/ag-ui/threads/team%2Fstandup/${suffix}`, init);
      expect(slashed.refused).toBe(false);
      expect(slashed.status).toBe(control.status);
    }
  });
});

describe('an identifier percent-encoded into a /bureau path is the Bureau’s to read, on loopback', () => {
  /** Each is one kind of identifier a client encodes, with a form that holds a slash, a dot or a percent sign. */
  const ROWS: ReadonlyArray<{ kind: string; method: 'GET' | 'POST'; path: string }> = [
    {
      kind: 'a thread id with an encoded slash (bureau-client.ts)',
      method: 'GET',
      path: '/bureau/ag-ui/threads/team%2Fstandup/messages',
    },
    {
      kind: 'a thread id with an encoded slash, in lower and upper case',
      method: 'GET',
      path: '/bureau/ag-ui/threads/team%2fstandup/messages',
    },
    {
      kind: 'a thread id with an encoded dot (a client that encodes it)',
      method: 'GET',
      path: '/bureau/ag-ui/threads/v1%2e2/messages',
    },
    {
      kind: 'a thread id with an encoded percent sign',
      method: 'GET',
      path: '/bureau/ag-ui/threads/rate%25100/messages',
    },
    {
      kind: 'a thread id to reattach (cli-chat.ts)',
      method: 'POST',
      path: '/bureau/ag-ui/threads/team%2Fstandup/run',
    },
    {
      kind: 'an agent name with an encoded colon and a slash (cli-chat.ts)',
      method: 'POST',
      path: '/bureau/ag-ui/agents/demo%3Ateam%2Fassistant/run',
    },
    {
      kind: 'a run id to cancel (cli-chat.ts)',
      method: 'POST',
      path: '/bureau/ag-ui/runs/team%2Fstandup/cancel',
    },
    {
      kind: 'an asset id (bureau-assets.ts, cli-assets.ts)',
      method: 'GET',
      path: '/bureau/assets/team%2Flogo/content',
    },
    {
      kind: 'an asset id with an encoded dot and percent sign',
      method: 'GET',
      path: '/bureau/assets/logo%2epng%25/content',
    },
  ];

  test.each(ROWS)('$kind: $method $path is not refused by the host', async ({ method, path }) => {
    const host = await start();
    const answer = await send(host, path, {
      method,
      ...(method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: '{}' } : {}),
    });
    expect(answer.refused).toBe(false);
    expect(answer.status === 403 && answer.text.startsWith('Forbidden:')).toBe(false);
  });

  test('a path that does not literally start with /bureau is still never handed to the Bureau', async () => {
    const host = await start();
    // The strip refuses what it cannot cut safely: nothing here starts with `/bureau/`.
    const answer = await send(host, '/bureauxyz/jsonrpc', { method: 'POST', body: '{}' });
    expect(answer.status === 200).toBe(false);
  });
});
