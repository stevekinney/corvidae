import { describe, expect, test } from 'bun:test';
import { executeCliWithDispatchAssertions as executeCli } from './cli-dispatch.test-support.ts';

import { parseCliArguments } from './cli-client.ts';

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

  // spawn-free: injected fetch replaces the management process for the explanation call.
  test('COR-2533: explains either kind of run by its identifier, with no kind', async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const explanation = {
      summary: 'The step "model" failed because the code it ran raised an error.',
      cause: { category: 'application', code: 'UNKNOWN', kind: 'generate' },
      step: { index: 0, label: 'model' },
      tries: null,
      verdicts: [{ name: 'sentinel', kind: 'tripwire', outcome: 'tripwire', step: 0 }],
      remediation: 'Read the run’s failure message.',
      nextCommands: ['interborough runs get --kind task run-1'],
    };
    const fetch: NonNullable<Parameters<typeof executeCli>[1]>['fetch'] = async (_input, init) => {
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '') as {
        method: string;
        params: Record<string, unknown>;
      };
      calls.push(body);
      return jsonRpc(body.method, explanation);
    };
    const text = await executeCli(['runs', 'explain', 'task:run-1'], { fetch });
    const json = await executeCli(['runs', 'explain', 'run-1', '--output', 'json'], { fetch });
    expect(calls).toMatchObject([
      { method: 'bureau.tasks.explain', params: { runId: 'run-1' } },
      { method: 'bureau.tasks.explain', params: { runId: 'run-1' } },
    ]);
    expect(text.exitCode).toBe(0);
    expect(text.stdout.split('\n')).toEqual([
      explanation.summary,
      'Cause: application',
      'Code: UNKNOWN',
      'Kind: generate',
      'Step: 0 model',
      'Guardrail: sentinel (tripwire) at step 0',
      'Next: Read the run’s failure message.',
      '  interborough runs get --kind task run-1',
    ]);
    expect(JSON.parse(json.stdout).data).toEqual(explanation);
  });

  // spawn-free: injected fetch replaces the management process for the retry call.
  test('COR-2533: retries a workflow instance, naming the step only when asked', async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const fetch: NonNullable<Parameters<typeof executeCli>[1]>['fetch'] = async (_input, init) => {
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '') as {
        method: string;
        params: Record<string, unknown>;
      };
      calls.push(body);
      return jsonRpc(body.method, {
        runId: 'w1',
        step: 2,
        workflowVersion: 'v1',
        retryId: null,
      });
    };
    const bare = await executeCli(['runs', 'retry', 'w1', '--output', 'json'], { fetch });
    const stepped = await executeCli(['runs', 'retry', 'workflow:w1', '--step', '2'], { fetch });
    expect(calls.map((call) => [call.method, call.params])).toEqual([
      ['bureau.workflows.runs.retry', { runId: 'w1' }],
      ['bureau.workflows.runs.retry', { runId: 'w1', step: 2 }],
    ]);
    expect(JSON.parse(bare.stdout).data).toMatchObject({ kind: 'workflow', id: 'workflow:w1' });
    expect(stepped.exitCode).toBe(0);
    for (const refused of [
      ['runs', 'retry', 'w1', '--kind', 'task'],
      ['runs', 'retry', 'w1', '--step', '0'],
      ['runs', 'retry'],
    ]) {
      const result = await executeCli(refused, { fetch });
      expect([refused, result.exitCode]).toEqual([refused, 2]);
    }
    // Retry has no preview, so a request for one is refused rather than sent.
    expect(parseCliArguments(['runs', 'retry', 'w1', '--dry-run'])).toMatchObject({ exitCode: 2 });
    expect(calls).toHaveLength(2);
  });

  // spawn-free: injected fetch replaces the management process for a retry no one answered.
  test('COR-2533: a retry nothing answered is an unknown outcome, a refusal is not', async () => {
    const unanswered = await executeCli(['runs', 'retry', 'w1'], {
      fetch: async () => {
        throw new TypeError('connection refused');
      },
    });
    expect(unanswered.exitCode).toBe(7);
    const refused = await executeCli(['runs', 'retry', 'w1'], {
      fetch: async () =>
        Response.json({
          jsonrpc: '2.0',
          id: 'x',
          error: {
            code: -32000,
            message: 'Run "w1" is running, not failed.',
            data: { weftCode: 'Unprocessable', httpStatus: 422 },
          },
        }),
    });
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain('not failed');
  });

  // spawn-free: injected fetch replaces the management process; the server answers a fault.
  test('COR-2533: a fault that can come after the retry committed stays an unknown outcome', async () => {
    const fault = (weftCode: string, httpStatus: number) => async () =>
      Response.json({
        jsonrpc: '2.0',
        id: 'x',
        error: {
          code: -32000,
          message: `The server said ${weftCode}.`,
          data: { weftCode, httpStatus },
        },
      });
    // The server refused or found the call malformed, so nothing ran: exit 1, authorization 3, conflict 4.
    const refusals = [
      ['InvalidParams', 400, 1],
      ['NotFound', 404, 1],
      ['Unprocessable', 422, 1],
      ['Forbidden', 403, 3],
      ['Conflict', 409, 4],
    ] as const;
    for (const [weftCode, httpStatus, exitCode] of refusals) {
      const result = await executeCli(['runs', 'retry', 'w1'], {
        fetch: fault(weftCode, httpStatus),
      });
      expect([weftCode, result.exitCode]).toEqual([weftCode, exitCode]);
    }
    // The retry may have run when the server failed after it, say writing its receipt.
    for (const [weftCode, httpStatus] of [
      ['EngineFailure', 500],
      ['Unavailable', 503],
      ['Timeout', 504],
    ] as const) {
      const result = await executeCli(['runs', 'retry', 'w1', '--output', 'json'], {
        fetch: fault(weftCode, httpStatus),
      });
      expect([weftCode, result.exitCode]).toEqual([weftCode, 7]);
      expect(JSON.parse(result.stdout).error).toMatchObject({ exitCode: 7, code: weftCode });
    }
  });
});
