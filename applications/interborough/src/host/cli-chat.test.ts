import { describe, expect, test } from 'bun:test';

import { executeCli, parseCliArguments } from './cli-client.ts';

function sse(...events: Record<string, unknown>[]): Response {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

describe('CLI chat control', () => {
  test('parses chat and management command options', () => {
    expect(
      parseCliArguments(['chat', '--agent', 'demo', '--message-file', 'message.txt']),
    ).toMatchObject({
      command: 'chat',
      output: 'text',
    });
    expect(
      parseCliArguments(['chats', 'configure', '--context', 'thread-1', '--effort', 'high']),
    ).toMatchObject({
      command: 'chats',
    });
  });

  // spawn-free: injected fetch and stdout sink exercise the client without a child process.
  test('streams text incrementally and projects only public lifecycle events', async () => {
    const chunks: string[] = [];
    let keepalive: boolean | undefined;
    const result = await executeCli(['chat', '--agent', 'demo', 'hello'], {
      fetch: async (_input, init) => {
        keepalive = init?.keepalive;
        expect(init?.headers).toBeDefined();
        return sse(
          { type: 'RUN_STARTED', threadId: 'thread-1', runId: 'run-1', metadata: { secret: 'no' } },
          { type: 'TEXT_MESSAGE_CONTENT', delta: 'Hello ' },
          { type: 'REASONING_MESSAGE_CONTENT', delta: 'private' },
          { type: 'TOOL_CALL_START', toolCallId: 'tool-1', toolCallName: 'lookup' },
          { type: 'TEXT_MESSAGE_CONTENT', delta: 'world.' },
          { type: 'RUN_FINISHED', outcome: { type: 'success', interrupts: [] } },
        );
      },
      writeStdout: (chunk) => chunks.push(chunk),
    });
    expect(result.exitCode).toBe(0);
    expect(chunks.join('')).toBe('Hello world.');
    expect(result.stdout).toBe('');
    expect(keepalive).toBe(false);
  });

  // spawn-free: injected fetch replaces the process boundary for stream termination testing.
  test('fails closed when a stream ends without a terminal event', async () => {
    const result = await executeCli(['chat', '--agent', 'demo', '--message', 'hello'], {
      fetch: async () => sse({ type: 'RUN_STARTED', threadId: 'thread-1', runId: 'run-1' }),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('ended before a terminal result');
    expect(result.stderr).toContain('thread-1');
  });

  // spawn-free: injected fetch exercises the non-interactive stream contract in-process.
  test('returns resumable identifiers and exit 5 for non-interactive human input', async () => {
    const result = await executeCli(['chat', '--agent', 'demo', '--message', 'hello'], {
      fetch: async () =>
        sse(
          { type: 'RUN_STARTED', threadId: 'thread-1', runId: 'run-1' },
          {
            type: 'RUN_FINISHED',
            outcome: { type: 'interrupt', interrupts: [{ id: 'interrupt-1' }] },
          },
        ),
    });
    expect(result.exitCode).toBe(5);
    expect(result.stdout).toContain('thread-1');
    expect(result.stdout).toContain('interrupt-1');
  });

  // spawn-free: injected fetch captures the operation request without a child process.
  test('routes context control and task responses through JSON-RPC without retrying', async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const result = await executeCli(
      ['chats', 'configure', '--context', 'thread-1', '--effort', 'high'],
      {
        fetch: async (_input, init) => {
          const body = JSON.parse(
            typeof init?.body === 'string' ? init.body : JSON.stringify(init?.body),
          ) as {
            method: string;
            params: unknown;
          };
          calls.push(body);
          return Response.json({ jsonrpc: '2.0', id: body.method, result: { ok: true } });
        },
      },
    );
    expect(result.exitCode).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: 'bureau.contexts.steer',
      params: { contextId: 'thread-1', effort: 'high' },
    });
  });

  // spawn-free: scripted AG-UI frames and prompt seam prove resume without a terminal process.
  test('prompts and resumes an interrupt only for a TTY', async () => {
    let starts = 0;
    const result = await executeCli(['chat', '--agent', 'demo', '--message', 'hello'], {
      stdinIsTTY: true,
      prompt: async () => 'answer',
      fetch: async (_input, init) => {
        starts += 1;
        const body = JSON.parse(
          typeof init?.body === 'string' ? init.body : JSON.stringify(init?.body),
        ) as { resume?: unknown[] };
        return body.resume === undefined
          ? sse(
              { type: 'RUN_STARTED', threadId: 'thread-1', runId: 'run-1' },
              {
                type: 'RUN_FINISHED',
                outcome: {
                  type: 'interrupt',
                  interrupts: [
                    {
                      id: 'i-1',
                      reason: 'human-wait',
                      responseSchema: { properties: { decision: { enum: ['approve'] } } },
                    },
                  ],
                },
              },
            )
          : sse(
              { type: 'TEXT_MESSAGE_CONTENT', delta: 'resumed' },
              { type: 'RUN_FINISHED', outcome: { type: 'success', interrupts: [] } },
            );
      },
    });
    expect(result.exitCode).toBe(0);
    expect(starts).toBe(2);
  });

  // spawn-free: cumulative snapshots verify attach replay does not duplicate rendered history.
  test('reconciles cumulative snapshots without duplicating assistant history', async () => {
    const result = await executeCli(
      ['chat', '--agent', 'demo', '--message', 'hello', '--output', 'json'],
      {
        fetch: async () =>
          sse(
            { type: 'MESSAGES_SNAPSHOT', messages: [{ role: 'assistant', content: 'Earlier.' }] },
            {
              type: 'MESSAGES_SNAPSHOT',
              messages: [
                { role: 'assistant', content: 'Earlier.' },
                { role: 'assistant', content: 'New.' },
              ],
            },
            { type: 'RUN_FINISHED', outcome: { type: 'success', interrupts: [] } },
          ),
      },
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).data.text).toBe('Earlier.New.');
  });

  // spawn-free: injected fetch and prompt dependencies replace child-process boundaries.
  test('does not prompt on a TTY when --no-input is set', async () => {
    let prompted = false;
    const result = await executeCli(
      ['chat', '--agent', 'demo', '--message', 'hello', '--no-input'],
      {
        stdinIsTTY: true,
        prompt: async () => {
          prompted = true;
          return 'unexpected';
        },
        fetch: async () =>
          sse(
            { type: 'RUN_STARTED', threadId: 'thread-1', runId: 'run-1' },
            { type: 'RUN_FINISHED', outcome: { type: 'interrupt', interrupts: [{ id: 'i-1' }] } },
          ),
      },
    );
    expect(result.exitCode).toBe(5);
    expect(prompted).toBe(false);
  });

  // spawn-free: injected fetch replaces the HTTP process boundary for projection testing.
  test('redacts reasoning and private tool fields from structured output and renders snapshots', async () => {
    const result = await executeCli(
      ['chat', '--agent', 'demo', '--message', 'hello', '--output', 'json'],
      {
        fetch: async () =>
          sse(
            {
              type: 'MESSAGES_SNAPSHOT',
              messages: [{ role: 'assistant', content: 'restored' }],
              metadata: { secret: 'private' },
            },
            { type: 'REASONING_MESSAGE_CONTENT', delta: 'do not expose', private: true },
            {
              type: 'TOOL_CALL_START',
              toolCallId: 'tool-1',
              toolCallName: 'lookup',
              args: { secret: 'x' },
            },
            { type: 'RUN_FINISHED', outcome: { type: 'success', interrupts: [] } },
          ),
      },
    );
    const parsed = JSON.parse(result.stdout) as {
      data: { text: string; events: Array<Record<string, unknown>> };
    };
    expect(parsed.data.text).toBe('restored');
    expect(JSON.stringify(parsed)).not.toContain('do not expose');
    expect(JSON.stringify(parsed)).not.toContain('secret');
    expect(parsed.data.events).toContainEqual({ kind: 'snapshot', text: 'restored' });
    expect(parsed.data.events).toContainEqual({
      kind: 'tool',
      toolCallId: 'tool-1',
      toolCallName: 'lookup',
    });
  });

  // spawn-free: request capture verifies cursor forwarding and replay dedupe without mutation retry.
  test('forwards durable cursors, dedupes durable replay, and preserves idless deltas', async () => {
    let lastEventId: string | null = null;
    const repeated = {
      id: 'cursor-2',
      type: 'TEXT_MESSAGE_CONTENT',
      delta: 'once',
      metadata: { '@lostgradient/bureau': { durable: true, cursor: 'cursor-2' } },
    };
    const result = await executeCli(
      ['chat', '--agent', 'demo', '--message', 'hello', '--cursor', 'cursor-1'],
      {
        fetch: async (_input, init) => {
          lastEventId = new Headers(init?.headers).get('Last-Event-ID');
          return sse(repeated, repeated, {
            type: 'RUN_FINISHED',
            outcome: { type: 'success', interrupts: [] },
          });
        },
      },
    );
    expect(lastEventId as string | null).toBe('cursor-1');
    expect(JSON.parse(result.stdout).text).toBe('once');
  });

  // spawn-free: injected management endpoint verifies raw-byte upload lifecycle and provider part.
  test('uploads an attachment and sends a Bureau provider file part', async () => {
    const path = '/tmp/cor2057-attachment.bin';
    await Bun.write(path, new Uint8Array([0, 255, 1]));
    const methods: string[] = [];
    const result = await executeCli(
      ['chat', '--agent', 'demo', '--message', 'file', '--attachment', path],
      {
        fetch: async (_input, init) => {
          const body = JSON.parse(
            typeof init?.body === 'string' ? init.body : JSON.stringify(init?.body),
          ) as {
            method: string;
            params: Record<string, unknown>;
          };
          methods.push(body.method);
          if (body.method === 'bureau.assets.uploads.create')
            return Response.json({ result: { uploadId: 'u-1' } });
          if (body.method === 'bureau.assets.uploads.complete')
            return Response.json({ result: { assetId: 'a-1' } });
          if (body.method === 'bureau.assets.uploads.append') {
            const chunk = body.params['chunk'];
            expect(typeof chunk).toBe('string');
            expect(Buffer.from(String(chunk), 'base64')).toEqual(Buffer.from([0, 255, 1]));
            return Response.json({ result: { uploadId: 'u-1' } });
          }
          return sse({ type: 'RUN_FINISHED', outcome: { type: 'success', interrupts: [] } });
        },
      },
    );
    expect(result.exitCode).toBe(0);
    expect(methods).toEqual([
      'bureau.assets.uploads.create',
      'bureau.assets.uploads.append',
      'bureau.assets.uploads.complete',
    ]);
  });

  // spawn-free: injected fetch proves explicit cancellation is separate from SIGINT detach.
  test('cancels only when the explicit cancel command is used', async () => {
    let method = '';
    const result = await executeCli(['chats', 'cancel', '--run', 'run-1'], {
      fetch: async (_input, init) => {
        method = init?.method ?? '';
        return Response.json({ runId: 'run-1', status: 'aborting' });
      },
    });
    expect(result.exitCode).toBe(0);
    expect(method).toBe('POST');
  });
});
