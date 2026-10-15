import { expect, test } from 'bun:test';

import type { OperationResult, TerminalTransportState } from './transport-types.ts';

test('the transport types are erased at runtime and the module still loads', async () => {
  expect(Object.keys(await import('./transport-types.ts'))).toEqual([]);
});

test('an operation result names how it ended, and nothing claims more than the host said', () => {
  const states: TerminalTransportState[] = [
    'empty',
    'connecting',
    'writable',
    'read-only',
    'backpressured',
    'exited',
    'disconnected',
    'denied',
    'failed',
    'cleanup-incomplete',
  ];
  const results: OperationResult[] = [
    { status: 'accepted', sequence: 1 },
    { status: 'refused', code: 'fifo-full', reason: 'operation-window-full' },
    { status: 'failed', sequence: 2, code: 'backend-failed' },
    { status: 'unknown', sequence: 3 },
  ];
  // @ts-expect-error a result cannot claim a status the transport never reports
  const invented: OperationResult = { status: 'delivered', sequence: 4 };
  expect([states.length, results.length]).toEqual([10, 4]);
  expect(JSON.stringify(invented)).toBe('{"status":"delivered","sequence":4}');
});
