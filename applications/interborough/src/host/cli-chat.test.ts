import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeCliWithDispatchAssertions as executeCli } from './cli-dispatch.test-support.ts';

import { parseCliArguments } from './cli-client.ts';

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

  // spawn-free: injected fetch records the operation requests without a child process.
  test('dispatches conversation reads and writes once with the original wire fields', async () => {
    const scenarios = [
      { args: ['list'], operation: 'list', params: {} },
      { args: ['get', 'thread-1'], operation: 'get', params: { contextId: 'thread-1' } },
      {
        args: ['send', 'thread-1', '--message', 'Hello', '--input-id', 'input-1'],
        operation: 'input',
        params: { contextId: 'thread-1', input: { id: 'input-1', payload: 'Hello' } },
      },
      {
        args: ['fork', 'thread-1', '--command-id', 'fork-1'],
        operation: 'fork',
        params: { contextId: 'thread-1', commandId: 'fork-1', throughMessageId: null },
      },
      {
        args: ['rename', 'thread-1', '--title', 'New title'],
        operation: 'rename',
        params: { contextId: 'thread-1', title: 'New title' },
      },
      {
        args: ['delete', 'thread-1', '--wait', '2000', '--dry-run'],
        operation: 'delete',
        params: { contextId: 'thread-1', waitMilliseconds: 2000, dryRun: true },
      },
      {
        args: ['configure', 'thread-1', '--command-id', 'set-1', '--effort', 'high'],
        operation: 'steer',
        params: { contextId: 'thread-1', commandId: 'set-1', effort: 'high' },
      },
      {
        args: ['configure', 'thread-1', '--command-id', 'set-2', '--permission-mode', 'read-only'],
        operation: 'steer',
        params: { contextId: 'thread-1', commandId: 'set-2', permissionMode: 'read-only' },
      },
      {
        args: [
          'configure',
          'thread-1',
          '--command-id',
          'set-3',
          '--model',
          'my/model',
          '--expected-revision',
          '3',
        ],
        operation: 'steer',
        params: {
          contextId: 'thread-1',
          commandId: 'set-3',
          expectedRevision: 3,
          override: { provider: 'my', model: 'model' },
        },
      },
      {
        args: ['configure', 'thread-1', '--command-id', 'set-4', '--effort', 'invalid'],
        operation: 'steer',
        params: { contextId: 'thread-1', commandId: 'set-4', effort: 'invalid' },
        invalid: true,
      },
    ];
    for (const { args, operation, params, invalid } of scenarios) {
      const calls: unknown[] = [];
      const result = await executeCli(['chats', ...args], {
        fetch: async (_input, init) => {
          if (typeof init?.body !== 'string') throw new Error('Expected a JSON-RPC request.');
          calls.push(JSON.parse(init.body));
          return invalid
            ? Response.json({ error: { code: -32_602, message: 'Bureau rejected the effort.' } })
            : Response.json({ result: { ok: true } });
        },
      });
      expect(calls, args.join(' ')).toHaveLength(1);
      expect(calls[0]).toMatchObject({ method: `bureau.contexts.${operation}` });
      expect(calls[0]).toHaveProperty('params', params);
      expect(result.exitCode, args.join(' ')).toBe(invalid ? 1 : 0);
      if (invalid) expect(result.stderr).toContain('Bureau rejected the effort.');
    }
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
  test('uploads an attachment in order and sends the completed provider file part', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'interborough-chat-attachment-'));
    const attachment = join(directory, 'attachment.bin');
    const chunkSize = 256 * 1024;
    const bytes = Buffer.alloc(chunkSize + 3, 0);
    bytes.set([255, 1, 254], chunkSize);
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    let streamInput: unknown;
    try {
      await Bun.write(attachment, bytes);
      const result = await executeCli(
        ['chat', '--agent', 'demo', '--message', 'file', '--attachment', attachment],
        {
          fetch: async (input, init) => {
            const url = new URL(input instanceof Request ? input.url : input.toString());
            const body: unknown = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
            if (url.pathname !== '/bureau/jsonrpc') {
              streamInput = body;
              return sse({ type: 'RUN_FINISHED', outcome: { type: 'success', interrupts: [] } });
            }
            const call = body as (typeof calls)[number];
            calls.push(call);
            if (call.method === 'bureau.assets.uploads.create')
              return Response.json({ result: { uploadId: 'u-1' } });
            if (call.method === 'bureau.assets.uploads.complete')
              return Response.json({ result: { assetId: 'a-1' } });
            return Response.json({ result: { uploadId: 'u-1' } });
          },
        },
      );
      expect(result.exitCode).toBe(0);
      expect(calls.map(({ method }) => method)).toEqual([
        'bureau.assets.uploads.create',
        'bureau.assets.uploads.append',
        'bureau.assets.uploads.append',
        'bureau.assets.uploads.complete',
      ]);
      expect(calls[0]?.params).toEqual({ declaredByteLength: bytes.byteLength });
      expect(
        Buffer.from(String(calls[1]?.params['chunk']), 'base64').equals(
          bytes.subarray(0, chunkSize),
        ),
      ).toBe(true);
      expect(
        Buffer.from(String(calls[2]?.params['chunk']), 'base64').equals(bytes.subarray(chunkSize)),
      ).toBe(true);
      expect(calls.slice(1).map(({ params }) => params['uploadId'])).toEqual(['u-1', 'u-1', 'u-1']);
      expect(streamInput).toMatchObject({
        messages: [
          {
            content: [
              { type: 'text', text: 'file' },
              {
                type: 'file',
                source: { type: 'file', provider: 'bureau', value: 'a-1' },
              },
            ],
          },
        ],
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  // spawn-free: the CLI runs in process with every upload and stream request supplied by the fetch double.
  test('aborts the admitted upload when an attachment append fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'interborough-chat-attachment-failure-'));
    const attachment = join(directory, 'attachment.bin');
    const methods: string[] = [];
    try {
      await Bun.write(attachment, new Uint8Array([0, 255, 1]));
      const result = await executeCli(
        ['chat', '--agent', 'demo', '--message', 'file', '--attachment', attachment],
        {
          fetch: async (input, init) => {
            const url = new URL(input instanceof Request ? input.url : input.toString());
            if (url.pathname !== '/bureau/jsonrpc') {
              methods.push(url.pathname);
              return new Response('unexpected AG-UI dispatch', { status: 500 });
            }
            const call = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
              method: string;
              params: { uploadId?: string };
            };
            methods.push(call.method);
            if (call.method === 'bureau.assets.uploads.create')
              return Response.json({ result: { uploadId: 'u-1' } });
            if (call.method === 'bureau.assets.uploads.append')
              return Response.json({
                jsonrpc: '2.0',
                id: 1,
                error: {
                  code: -32000,
                  message: 'attachment chunk was refused',
                  data: { httpStatus: 422 },
                },
              });
            expect(call.params.uploadId).toBe('u-1');
            return Response.json({ result: { aborted: true } });
          },
        },
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('attachment chunk was refused');
      expect(methods).toEqual([
        'bureau.assets.uploads.create',
        'bureau.assets.uploads.append',
        'bureau.assets.uploads.abort',
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
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
