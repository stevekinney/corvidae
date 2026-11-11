/**
 * The memory client parses what the Bureau's memory operations answer and sorts the faults they
 * throw into the few the Memory page tells apart. A fault is told by its wire code and, where one
 * code carries two refusals, by `data.reason`.
 */
import { rejectionOf } from '@lostgradient/testing';
import { HttpClientError } from '@lostgradient/weft';
import { describe, expect, test } from 'bun:test';

import type { Fetcher } from './bureau-client.ts';
import { exportMemories, getMemory, memoryFaultOf, rememberMemory } from './memory-client.ts';

const MEMORY = {
  id: 'memory-1',
  content: 'Customers prefer refund updates by email, not by phone.',
  memoryClass: 'semantic',
  kind: 'fact',
  source: 'conversation',
  writer: 'agent',
  trust: 'untrusted',
  createdAt: '2026-11-01T16:12:00.000Z',
  sessionId: 'session-1',
};
const HISTORY = {
  id: 'memory-0',
  content: 'Customers prefer refund updates by phone.',
  kind: 'fact',
  writer: 'agent',
  trust: 'untrusted',
  writtenAt: '2026-10-30T10:00:00.000Z',
  correctedAt: '2026-11-01T16:12:00.000Z',
};

/** A fetch that answers every call with `result` in the JSON-RPC envelope, recording each request body. */
function answering(result: unknown, bodies: unknown[] = []): Fetcher {
  return async (_input, init) => {
    bodies.push(JSON.parse(typeof init?.body === 'string' ? init.body : '{}'));
    return Response.json({ jsonrpc: '2.0', id: 'call', result });
  };
}

/** The error `callBureau` throws for a fault envelope's `error.data`. */
function wireFault(data: Record<string, unknown>, message = 'It failed.'): HttpClientError {
  const status = typeof data['httpStatus'] === 'number' ? data['httpStatus'] : 500;
  return new HttpClientError(status, message, { data });
}

describe('memoryFaultOf', () => {
  test('tells a missing scope from a missing memory', () => {
    expect(memoryFaultOf(wireFault({ weftCode: 'Forbidden', httpStatus: 403 }))).toEqual({
      kind: 'forbidden',
    });
    expect(memoryFaultOf(wireFault({ weftCode: 'NotFound', httpStatus: 404 }))).toEqual({
      kind: 'not-found',
    });
  });

  test('tells the two refusals of a correction apart by their reason', () => {
    expect(
      memoryFaultOf(
        wireFault({ weftCode: 'Conflict', httpStatus: 409, reason: 'memory-superseded' }),
      ),
    ).toEqual({ kind: 'superseded' });
    expect(
      memoryFaultOf(
        wireFault({
          weftCode: 'Unprocessable',
          httpStatus: 422,
          reason: 'memory-successor-not-admitted',
        }),
      ),
    ).toEqual({ kind: 'successor-not-admitted' });
  });

  test('sorts a memory that was not admitted', () => {
    const unprocessable = (reason: string) =>
      memoryFaultOf(wireFault({ weftCode: 'Unprocessable', httpStatus: 422, reason }));

    expect(unprocessable('memory-not-admitted')).toEqual({ kind: 'not-admitted' });
  });

  test('treats a Conflict or an Unprocessable with another reason as an ordinary failure, in the Bureau’s words', () => {
    expect(
      memoryFaultOf(wireFault({ weftCode: 'Conflict', httpStatus: 409, reason: 'other' }, 'Busy.')),
    ).toEqual({ kind: 'other', message: 'Busy.', status: 409 });
    expect(
      memoryFaultOf(
        wireFault({ weftCode: 'Unprocessable', httpStatus: 422, reason: 'other' }, 'No.'),
      ),
    ).toEqual({ kind: 'other', message: 'No.', status: 422 });
    expect(
      memoryFaultOf(wireFault({ weftCode: 'EngineFailure', httpStatus: 500 }, 'Broke.')),
    ).toEqual({ kind: 'other', message: 'Broke.', status: 500 });
  });

  test('says the Bureau did not answer for an error that never crossed the wire', () => {
    expect(memoryFaultOf(new Error('socket closed'))).toEqual({
      kind: 'other',
      message: 'socket closed',
    });
    expect(memoryFaultOf('nothing')).toEqual({
      kind: 'other',
      message: 'The server did not answer.',
    });
  });
});

describe('the memory operations', () => {
  test('reads a memory with the kind and writer the Bureau derives, and the versions a correction replaced', async () => {
    const detail = await getMemory('tool-runner', MEMORY.id, {
      fetch: answering({
        memory: MEMORY,
        lineage: { runId: 'run-7', corrects: HISTORY.id, correctedBy: null },
        history: [HISTORY],
      }),
    });

    expect(detail.memory.kind).toBe('fact');
    expect(detail.memory.writer).toBe('agent');
    expect(detail.history).toEqual([HISTORY]);
  });

  test('refuses a memory that names no kind or writer, because the page words a memory by them', async () => {
    const withoutKind = { ...MEMORY, kind: undefined };

    expect(
      await rejectionOf(
        getMemory('tool-runner', MEMORY.id, {
          fetch: answering({
            memory: withoutKind,
            lineage: { runId: null, corrects: null, correctedBy: null },
            history: [],
          }),
        }),
      ),
    ).toBeDefined();
  });

  test('sends the kind a memory is added as, and answers the memory as the list shows it', async () => {
    const bodies: unknown[] = [];

    const result = await rememberMemory('tool-runner', 'Check the order first.', 'how-to', {
      fetch: answering(
        { outcome: 'added', memory: { ...MEMORY, kind: 'how-to', writer: 'person' } },
        bodies,
      ),
    });

    expect(bodies).toEqual([
      {
        jsonrpc: '2.0',
        id: 'bureau.memory.remember',
        method: 'bureau.memory.remember',
        params: { agentId: 'tool-runner', content: 'Check the order first.', kind: 'how-to' },
      },
    ]);
    expect(result.outcome === 'added' && result.memory.kind).toBe('how-to');
  });

  test('exports each memory with its history, under the file name the server gives it', async () => {
    const exported = await exportMemories('tool-runner', {
      fetch: answering({
        exportId: 'export-1',
        fileName: 'tool-runner-memories.json',
        memories: [{ ...MEMORY, history: [HISTORY] }],
      }),
    });

    expect(exported.fileName).toBe('tool-runner-memories.json');
    expect(exported.memories).toEqual([{ ...MEMORY, history: [HISTORY] }]);
  });
});
