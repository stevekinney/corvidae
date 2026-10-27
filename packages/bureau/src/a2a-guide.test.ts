/**
 * COR-1241 — the executable copy of the A2A example in this package's README ("A2A").
 *
 * The example runs as written. `./index` stands in for `@lostgradient/bureau`, the handler is
 * called in process in place of a network, and `console` is a recorder, so each `console.log` is
 * a value the test asserts. A guard test compares the function's body with the README's code
 * block, so the two cannot drift: change the example and the documentation together.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { type Message, Role, TaskState } from '@a2a-js/sdk';
import {
  ClientFactory,
  ClientFactoryOptions,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
} from '@a2a-js/sdk/client';
import { createAgent, waitForCondition, type GenerateFunction } from '@lostgradient/operative';
import { principalFromApiKey } from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import { createBureau, createBureauHandler, createMemoryAssetStorage } from './index';

/** What the example's `console` records, in order. */
type Recorder = { log(...values: unknown[]): void };

// The README's example, from its `const publicUrl` line down.
async function example(console: Recorder): Promise<void> {
  const publicUrl = 'https://agents.example.com';

  // Two agents. `summarizer` answers at once; `watcher` runs until somebody cancels it.
  const summarize: GenerateFunction = async () => ({ content: 'Three findings.', toolCalls: [] });
  const watch: GenerateFunction = ({ signal }) =>
    new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new Error('canceled')), { once: true });
    });
  const bureau = await createBureau({
    id: 'acme', // required once the handler serves persistent storage
    agents: {
      summarizer: createAgent({
        name: 'summarizer',
        description: 'Summarizes a document.',
        generate: summarize,
      }),
      watcher: createAgent({ name: 'watcher', description: 'Watches a feed.', generate: watch }),
      private: createAgent({ name: 'private', generate: summarize }),
    },
    storage: { type: 'memory' },
    durable: true, // A2A needs a durable engine: every send creates its task through it
    assets: { storage: createMemoryAssetStorage() },
  });

  // The `publish` allowlist is the only thing that makes a code-defined agent visible. `private`
  // is not on it, so it has no card and starts no task.
  const handler = createBureauHandler(bureau, {
    publish: ['summarizer', 'watcher'],
    publicUrl, // mounts A2A at <publicUrl>/a2a/<name>
    authentication: {
      auditSink: () => undefined,
      resolveApiKeyPrincipal: async (key) =>
        key === 'alice-key' ? principalFromApiKey({ subject: 'alice', scopes: [] }) : null,
    },
  });

  // Discover: a card is public. Fetching it needs no credentials, and a withdrawn agent has none.
  const cardUrl = `${publicUrl}/a2a/summarizer/.well-known/agent-card.json`;
  const publicCard = await handler(new Request(cardUrl));
  console.log(publicCard.status); // 200
  const hiddenUrl = `${publicUrl}/a2a/private/.well-known/agent-card.json`;
  const hiddenCard = await handler(new Request(hiddenUrl));
  console.log(hiddenCard.status); // 404

  // The consumer is the official A2A client, with its requests routed to the handler in process
  // and the API key on each one. Over a network this is just `ClientFactory` with its defaults.
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set('X-API-Key', 'alice-key');
    return handler(new Request(input, { ...init, headers }));
  }) as typeof fetch;
  const factory = new ClientFactory(
    ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
      transports: [new JsonRpcTransportFactory({ fetchImpl })],
      cardResolver: new DefaultAgentCardResolver({ fetchImpl }),
    }),
  );
  const summarizer = await factory.createFromUrl(`${publicUrl}/a2a/summarizer/`);
  const card = await summarizer.getAgentCard();
  console.log(card.capabilities?.streaming); // true
  console.log(card.capabilities?.pushNotifications); // false: no outbox is composed
  console.log(card.capabilities?.extendedAgentCard); // false

  // Send: a message becomes a task. A Bureau send answers with a Task, never a bare Message.
  const userMessage = (text: string): Message => ({
    messageId: crypto.randomUUID(), // a retry with the same id returns the original task
    contextId: '',
    taskId: '',
    role: Role.ROLE_USER,
    parts: [
      {
        content: { $case: 'text', value: text },
        metadata: undefined,
        filename: '',
        mediaType: 'text/plain',
      },
    ],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  });
  const send = (text: string, returnImmediately: boolean) => ({
    tenant: '',
    message: userMessage(text),
    configuration: {
      acceptedOutputModes: [],
      taskPushNotificationConfig: undefined,
      returnImmediately, // false waits for the task to settle or stop for input
    },
    metadata: undefined,
  });
  const reply = await summarizer.sendMessage(send('Summarize the quarterly report.', false));
  if (!('status' in reply)) throw new Error('a Bureau send answers with a task');
  console.log(TaskState[reply.status?.state ?? 0]); // 'TASK_STATE_COMPLETED'
  console.log(reply.artifacts[0]?.parts[0]?.content); // { $case: 'text', value: 'Three findings.' }

  // Observe: read the task again, and list the caller's tasks with this agent.
  const fetched = await summarizer.getTask({ tenant: '', id: reply.id });
  console.log(TaskState[fetched.status?.state ?? 0]); // 'TASK_STATE_COMPLETED'
  const listed = await summarizer.listTasks({
    tenant: '',
    contextId: '', // empty filters match everything
    status: TaskState.TASK_STATE_UNSPECIFIED, // no state filter
    pageToken: '',
    statusTimestampAfter: undefined,
  });
  console.log(listed.tasks.some((task) => task.id === reply.id)); // true

  // Stream: the stream opens with the task, then carries only later events, and ends when the task
  // is terminal. Dropping a stream never cancels the task.
  const events: string[] = [];
  for await (const event of summarizer.sendMessageStream(send('Again, as a stream.', false))) {
    const payload = event.payload;
    events.push(payload?.$case === 'statusUpdate' ? 'status' : (payload?.$case ?? 'none'));
  }
  console.log(events[0]); // 'task'

  // Cancel: ask for a task that keeps running, wait for it to start, then cancel it.
  const watcher = await factory.createFromUrl(`${publicUrl}/a2a/watcher/`);
  const running = await watcher.sendMessage(send('Watch the feed.', true));
  if (!('status' in running)) throw new Error('a Bureau send answers with a task');
  await waitForCondition(() => bureau.getRun(running.id)?.status === 'running', 'it never ran');
  await watcher.cancelTask({ tenant: '', id: running.id, metadata: undefined });
  await waitForCondition(async () => {
    const task = await watcher.getTask({ tenant: '', id: running.id });
    return task.status?.state === TaskState.TASK_STATE_CANCELED;
  }, 'the task never read as canceled');
  console.log('canceled'); // the task is terminal once the cancel settles

  // An operation the deployment does not serve is an error, not a silent no-op.
  const extended = await handler(
    new Request(`${publicUrl}/a2a/summarizer/`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'alice-key',
        'a2a-version': '1.0',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'GetExtendedAgentCard', params: {} }),
    }),
  );
  console.log(((await extended.json()) as { error: { code: number } }).error.code); // -32004

  await bureau.dispose();
}
// End of the README's example.

