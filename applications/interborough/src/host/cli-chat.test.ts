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
    const result = await executeCli(['chat', '--agent', 'demo', 'hello'], {
      fetch: async (_input, init) => {
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
});
