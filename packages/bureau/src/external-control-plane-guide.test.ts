/**
 * COR-1242 — the executable copy of the external-consumer example in this package's README
 * ("External control plane"), plus checks of the limits that section and
 * `documentation/external-control-plane.md` ("Unsupported behavior and limits") say Bureau has.
 *
 * The example runs as written. `./index` stands in for `@lostgradient/bureau`, the database is a
 * temporary file, and `console` is a recorder, so each `console.log` is a value the test asserts.
 * A guard test compares the function's body with the README's code block, so the two cannot drift:
 * change the example and the documentation together.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  createAgent,
  stopWhen,
  waitForCondition,
  type GenerateFunction,
} from '@lostgradient/operative';
import { createTemporaryPath, removeTemporaryPath } from '@lostgradient/testing/temporary-path';
import { principalFromApiKey } from '@lostgradient/weft';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { createBureau, createBureauHandler, createMemoryAssetStorage } from './index';
import type { AgentDefinitions } from './agent-catalog';

let databasePath = '';

beforeEach(() => {
  // A fresh directory per test: the process id repeats across runs, so it cannot name the file.
  databasePath = createTemporaryPath('bureau-external-control-plane-guide', '.sqlite');
});

afterEach(() => {
  removeTemporaryPath(databasePath);
});

/** What the example's `console` records, in order. */
type Recorder = { log(...values: unknown[]): void };

// The README's example, from its `const databasePath` line down.
async function example(console: Recorder, databasePath: string): Promise<void> {
  // The agent asks which environment to release to, waits for the answer, then thanks the person.
  let calls = 0;
  const generate: GenerateFunction = async () => {
    calls += 1;
    if (calls > 1) return { content: 'Releasing to the environment you named.', toolCalls: [] };
    const prompt = 'Which environment should the release go to?';
    const ask = {
      id: 'ask-1',
      name: 'requestHumanInput',
      arguments: { signalName: 'environment', prompt },
    };
    return { content: '', toolCalls: [ask] };
  };
  const releaser = createAgent({
    name: 'releaser',
    generate,
    stopWhen: stopWhen.some(stopWhen.toolCalled('requestHumanInput'), stopWhen.noToolCalls()),
  });

  const bureau = await createBureau({
    id: 'acme', // required once the handler serves persistent storage
    agents: { releaser },
    storage: { type: 'sqlite', path: databasePath },
    durable: true,
    assets: { storage: createMemoryAssetStorage() }, // the handler serves the asset operations
  });

  // Authenticate: the host says which key stands for which principal. A principal with no scopes
  // owns what it creates and reaches nothing of anyone else's.
  const keys = { 'alice-key': 'alice', 'bob-key': 'bob' } as const;
  const handler = createBureauHandler(bureau, {
    publish: ['releaser'],
    authentication: {
      auditSink: () => undefined, // every authentication decision is passed here
      resolveApiKeyPrincipal: async (key) =>
        key in keys
          ? principalFromApiKey({ subject: keys[key as keyof typeof keys], scopes: [] })
          : null,
    },
  });

  // One management call, answered with its HTTP status and JSON-RPC body.
  async function call(method: string, params: object, key = 'alice-key') {
    const response = await handler(
      new Request('http://bureau.test/jsonrpc', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      }),
    );
    return { status: response.status, body: await response.json() };
  }

  const unknownKey = await call('bureau.deployment.get', {}, 'no-such-key');
  console.log(unknownKey.status); // 401

  // Discover: the deployment's identity, the agents it publishes, and the operations it serves.
  const { body: deployment } = await call('bureau.deployment.get', {});
  console.log(deployment.result.id); // 'acme'
  console.log(deployment.result.publishedAgents); // ['releaser']
  const served = deployment.result.operations.map((operation: { name: string }) => operation.name);
  console.log(served.includes('bureau.tasks.respond')); // true

  // The handler starts no run of its own except through its AG-UI mount, so the host starts this
  // one. `principal` is the owner of record: an API-key caller `alice` owns as `api-key:alice`.
  const run = await bureau.createRun({
    agentName: 'releaser',
    message: 'Release it.',
    principal: 'api-key:alice',
  });
  await waitForCondition(
    () => bureau.reviews.list().some((review) => review.runId === run.id),
    'the run did not park on its question',
  );

  // Observe: the task is Alice's, it waits on her, and to Bob it does not exist.
  const { body: waiting } = await call('bureau.tasks.get', { taskId: run.id });
  console.log(waiting.result.status); // 'input-required'
  const { body: hidden } = await call('bureau.tasks.get', { taskId: run.id }, 'bob-key');
  console.log(hidden.error.data.httpStatus); // 404

  // Command: answer the question. The `messageId` is Alice's own, so a retry is the same command.
  const answer = { taskId: run.id, messageId: 'answer-1', answer: 'staging' };
  const { body: answered } = await call('bureau.tasks.respond', answer);
  console.log(answered.result.receipt); // 'applied'
  const { body: retried } = await call('bureau.tasks.respond', answer);
  console.log(retried.result.receipt); // 'applied', the original receipt and nothing delivered twice

  // Await: the task's history ends at its terminal status, so reading the stream to its end waits
  // for the result. A cursor in `Last-Event-ID` resumes a dropped stream where it stopped.
  const query = new URLSearchParams({ taskId: run.id });
  const stream = await handler(
    new Request(`http://bureau.test/v1/subscriptions/bureau.tasks.events?${query}`, {
      headers: { accept: 'text/event-stream', 'x-api-key': 'alice-key' },
    }),
  );
  const body = await stream.text();
  const frames = body
    .split('\n\n')
    .filter((block) => block.includes('event: task.'))
    .map((block) => ({
      event: /^event: (.*)$/m.exec(block)?.[1],
      data: JSON.parse(/^data: (.*)$/m.exec(block)?.[1] ?? 'null'),
    }));
  console.log(frames[0]?.event); // 'task.snapshot'
  console.log(frames.at(-1)?.data.status); // 'completed'
  console.log(frames.at(-1)?.data.artifact.text); // 'Releasing to the environment you named.'

  console.log(calls); // 2: the retry did not run the agent a third time

  await bureau.dispose();
}
// End of the README's example.