/** The README's example block, as written between its code fence. */
async function readmeExample(): Promise<string> {
  const readme = await readFile(join(import.meta.dir, '..', 'README.md'), 'utf8');
  const heading = readme.indexOf('\n### A2A\n');
  expect(heading).toBeGreaterThan(-1);
  const open = readme.indexOf('```typescript\n', heading);
  const close = readme.indexOf('\n```\n', open);
  expect(open).toBeGreaterThan(-1);
  expect(close).toBeGreaterThan(open);
  return readme.slice(open + '```typescript\n'.length, close);
}

/**
 * Code reduced to what a formatter cannot change: whitespace outside string literals is removed,
 * as are the commas before a closer that a formatter adds when it wraps a line, and whitespace
 * runs in a comment become one space. A string literal is compared exactly.
 */
function normalized(code: string): string {
  const tokens =
    /('(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`)|(\/\/[^\n]*)|([^'"`/]+|\/)/g;
  let result = '';
  for (const [, quoted, comment, other] of code.matchAll(tokens)) {
    if (quoted !== undefined) result += quoted;
    else if (comment !== undefined) result += `${comment.replace(/\s+/g, ' ')}\n`;
    else result += (other ?? '').replace(/\s+/g, '').replace(/,(?=[)\]}])/g, '');
  }
  return result;
}

describe('the A2A consumer example', () => {
  it('discovers the card, sends, observes, streams, cancels, and meets an unsupported call', async () => {
    const logged: unknown[][] = [];
    await example({ log: (...values) => void logged.push(values) });

    expect(logged).toEqual([
      [200],
      [404],
      [true],
      [false],
      [false],
      ['TASK_STATE_COMPLETED'],
      [{ $case: 'text', value: 'Three findings.' }],
      ['TASK_STATE_COMPLETED'],
      [true],
      ['task'],
      ['canceled'],
      [-32004],
    ]);
  });

  it('is the code block the README shows', async () => {
    const block = await readmeExample();
    const lines = block.split('\n');
    const start = lines.findIndex((line) => line.startsWith('const publicUrl'));
    expect(start).toBeGreaterThan(-1);
    const source = await readFile(import.meta.path, 'utf8');
    const first = source.indexOf('async function example(');
    const last = source.indexOf('\n}\n// End of the README');
    expect(first).toBeGreaterThan(-1);
    expect(last).toBeGreaterThan(first);
    const body = source.slice(source.indexOf('{\n', first) + 2, last);

    expect(normalized(body)).toBe(normalized(lines.slice(start).join('\n')));
    // The README imports what the test imports, from the package and not from `./index`.
    expect(lines.slice(0, start).join('\n')).toContain("from '@lostgradient/bureau'");
  });
});
