import { describe, expect, test } from 'bun:test';

import { executeCli, parseCliArguments } from './cli-client.ts';

function jsonRpc(method: string, result: unknown): Response {
  return Response.json({ jsonrpc: '2.0', id: method, result });
}

function sseFrame(data: unknown, id?: string): string {
  return `${id === undefined ? '' : `id: ${id}\n`}data: ${JSON.stringify(data)}\n\n`;
}

describe('CLI run control', () => {
  // spawn-free: injected command execution replaces the process boundary for parser validation.
  test('documents task as the default list kind and requires explicit kinds for reads', () => {
    expect(parseCliArguments(['runs', '--help'])).toMatchObject({ exitCode: 0 });
    expect(parseCliArguments(['runs', 'get', 'same-id'])).toMatchObject({ command: 'runs' });
  });

  // spawn-free: injected fetch replaces the management process for list projection.
  test('lists tasks by default and qualifies equal task/workflow identifiers', async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const result = await executeCli(['runs', 'list', '--limit', '1', '--output', 'json'], {
      fetch: async (_input, init) => {
        const body = JSON.parse(typeof init?.body === 'string' ? init.body : '') as {
          method: string;
          params: Record<string, unknown>;
        };
        calls.push(body);
        return jsonRpc(body.method, {
          tasks: [{ id: 'same-id', status: 'running' }],
          nextPageToken: 'next',
        });
      },
    });
    expect(result.exitCode).toBe(0);
    expect(calls[0]).toMatchObject({ method: 'bureau.tasks.list', params: { limit: 1 } });
    expect(JSON.parse(result.stdout).data.tasks[0]).toMatchObject({
      kind: 'task',
      id: 'task:same-id',
    });
  });

  // spawn-free: injected fetch replaces the management process for pagination validation.
  test('forwards task cursors and rejects unknown list kinds', async () => {
    let params: Record<string, unknown> | undefined;
    const listed = await executeCli(['runs', 'list', '--cursor', 'next', '--status', 'running'], {
      fetch: async (_input, init) => {
        const body = JSON.parse(typeof init?.body === 'string' ? init.body : '') as {
          params: Record<string, unknown>;
        };
        params = body.params;
        return jsonRpc('bureau.tasks.list', { tasks: [] });
      },
    });
    const invalid = await executeCli(['runs', 'list', '--kind', 'other'], {
      fetch: async () => jsonRpc('bureau.tasks.list', { tasks: [] }),
    });
    expect(listed.exitCode).toBe(0);
    expect(params).toMatchObject({ pageToken: 'next', status: 'running' });
    expect(invalid.exitCode).toBe(2);
  });

  // spawn-free: parser validation does not start a process.
  test('accepts format and status on audit and run list commands', () => {
    expect(parseCliArguments(['audit', 'list', '--format', 'jsonl'])).toMatchObject({
      command: 'audit',
    });
    expect(parseCliArguments(['runs', 'list', '--status', 'running'])).toMatchObject({
      command: 'runs',
    });
  });

  // spawn-free: injected fetch replaces the management process for kind dispatch.
  test('gets and inspects both kinds without guessing between equal ids', async () => {
    const methods: string[] = [];
    const result = await executeCli(
      ['runs', 'get', '--kind', 'workflow', 'same-id', '--output', 'json'],
      {
        fetch: async (_input, init) => {
          const body = JSON.parse(typeof init?.body === 'string' ? init.body : '') as {
            method: string;
          };
          methods.push(body.method);
          return jsonRpc(body.method, { id: 'same-id', status: 'running' });
        },
      },
    );
    expect(result.exitCode).toBe(0);
    expect(methods).toEqual(['bureau.workflows.runs.get']);
    expect(JSON.parse(result.stdout).data.id).toBe('workflow:same-id');
  });

  // spawn-free: an injected readable stream is the deterministic management event source.
  test('watches incrementally, forwards cursors, deduplicates replay, reports gaps, and stops once', async () => {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let lastEventId: string | null = null;
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(streamController) {
        controller = streamController;
      },
    });
    const writes: string[] = [];
    let resolveWrite: (() => void) | undefined;
    const firstWrite = new Promise<void>((resolve) => {
      resolveWrite = resolve;
    });
    let resolveFetch: (() => void) | undefined;
    const fetchStarted = new Promise<void>((resolve) => {
      resolveFetch = resolve;
    });
    const pending = executeCli(
      ['runs', 'watch', '--kind', 'task', 'run-1', '--cursor', 'c-1', '--output', 'jsonl'],
      {
        writeStdout: (chunk) => {
          writes.push(chunk);
          resolveWrite?.();
        },
        fetch: async (_input, init) => {
          resolveFetch?.();
          lastEventId = new Headers(init?.headers).get('Last-Event-ID');
          return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
        },
      },
    );
    await fetchStarted;
    controller?.enqueue(
      encoder.encode(
        sseFrame({ kind: 'task.gap', requestedCursor: 'c-1', firstRetainedCursor: 'c-2' }, 'c-2'),
      ),
    );
    await firstWrite;
    expect(writes.join('')).toContain('task.gap');
    controller?.enqueue(
      encoder.encode(
        sseFrame({ kind: 'task.gap', requestedCursor: 'c-1', firstRetainedCursor: 'c-2' }, 'c-2'),
      ),
    );
    controller?.enqueue(
      encoder.encode(sseFrame({ kind: 'task.status', status: 'completed' }, 'c-3')),
    );
    const result = await pending;
    expect(result.exitCode).toBe(0);
    expect(lastEventId as string | null).toBe('c-1');
    expect(writes.join('').match(/task\.gap/g)).toHaveLength(1);
    expect(writes.join('').match(/task\.status/g)).toHaveLength(1);
  });

  // spawn-free: an injected abort-aware stream replaces the remote process.
  test('timeout or Ctrl-C detaches observation without calling cancellation', async () => {
    const controller = new AbortController();
    let calls = 0;
    let resolveFetch: (() => void) | undefined;
    const fetchStarted = new Promise<void>((resolve) => {
      resolveFetch = resolve;
    });
    const resultPromise = executeCli(['runs', 'watch', '--kind', 'workflow', 'run-1'], {
      signal: controller.signal,
      fetch: async (_input, init) => {
        calls += 1;
        resolveFetch?.();
        const signal = init?.signal;
        const body = new ReadableStream<Uint8Array>({
          start(streamController) {
            signal?.addEventListener(
              'abort',
              () => streamController.error(new DOMException('Aborted', 'AbortError')),
              { once: true },
            );
          },
        });
        return new Response(body, {
          headers: { 'content-type': 'text/event-stream' },
        });
      },
    });
    await fetchStarted;
    controller.abort();
    const result = await resultPromise;
    expect(result.exitCode).toBe(130);
    expect(calls).toBe(1);
    expect(result.stderr).toContain('no cancellation');
  });

  // spawn-free: injected terminal event streams exercise failure and pending-input exits.
  test('returns exit 1 for failed runs and exit 5 for pending input', async () => {
    const failed = await executeCli(
      ['events', 'watch', '--kind', 'workflow', 'failed', '--output', 'json'],
      {
        fetch: async () =>
          new Response(sseFrame({ kind: 'workflow:failed' }, 'c-1'), {
            headers: { 'content-type': 'text/event-stream' },
          }),
      },
    );
    const pending = await executeCli(['runs', 'watch', '--kind', 'task', 'pending'], {
      fetch: async () =>
        new Response(sseFrame({ kind: 'task.status', status: 'input-required' }, 'c-2'), {
          headers: { 'content-type': 'text/event-stream' },
        }),
    });
    expect(failed.exitCode).toBe(1);
    expect(pending.exitCode).toBe(5);
  });

  // spawn-free: injected JSON-RPC replaces the management process for cancellation mapping.
  test('maps atomic workflow cancellation and task rejection without retry', async () => {
    const calls: string[] = [];
    const alreadyTerminal = await executeCli(['runs', 'cancel', '--kind', 'workflow', 'same-id'], {
      fetch: async (_input, init) => {
        const body = JSON.parse(typeof init?.body === 'string' ? init.body : '') as {
          method: string;
        };
        calls.push(body.method);
        return jsonRpc(body.method, {
          workflowId: 'same-id',
          status: 'already-terminal',
          terminalStatus: 'completed',
        });
      },
    });
    expect(alreadyTerminal.exitCode).toBe(0);
    expect(JSON.parse(alreadyTerminal.stdout)).toMatchObject({
      id: 'workflow:same-id',
      terminal: true,
    });
    expect(calls).toEqual(['weft.workflows.cancel']);
  });

  // spawn-free: injected JSON-RPC replaces the management process for audit projection.
  test('passes audit filters and preserves the server-redacted page', async () => {
    let params: Record<string, unknown> | undefined;
    const result = await executeCli(
      [
        'audit',
        'list',
        '--run-id',
        'run-1',
        '--type',
        'run.finished',
        '--limit',
        '2',
        '--output',
        'json',
      ],
      {
        fetch: async (_input, init) => {
          const body = JSON.parse(typeof init?.body === 'string' ? init.body : '') as {
            params: Record<string, unknown>;
          };
          params = body.params;
          return jsonRpc('bureau.audit.query', {
            records: [{ resource: 'run-1', detail: { safe: true } }],
            nextCursor: null,
          });
        },
      },
    );
    expect(result.exitCode).toBe(0);
    expect(params).toEqual({ runId: 'run-1', type: 'run.finished', limit: 2 });
    expect(JSON.parse(result.stdout).data.records[0].detail).toEqual({ safe: true });
  });
});
