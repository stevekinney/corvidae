/**
 * A2A streams after a lost `run.completed` append (COR-1669, part 3c): the Bureau repairs the
 * history with a `task.resynced`, and `SubscribeToTask` delivers that repair as the answer's
 * artifact and the final status, then ends, exactly once.
 */
import { createAgent, type GenerateFunction } from '@lostgradient/operative';
import { afterEach, describe, expect, it } from 'bun:test';

import { waitForCondition } from '../test';
import { faultyStorage } from './a2a-faulty-storage.test-support.ts';
import { type OpenedBureau, openBureau } from './management/management-fixtures.test-support.ts';

// A JSON-RPC body read back from the wire: each test asserts the shape it needs.
type Json = any;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/** Every event of a `text/event-stream` body, as `<kind>:<detail>`, until it ends. */
async function drain(response: Response): Promise<string[]> {
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  const kinds: string[] = [];
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffered += decoder.decode(chunk.value, { stream: true });
    for (
      let boundary = buffered.indexOf('\n\n');
      boundary !== -1;
      boundary = buffered.indexOf('\n\n')
    ) {
      const lines = buffered.slice(0, boundary).split('\n');
      buffered = buffered.slice(boundary + 2);
      const data = lines.find((line) => line.startsWith('data:'));
      if (data === undefined) continue;
      const result: Json = JSON.parse(data.slice(5)).result ?? {};
      if (result.task !== undefined) kinds.push(`task:${result.task.status.state}`);
      else if (result.statusUpdate !== undefined)
        kinds.push(`status:${result.statusUpdate.status.state}`);
      else if (result.artifactUpdate !== undefined)
        kinds.push(`artifact:${result.artifactUpdate.artifact.parts[0]?.text}`);
      else kinds.push('other');
    }
  }
  return kinds;
}

function rpc(method: string, params: Json): Request {
  return new Request('http://localhost/a2a/asker', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'A2A-Version': '1.0',
      'X-API-Key': 'alice-key',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
}

describe('SubscribeToTask across a lost run.completed append', () => {
  it('delivers the repair as the answer and the final status, then ends', async () => {
    const { storage, faults } = await faultyStorage(cleanups);
    faults.failCompletions = 1;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const generate: GenerateFunction = async () => {
      await gate;
      return { content: 'repaired answer', toolCalls: [] };
    };
    const opened: OpenedBureau = await openBureau({
      agents: { asker: createAgent({ name: 'asker', generate }) },
      publish: ['asker'],
      storage,
      handlerOptions: { publicUrl: 'http://localhost' },
    });
    cleanups.push(() => opened.dispose());

    const sent = await opened.handler(
      rpc('SendMessage', {
        message: { messageId: 'm-1', role: 'ROLE_USER', parts: [{ text: 'go' }] },
        configuration: { returnImmediately: true },
      }),
    );
    const sentBody: Json = await sent.json();
    const taskId = sentBody.result.task.id;
    await waitForCondition(() => opened.bureau.getRun(taskId)?.status === 'running', 'running');

    const streaming = drain(await opened.handler(rpc('SubscribeToTask', { id: taskId })));
    release();
    const kinds = await streaming;

    expect(faults.failCompletions).toBe(0);
    expect(kinds[0]).toMatch(/^task:/);
    expect(kinds.slice(1)).toEqual(['artifact:repaired answer', 'status:TASK_STATE_COMPLETED']);
  });
});

describe('SubscribeToTask when neither the run.completed append nor its repair can land', () => {
  it('closes with a live terminal update read from the registry, rather than waiting for a history that never comes', async () => {
    const { storage, faults } = await faultyStorage(cleanups);
    faults.failCompletions = 1;
    faults.failResyncs = 1_000;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const generate: GenerateFunction = async () => {
      await gate;
      return { content: 'live answer', toolCalls: [] };
    };
    const opened: OpenedBureau = await openBureau({
      agents: { asker: createAgent({ name: 'asker', generate }) },
      publish: ['asker'],
      storage,
      handlerOptions: { publicUrl: 'http://localhost' },
    });
    cleanups.push(() => opened.dispose());
    const sent = await opened.handler(
      rpc('SendMessage', {
        message: { messageId: 'm-live', role: 'ROLE_USER', parts: [{ text: 'go' }] },
        configuration: { returnImmediately: true },
      }),
    );
    const sentBody: Json = await sent.json();
    const taskId = sentBody.result.task.id;
    await waitForCondition(() => opened.bureau.getRun(taskId)?.status === 'running', 'running');

    const streaming = drain(await opened.handler(rpc('SubscribeToTask', { id: taskId })));
    release();
    const kinds = await streaming;

    expect(kinds[0]).toMatch(/^task:/);
    expect(kinds.slice(1)).toEqual(['artifact:live answer', 'status:TASK_STATE_COMPLETED']);
  });
});
