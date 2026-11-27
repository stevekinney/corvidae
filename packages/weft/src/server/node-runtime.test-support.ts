import assert from 'node:assert/strict';
import test from 'node:test';

import { parseServerSentEventChunk } from '@lostgradient/backchannel/client';
import { MemoryStorage } from '@lostgradient/storage';
import { Engine } from '../core/engine.ts';
import { activity, workflow, type WorkflowContext } from '../core/types.ts';
import { nodeServerHost } from '../node-host.ts';
import { RemoteWorker } from '../worker/index.ts';
import { serve } from './index.ts';

async function replayEvents(url: string): Promise<string[]> {
  const response = await fetch(url, { headers: { Accept: 'text/event-stream' } });
  assert.equal(response.status, 200);
  const body = response.body;
  if (body === null) throw new Error('expected SSE response body');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const kinds: string[] = [];
  let remainder = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return kinds;
      const parsed = parseServerSentEventChunk(
        decoder.decode(chunk.value, { stream: true }),
        remainder,
      );
      remainder = parsed.remainder;
      for (const frame of parsed.frames) {
        if (frame.event === 'ping') continue;
        const payload: unknown = JSON.parse(frame.data);
        if (typeof payload !== 'object' || payload === null || !('kind' in payload)) continue;
        if (typeof payload.kind !== 'string') continue;
        kinds.push(payload.kind);
        if (payload.kind === 'workflow:completed') return kinds;
      }
    }
  } finally {
    await reader.cancel();
  }
}

void test('Weft serves REST, worker activity, events, MCP, and clean shutdown through Node', async () => {
  using engine = new Engine({
    storage: new MemoryStorage(),
    activityExecution: { mode: 'remote' },
  });
  engine.register(
    workflow({ name: 'node-echo' }).execute(async function* (_context, input) {
      return input;
    }),
  );
  const echoActivity = activity({
    name: 'node-remote-echo',
    execute: async (_input: string): Promise<never> => {
      throw new Error('Node fixture must execute this activity on the remote worker');
    },
  });
  engine.register(
    workflow({ name: 'node-remote-workflow' })
      .activities({ 'node-remote-echo': echoActivity })
      .execute(async function* (context: WorkflowContext, input: string) {
        return yield* context.run(echoActivity, input);
      }),
  );
  const server = serve({ host: nodeServerHost, engine, port: 0, unauthenticatedAccess: 'allow' });
  let worker: RemoteWorker | undefined;
  try {
    await server.ready;
    assert.notEqual(server.port, 0);
    const started = await fetch(`${server.url}/v1/workflows`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'node-echo', input: { answer: 42 } }),
    });
    assert.equal(started.status, 201);
    const { id } = (await started.json()) as { id: string };
    const result = await fetch(`${server.url}/v1/workflows/${id}/result`);
    assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), { result: { answer: 42 } });
    const events = await replayEvents(`${server.url}/v1/workflows/${id}/events/sse`);
    assert.equal(events[0], 'workflow:started');
    assert.equal(events.at(-1), 'workflow:completed');

    worker = new RemoteWorker({
      serverUrl: `${server.url.replace(/^http/, 'ws')}/v1/tasks/default/stream`,
      workerId: 'node-runtime-worker',
      deploymentName: 'node-runtime',
      buildId: 'node-runtime-build',
      workflows: {
        'node-remote-workflow': {
          name: 'node-remote-workflow',
          activities: { 'node-remote-echo': async (input) => `remote:${String(input)}` },
        },
      },
      concurrency: 1,
    });
    await worker.connect();
    assert.notEqual(server.registry.getWorker('node-runtime-worker'), undefined);
    const remoteStarted = await fetch(`${server.url}/v1/workflows`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'node-remote-workflow', input: 'activity' }),
    });
    assert.equal(remoteStarted.status, 201);
    const { id: remoteId } = (await remoteStarted.json()) as { id: string };
    const remoteResult = await fetch(`${server.url}/v1/workflows/${remoteId}/result`);
    assert.equal(remoteResult.status, 200);
    assert.deepEqual(await remoteResult.json(), { result: 'remote:activity' });

    const tools = await fetch(`${server.url}/mcp`, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'Mcp-Protocol-Version': '2025-11-25',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'tools', method: 'tools/list', params: {} }),
    });
    assert.equal(tools.status, 200);
    const toolsText = await tools.text();
    const payload = toolsText.split('\n').find((line) => line.startsWith('data: '));
    assert.ok(payload);
    assert.ok(
      Array.isArray(
        (JSON.parse(payload.slice('data: '.length)) as { result: { tools: unknown[] } }).result
          .tools,
      ),
    );
  } finally {
    await worker?.disconnect();
    await server.stop();
  }
});
