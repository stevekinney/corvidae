import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { describe, expect, test } from 'bun:test';

import {
  materializeToolCall,
  materializeToolCalls,
  materializeToolResult,
  materializeToolResultAsync,
  materializeToolResults,
  materializeToolResultsAsync,
} from '../../src/protocol';

describe('tool protocol materialization', () => {
  test('materializes tool calls with generated identifiers and JSON-safe arguments', () => {
    const calls = materializeToolCalls(
      [
        { name: 'weather', arguments: { city: 'Denver' } },
        { id: 'existing-call', name: 'time', arguments: undefined },
      ],
      {
        generateId: () => 'generated-call',
      },
    );

    expect(calls).toEqual([
      {
        id: 'generated-call',
        name: 'weather',
        arguments: { city: 'Denver' },
      },
      {
        id: 'existing-call',
        name: 'time',
        arguments: {},
      },
    ]);
  });

  test('a manual runtime controls the default identifier when no explicit id or generateId is supplied', () => {
    const runtime = createManualRuntimeServices({ identifierSeed: 'materialization-test' });
    const expectedRuntime = createManualRuntimeServices({ identifierSeed: 'materialization-test' });

    const call = materializeToolCall({ name: 'weather', arguments: {} }, { runtime });

    expect(call.id).toBe(expectedRuntime.identifiers.next('tool-call'));
  });

  test('materializes synchronous tool results and strips runtime-only fields', () => {
    const result = materializeToolResult({
      callId: 'call-1',
      outcome: 'error',
      content: { ok: false },
      error: {
        code: 'E_FAIL',
        category: 'internal',
        retryable: false,
        message: 'boom',
        details: new Date('2026-03-18T00:00:00.000Z'),
      },
      action: {
        type: 'input',
        schema: { prompt: 'city' },
      },
      inputDigest: 'input-digest',
      outputDigest: 'output-digest',
      result: { ignored: true },
    });

    expect(result).toEqual({
      callId: 'call-1',
      outcome: 'error',
      content: { ok: false },
      error: {
        code: 'E_FAIL',
        category: 'internal',
        retryable: false,
        message: 'boom',
        details: '2026-03-18T00:00:00.000Z',
      },
      action: {
        type: 'input',
        schema: { prompt: 'city' },
      },
      inputDigest: 'input-digest',
      outputDigest: 'output-digest',
    });
  });

  test('rejects synchronous materialization of streaming tool results', () => {
    expect(() =>
      materializeToolResult({
        callId: 'call-1',
        outcome: 'success',
        content: [],
        result: {
          async *[Symbol.asyncIterator]() {
            yield 'chunk';
          },
        },
      }),
    ).toThrow(
      'materializeToolResult does not support streaming tool results. Use materializeToolResultAsync or materializeToolResultsAsync.',
    );
  });

  test('materializes streamed tool results asynchronously', async () => {
    const result = await materializeToolResultAsync({
      callId: 'call-1',
      outcome: 'success',
      content: 'ignored',
      stream: {
        async *[Symbol.asyncIterator]() {
          yield 'alpha';
          yield { beta: true };
        },
      },
    });

    expect(result).toEqual({
      callId: 'call-1',
      outcome: 'success',
      content: ['alpha', { beta: true }],
    });
  });

  test('materializes batches of tool results asynchronously', async () => {
    const results = await materializeToolResultsAsync([
      {
        callId: 'call-1',
        outcome: 'success',
        content: 'plain',
      },
      {
        callId: 'call-2',
        outcome: 'success',
        content: [],
        result: {
          async *[Symbol.asyncIterator]() {
            yield 'chunk';
          },
        },
      },
    ]);

    expect(results).toEqual([
      {
        callId: 'call-1',
        outcome: 'success',
        content: 'plain',
      },
      {
        callId: 'call-2',
        outcome: 'success',
        content: ['chunk'],
      },
    ]);
  });

  test('closes a streaming iterator when materialization is aborted', async () => {
    const controller = new AbortController();
    let closed = false;
    const materialization = materializeToolResultAsync(
      {
        callId: 'call-1',
        outcome: 'success',
        content: [],
        stream: {
          [Symbol.asyncIterator]() {
            return {
              next: () => new Promise<IteratorResult<unknown>>(() => {}),
              async return() {
                closed = true;
                return { done: true, value: undefined };
              },
            };
          },
        },
      },
      { signal: controller.signal },
    );

    controller.abort(new DOMException('cancelled', 'AbortError'));

    const abortError = await materialization.then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(abortError).toMatchObject({ name: 'AbortError' });
    expect(closed).toBe(true);
  });

  test('rejects a non-stream result when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new DOMException('cancelled', 'AbortError'));

    const abortError = await materializeToolResultAsync(
      { callId: 'call-1', outcome: 'success', content: { value: 1 } },
      { signal: controller.signal },
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(abortError).toMatchObject({ name: 'AbortError', message: 'cancelled' });

    const aborted = new AbortController();
    aborted.abort('stop');
    const normalized = await materializeToolResultsAsync(
      [{ callId: 'call-2', outcome: 'success', content: 'done' }],
      { signal: aborted.signal },
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(normalized).toMatchObject({ name: 'AbortError' });
  });

  test('rejects on abort without waiting for an iterator return() that never settles', async () => {
    const controller = new AbortController();
    let returnCalls = 0;
    const materialization = materializeToolResultAsync(
      {
        callId: 'call-1',
        outcome: 'success',
        content: [],
        stream: {
          [Symbol.asyncIterator]() {
            return {
              next: () => new Promise<IteratorResult<unknown>>(() => {}),
              return: () => {
                returnCalls += 1;
                return new Promise<IteratorResult<unknown>>(() => {});
              },
            };
          },
        },
      },
      { signal: controller.signal },
    );

    let settled: unknown;
    void materialization.then(
      () => {
        settled = 'resolved';
      },
      (error: unknown) => {
        settled = error;
      },
    );

    controller.abort(new DOMException('cancelled', 'AbortError'));
    // Drain only already-queued microtasks; no timer or macrotask is involved.
    for (let turn = 0; turn < 10 && settled === undefined; turn += 1) {
      await Promise.resolve();
    }

    expect(settled).toMatchObject({ name: 'AbortError' });
    expect(returnCalls).toBe(1);
  });

  test('swallows a rejecting or throwing iterator return() during abort cleanup', async () => {
    const createStream = (returnImplementation: () => Promise<IteratorResult<unknown>>) => ({
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise<IteratorResult<unknown>>(() => {}),
          return: returnImplementation,
        };
      },
    });

    for (const returnImplementation of [
      () => Promise.reject(new Error('return failed')),
      () => {
        throw new Error('return threw');
      },
    ]) {
      const controller = new AbortController();
      const materialization = materializeToolResultAsync(
        {
          callId: 'call-1',
          outcome: 'success',
          content: [],
          stream: createStream(returnImplementation),
        },
        { signal: controller.signal },
      );
      controller.abort(new DOMException('cancelled', 'AbortError'));

      const abortError = await materialization.then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(abortError).toMatchObject({ name: 'AbortError', message: 'cancelled' });
    }
  });

  test('materializes a stream successfully while an abort signal remains active', async () => {
    const controller = new AbortController();

    const result = await materializeToolResultAsync(
      {
        callId: 'call-1',
        outcome: 'success',
        content: [],
        stream: {
          async *[Symbol.asyncIterator]() {
            yield 'complete';
          },
        },
      },
      { signal: controller.signal },
    );
    expect(result).toMatchObject({ content: ['complete'] });
  });

  test('normalizes non-Error abort reasons and iterator rejections', async () => {
    const controller = new AbortController();
    const aborted = materializeToolResultAsync(
      {
        callId: 'call-1',
        outcome: 'success',
        content: [],
        stream: {
          [Symbol.asyncIterator]() {
            return { next: () => new Promise<IteratorResult<unknown>>(() => {}) };
          },
        },
      },
      { signal: controller.signal },
    );
    controller.abort('stop');

    const abortError = await aborted.then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(abortError).toMatchObject({ name: 'AbortError' });

    const streamFailure = await materializeToolResultAsync(
      {
        callId: 'call-2',
        outcome: 'success',
        content: [],
        stream: {
          [Symbol.asyncIterator]() {
            return { next: () => Promise.reject('stream failed') };
          },
        },
      },
      { signal: new AbortController().signal },
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(streamFailure).toMatchObject({ message: 'stream failed' });
  });

  test('materializeToolCall falls back to a random identifier when needed', () => {
    const call = materializeToolCall({
      name: 'search',
      arguments: new Map([['query', 'weather']]),
    });

    expect(typeof call.id).toBe('string');
    expect(call.id.length).toBeGreaterThan(0);
    expect(call.name).toBe('search');
    expect(call.arguments).toEqual({});
  });

  test('materializeToolResults synchronously materializes an array of tool results', () => {
    const results = materializeToolResults([{ callId: 'c1', outcome: 'success', content: 'text' }]);

    expect(results).toEqual([{ callId: 'c1', outcome: 'success', content: 'text' }]);
  });

  // Normalization edge cases live in materialization-normalization.test.ts.
});
