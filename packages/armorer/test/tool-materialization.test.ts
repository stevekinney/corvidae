import { describe, expect, it } from 'bun:test';

import {
  materializeToolCall,
  materializeToolCalls,
  materializeToolResult,
  materializeToolResultAsync,
  materializeToolResults,
  materializeToolResultsAsync,
} from '../src/tool-materialization';

function approvalAction(message: string, idempotencyKey: string) {
  return {
    type: 'approval' as const,
    message,
    risk: 'high' as const,
    operation: { kind: 'other' as const },
    policyVersion: 'policy:test',
    idempotencyKey,
  };
}
describe('tool materialization helpers', () => {
  it('materializes tool calls with generated identifiers and normalized arguments', () => {
    const circularArguments: Record<string, unknown> = {};
    circularArguments['self'] = circularArguments;

    expect(
      materializeToolCall(
        {
          name: 'lookup',
          arguments: undefined,
        },
        {
          generateId: () => 'generated-call',
        },
      ),
    ).toEqual({
      id: 'generated-call',
      name: 'lookup',
      arguments: {},
    });

    expect(
      materializeToolCalls([
        {
          id: 'call-symbol',
          name: 'lookup',
          arguments: Symbol('arguments'),
        },
        {
          id: 'call-circular',
          name: 'lookup',
          arguments: circularArguments,
        },
      ]),
    ).toEqual([
      {
        id: 'call-symbol',
        name: 'lookup',
        arguments: 'Symbol(arguments)',
      },
      {
        id: 'call-circular',
        name: 'lookup',
        arguments: '[object Object]',
      },
    ]);
  });

  it('materializes synchronous tool results and strips runtime-only fields', () => {
    expect(
      materializeToolResult({
        callId: 'call-1',
        outcome: 'action_required',
        content: undefined,
        // `toolCallId` is not part of `ToolResultInput` — this deliberately
        // passes a runtime-only field to prove it gets stripped.
        toolCallId: 'call-1',
        toolName: 'lookup',
        result: 'ignored',
        action: {
          ...approvalAction('Need approval', 'approval:tool-materialization'),
          operation: { kind: 'other', argsPreview: Symbol('approval') },
        },
      } as Parameters<typeof materializeToolResult>[0]),
    ).toEqual({
      callId: 'call-1',
      outcome: 'action_required',
      content: null,
      action: {
        ...approvalAction('Need approval', 'approval:tool-materialization'),
        operation: { kind: 'other', argsPreview: 'Symbol(approval)' },
      },
    });

    expect(
      materializeToolResult({
        callId: 'call-error',
        outcome: 'error',
        content: Symbol('content'),
        error: {
          code: 'tool.symbol',
          category: 'internal',
          retryable: false,
          message: 'symbolic',
          details: Symbol('details'),
        },
      }),
    ).toEqual({
      callId: 'call-error',
      outcome: 'error',
      content: 'Symbol(content)',
      error: {
        code: 'tool.symbol',
        category: 'internal',
        retryable: false,
        message: 'symbolic',
        details: 'Symbol(details)',
      },
    });

    expect(
      materializeToolResults([
        {
          callId: 'call-2',
          outcome: 'success',
          content: { ok: true },
        },
      ]),
    ).toEqual([
      {
        callId: 'call-2',
        outcome: 'success',
        content: { ok: true },
      },
    ]);
  });

  it('rejects live streaming results in the synchronous materializer', () => {
    expect(() =>
      materializeToolResult({
        callId: 'call-stream',
        outcome: 'success',
        content: [],
        stream: {
          async *[Symbol.asyncIterator]() {
            yield 'chunk';
          },
        },
      }),
    ).toThrow(
      'materializeToolResult does not support streaming tool results. Use materializeToolResultAsync or materializeToolResultsAsync.',
    );
  });

  it('materializes asynchronous tool results from stream handles and runtime result streams', async () => {
    const circularDetails: Record<string, unknown> = {};
    circularDetails['self'] = circularDetails;

    expect(
      await materializeToolResultAsync({
        callId: 'call-stream',
        outcome: 'success',
        content: [],
        stream: {
          async *[Symbol.asyncIterator]() {
            yield 'alpha';
            yield 'beta';
          },
        },
      }),
    ).toEqual({
      callId: 'call-stream',
      outcome: 'success',
      content: ['alpha', 'beta'],
    });

    expect(
      await materializeToolResultsAsync([
        {
          callId: 'call-result-stream',
          outcome: 'success',
          content: [],
          result: {
            async *[Symbol.asyncIterator]() {
              yield 1;
              yield 2;
            },
          },
        },
        {
          callId: 'call-error',
          outcome: 'error',
          content: circularDetails,
          error: {
            code: 'tool.circular',
            category: 'internal',
            retryable: false,
            message: 'circular',
            details: circularDetails,
          },
        },
      ]),
    ).toEqual([
      {
        callId: 'call-result-stream',
        outcome: 'success',
        content: [1, 2],
      },
      {
        callId: 'call-error',
        outcome: 'error',
        content: '[object Object]',
        error: {
          code: 'tool.circular',
          category: 'internal',
          retryable: false,
          message: 'circular',
          details: '[object Object]',
        },
      },
    ]);
  });
});