/** The README's example block, as written between its code fence. */
async function readmeExample(): Promise<string> {
  const readme = await readFile(join(import.meta.dir, '..', 'README.md'), 'utf8');
  const heading = readme.indexOf('\n### External control plane\n');
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

describe('the external consumer example', () => {
  it('authenticates, discovers, observes, answers, and awaits the result', async () => {
    const logged: unknown[][] = [];
    await example({ log: (...values) => void logged.push(values) }, databasePath);

    expect(logged).toEqual([
      [401],
      ['acme'],
      [['releaser']],
      [true],
      ['input-required'],
      [404],
      ['applied'],
      ['applied'],
      ['task.snapshot'],
      ['completed'],
      ['Releasing to the environment you named.'],
      [2],
    ]);
  });

  it('is the code block the README shows', async () => {
    const block = await readmeExample();
    const lines = block.split('\n');
    const start = lines.findIndex((line) => line.startsWith('const databasePath'));
    expect(start).toBeGreaterThan(-1);
    const source = await readFile(import.meta.path, 'utf8');
    const first = source.indexOf('async function example(');
    const last = source.indexOf('\n}\n// End of the README');
    expect(first).toBeGreaterThan(-1);
    expect(last).toBeGreaterThan(first);
    const body = source.slice(source.indexOf('{\n', first) + 2, last);

    expect(normalized(body)).toBe(normalized(lines.slice(start + 1).join('\n')));
    // The README imports what the test imports, from the package and not from `./index`.
    expect(lines.slice(0, start).join('\n')).toContain("from '@lostgradient/bureau'");
  });
});

/** One JSON-RPC call to a handler that serves every request as the one local caller. */
async function localCall(
  handler: (request: Request) => Promise<Response>,
  method: string,
  params: object,
) {
  const response = await handler(
    new Request('http://bureau.test/jsonrpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }),
  );
  return (await response.json()) as {
    result?: Record<string, unknown>;
    error?: {
      data?: { weftCode?: string; httpStatus?: number; reason?: string; capability?: string };
    };
  };
}

/**
 * A Bureau over memory storage, served to the local caller. It has no durable engine unless
 * `durable` says so, and so no durable event history and no durable mailbox.
 */
async function servedBureau(generate: GenerateFunction, durable = false) {
  const bureau = await createBureau<AgentDefinitions>({
    id: 'served',
    agents: {
      writer: createAgent({ name: 'writer', generate }),
      default: createAgent({ generate, stopWhen: stopWhen.noToolCalls() }),
    },
    storage: { type: 'memory' },
    ...(durable ? { durable: true } : {}),
    assets: { storage: createMemoryAssetStorage() },
  });
  const handler = createBureauHandler(bureau, { unauthenticatedAccess: 'allow' });
  return { bureau, handler };
}

/** The A2A 1.0.1 core methods, none of which the handler serves. */
const A2A_METHODS = [
  'SendMessage',
  'SendStreamingMessage',
  'GetTask',
  'ListTasks',
  'CancelTask',
  'SubscribeToTask',
  'GetExtendedAgentCard',
];

const answers: GenerateFunction = async () => ({ content: 'Done.', toolCalls: [] });
/** A model that never answers, and stops waiting when its run is aborted, so shutdown is not held up. */
const never: GenerateFunction = ({ signal }) =>
  new Promise<never>((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });

describe('the limits the documentation names', () => {
  it('answers bureau.tasks.events with UnsupportedCapability when there is no persistent storage', async () => {
    const { bureau, handler } = await servedBureau(answers);
    try {
      const run = await bureau.createRun({ agentName: 'default', message: 'Hello' });
      await waitForCondition(() => bureau.tasks.detail(run.id)?.status === 'completed', 'finish');

      const stream = await handler(
        new Request(
          `http://bureau.test/v1/subscriptions/bureau.tasks.events?${new URLSearchParams({ taskId: run.id })}`,
          { headers: { accept: 'text/event-stream' } },
        ),
      );

      expect(stream.status).toBe(501);
      expect(await stream.text()).toContain('event-history');
      // The task itself is still read with bureau.tasks.get.
      const task = await localCall(handler, 'bureau.tasks.get', { taskId: run.id });
      expect(task.result?.['status']).toBe('completed');
    } finally {
      await bureau.dispose();
    }
  });

  it('answers bureau.contexts.input with Unavailable when the Bureau has no durable mailbox', async () => {
    const { bureau, handler } = await servedBureau(never);
    try {
      const run = await bureau.createRun({ agentName: 'default', message: 'Hello' });
      await waitForCondition(
        () => bureau.tasks.detail(run.id)?.status === 'running',
        'the run began',
      );

      const answer = await localCall(handler, 'bureau.contexts.input', {
        contextId: run.sessionId,
        input: { id: 'input-1', payload: 'More.' },
      });

      expect(answer.error?.data).toMatchObject({
        weftCode: 'Unavailable',
        reason: 'unsupported-capability',
      });
    } finally {
      await bureau.dispose();
    }
  });

  it('refuses a stale expectedRevision within one process, so exactly one of two racing writes wins', async () => {
    const { bureau, handler } = await servedBureau(answers, true);
    try {
      const created = await localCall(handler, 'bureau.schedules.create', {
        agentName: 'writer',
        input: 'Summarize.',
        spec: '24h',
      });
      expect(created.error).toBeUndefined();
      const scheduleId = created.result?.['id'] as string;
      const read = await localCall(handler, 'bureau.schedules.get', { scheduleId });
      const expectedRevision = read.result?.['revision'];

      const outcomes = await Promise.all([
        localCall(handler, 'bureau.schedules.pause', { scheduleId, expectedRevision }),
        localCall(handler, 'bureau.schedules.pause', { scheduleId, expectedRevision }),
      ]);

      expect(outcomes.filter((outcome) => outcome.result !== undefined)).toHaveLength(1);
      expect(
        outcomes.filter((outcome) => outcome.error?.data?.weftCode === 'StaleRevision'),
      ).toHaveLength(1);
    } finally {
      await bureau.dispose();
    }
  });

  it('serves no A2A: there is no Agent Card, and no A2A method is an operation', async () => {
    const { bureau, handler } = await servedBureau(answers);
    try {
      for (const path of [
        '/.well-known/agent-card.json',
        '/a2a/releaser',
        '/releaser/.well-known/agent-card.json',
      ]) {
        const response = await handler(new Request(`http://bureau.test${path}`));
        expect([path, response.status]).toEqual([path, 404]);
      }
      const deployment = await localCall(handler, 'bureau.deployment.get', {});
      const operations = (deployment.result?.['operations'] ?? []) as Array<{ name: string }>;
      const served = operations.map((operation) => operation.name);
      for (const method of A2A_METHODS) expect(served).not.toContain(method);
      const sent = await localCall(handler, 'SendMessage', {});
      expect(sent.error).toBeDefined();
    } finally {
      await bureau.dispose();
    }
  });
});
