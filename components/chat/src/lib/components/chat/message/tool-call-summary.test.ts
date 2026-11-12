import { describe, expect, test } from 'bun:test';

import type { ToolCallPair } from '../conversation-model.ts';
import {
  foldRepeatedSteps,
  formatToolCallDuration,
  formatToolCallElapsed,
  nextToolCallApprovalDeadline,
  REPEATED_STEP_MINIMUM,
  runningStepTitle,
  toolCallApprovalDeadline,
  toolCallFailure,
  toolCallKeyArgument,
  toolCallResultLine,
  toolCallRowStatus,
  toolCallStatusText,
  toolCallSummaryParts,
  totalToolCallDuration,
} from './tool-call-summary.ts';

function pairWithResult(result: Record<string, unknown>): ToolCallPair {
  return { call: { id: 'call-1', name: 'read' }, result } as unknown as ToolCallPair;
}

describe('toolCallKeyArgument', () => {
  test('collapses and truncates a long string argument to one line', () => {
    const key = toolCallKeyArgument(`${'a'.repeat(100)}\n  tail`);
    expect(key).toBe(`${'a'.repeat(79)}…`);
  });

  test('reads a number or boolean when no string argument comes first', () => {
    expect(toolCallKeyArgument({ limit: 25 })).toBe('25');
    expect(toolCallKeyArgument({ blank: '  ', recursive: false })).toBe('false');
  });

  test('has no key for an empty object or a non-object value', () => {
    expect(toolCallKeyArgument({ nested: {} })).toBeUndefined();
    expect(toolCallKeyArgument(42)).toBeUndefined();
  });
});

describe('toolCallResultLine', () => {
  test('stringifies structured result content onto one line', () => {
    const line = toolCallResultLine(pairWithResult({ outcome: 'success', content: { ok: true } }));
    expect(line).toBe('{ "ok": true }');
  });

  test('has no line for a success without content', () => {
    expect(toolCallResultLine(pairWithResult({ outcome: 'success' }))).toBeUndefined();
  });
});

describe('formatToolCallDuration', () => {
  test('reads sub-ten-second durations with one decimal', () => {
    expect(formatToolCallDuration(400)).toBe('0.4s');
  });

  test('reads durations from ten seconds up as whole seconds', () => {
    expect(formatToolCallDuration(12_400)).toBe('12s');
  });

  test('reads durations of a minute or more as minutes and seconds', () => {
    expect(formatToolCallDuration(65_000)).toBe('1m 5s');
    expect(formatToolCallDuration(120_000)).toBe('2m');
  });
});

describe('an approval with a deadline (COR-2280)', () => {
  const NOW = Date.parse('2026-11-02T16:40:00.000Z');

  function approvalPair(id: string, expiresAt: string | undefined): ToolCallPair {
    return {
      call: { id, name: 'issue-refund' },
      result: {
        callId: id,
        outcome: 'action_required',
        action: {
          type: 'approval',
          risk: 'high',
          operation: { kind: 'other' },
          ...(expiresAt === undefined ? {} : { expiresAt }),
        },
      },
    } as unknown as ToolCallPair;
  }

  const at = (offset: number) => new Date(NOW + offset).toISOString();

  test('waits before the deadline and is expired from it on', () => {
    const pair = approvalPair('a', at(1_000));
    expect(toolCallRowStatus(pair, undefined, NOW + 999)).toBe('waiting');
    expect(toolCallRowStatus(pair, 'pending', NOW + 999)).toBe('waiting');
    expect(toolCallRowStatus(pair, undefined, NOW + 1_000)).toBe('expired');
    expect(toolCallRowStatus(pair, 'pending', NOW + 1_000)).toBe('expired');
    expect(toolCallStatusText('expired')).toBe('Expired');
  });

  test('lets a settled state win over the deadline', () => {
    const pair = approvalPair('a', at(-1_000));
    expect(toolCallRowStatus(pair, 'denied', NOW)).toBe('denied');
    expect(toolCallRowStatus(pair, 'expired', NOW)).toBe('expired');
    const answered = {
      ...pair,
      result: { callId: 'a', outcome: 'success', content: 'done' },
    } as unknown as ToolCallPair;
    expect(toolCallRowStatus(answered, undefined, NOW)).toBe('succeeded');
  });

  test('shows an approval decision while the tool has yet to return its result', () => {
    const pair = approvalPair('a', at(1_000));
    const status = toolCallRowStatus(pair, 'approved', NOW);
    expect(status).toBe('approved');
    expect(toolCallRowStatus(pair, 'approved_with_edits', NOW)).toBe('approved');
    expect(toolCallSummaryParts([pair], [status], [undefined]).problems).toEqual([
      '1 approved, resuming',
    ]);
  });

  test('waits on an approval with no valid deadline', () => {
    expect(toolCallRowStatus(approvalPair('a', undefined), undefined, NOW)).toBe('waiting');
    expect(toolCallRowStatus(approvalPair('a', 'soon'), undefined, NOW)).toBe('waiting');
    expect(toolCallApprovalDeadline(approvalPair('a', 'soon'))).toBeUndefined();
  });

  test('an approval the person approved reads approved, resuming, never waiting (C#2)', () => {
    const pair = approvalPair('a', at(60_000));
    expect(toolCallRowStatus(pair, 'approved', NOW)).toBe('approved');
    expect(toolCallRowStatus(pair, 'approved_with_edits', NOW)).toBe('approved');
    expect(toolCallStatusText('approved')).toBe('Approved, resuming');
    const parts = toolCallSummaryParts([pair], ['approved'], [undefined]);
    expect(parts.problems).toEqual(['1 approved, resuming']);
  });

  test('a question the person answered reads answered, never waiting for input (C#2)', () => {
    const question = {
      call: { id: 'q', name: 'requestHumanInput' },
      result: { callId: 'q', outcome: 'action_required', action: { type: 'input' } },
    } as unknown as ToolCallPair;
    expect(toolCallRowStatus(question, undefined, NOW)).toBe('waiting-input');
    expect(toolCallRowStatus(question, undefined, NOW, true)).toBe('answered');
    expect(toolCallStatusText('answered')).toBe('Answered');
    const parts = toolCallSummaryParts([question], ['answered'], [undefined]);
    expect(parts.problems).toEqual(['1 answered']);
  });

  test('leaves a call that asks the person out of the tools (C#15)', () => {
    const question = {
      call: { id: 'q', name: 'requestHumanInput' },
      result: { callId: 'q', outcome: 'action_required', action: { type: 'input' } },
    } as unknown as ToolCallPair;
    const lookup = {
      call: { id: 'l', name: 'lookup_order' },
      result: { callId: 'l', outcome: 'success', content: 'ok' },
    } as unknown as ToolCallPair;
    expect(
      toolCallSummaryParts([question, lookup], ['waiting-input', 'succeeded'], [undefined, 1])
        .tools,
    ).toBe('lookup_order');
    expect(toolCallSummaryParts([question], ['answered'], [undefined]).tools).toBe('');
  });

  test('counts an expired approval as expired, never as waiting', () => {
    const pairs = [approvalPair('a', at(-1_000)), approvalPair('b', at(60_000))];
    const statuses = pairs.map((pair) => toolCallRowStatus(pair, undefined, NOW));
    const parts = toolCallSummaryParts(pairs, statuses, [undefined, undefined]);
    expect(parts.tools).toBe('issue-refund');
    expect(parts.problems).toEqual(['1 expired', '1 waiting for approval']);
  });

  test('names the next deadline still ahead among the approvals nobody settled', () => {
    const pairs = [
      approvalPair('past', at(-1_000)),
      approvalPair('late', at(60_000)),
      approvalPair('soon', at(5_000)),
      approvalPair('settled', at(1_000)),
      approvalPair('none', undefined),
    ];
    const states = new Map([['settled', 'denied' as const]]);
    expect(nextToolCallApprovalDeadline(pairs, states, NOW)).toBe(NOW + 5_000);
    expect(nextToolCallApprovalDeadline(pairs, states, NOW + 5_000)).toBe(NOW + 60_000);
    expect(nextToolCallApprovalDeadline(pairs, states, NOW + 60_000)).toBeUndefined();
  });
});

describe('totalToolCallDuration', () => {
  test('adds the durations when every call has one', () => {
    expect(totalToolCallDuration([400, 300])).toBe(700);
  });

  test('has no total when a call is still running or when there are no calls', () => {
    expect(totalToolCallDuration([400, undefined])).toBeUndefined();
    expect(totalToolCallDuration([])).toBeUndefined();
  });
});

describe('toolCallSummaryParts', () => {
  test('keeps the first host-provided semantic description in the rolled-up summary', () => {
    const pair = pairWithResult({ outcome: 'success', content: 'done' });
    expect(
      toolCallSummaryParts([pair], ['succeeded'], [400], (_count, _status) => '', [
        'Compared recent orders…',
      ]),
    ).toMatchObject({ description: 'Compared recent orders…', tools: 'read', duration: '0.4s' });
  });
  const lookup = { call: { id: 'a', name: 'lookup-order' } } as ToolCallPair;
  const refund = { call: { id: 'b', name: 'issue-refund' } } as ToolCallPair;

  test('names each tool once with a count, then the problems, then the total time', () => {
    const parts = toolCallSummaryParts(
      [lookup, lookup, refund],
      ['succeeded', 'failed', 'waiting'],
      [400, 300, 100],
    );
    expect(parts.tools).toBe('lookup-order ×2');
    expect(parts.problems).toEqual(['1 failed', '1 waiting for approval']);
    expect(parts.duration).toBe('0.8s');
  });

  test('has no time while a call is still running, and no problems when all succeeded', () => {
    const parts = toolCallSummaryParts(
      [lookup, refund],
      ['succeeded', 'pending'],
      [400, undefined],
    );
    expect(parts.problems).toEqual([]);
    expect(parts.duration).toBeUndefined();
  });

  test('puts no separator character in any phrase', () => {
    const parts = toolCallSummaryParts([lookup], ['denied'], [1200]);
    expect([parts.tools, ...parts.problems, parts.duration].join('')).not.toContain(
      String.fromCodePoint(0xb7),
    );
    expect(parts.problems).toEqual(['1 denied']);
  });

  test('uses a human summary for the internal input-request operation', () => {
    expect(
      toolCallSummaryParts(
        [
          {
            call: { id: 'input', name: 'customQuestionTool' },
            result: { callId: 'input', outcome: 'action_required', action: { type: 'input' } },
          } as ToolCallPair,
        ],
        ['waiting-input'],
        [undefined],
      ).tools,
    ).toBe('');
  });
});

describe('foldRepeatedSteps', () => {
  const sameName = (row: string) => row;

  test('folds a run of three or more identical rows into one step', () => {
    expect(foldRepeatedSteps(['a', 'a', 'a', 'b'], sameName)).toEqual([
      { kind: 'repeated', rows: ['a', 'a', 'a'] },
      { kind: 'single', row: 'b' },
    ]);
  });

  test('leaves a run shorter than the minimum as single rows', () => {
    expect(REPEATED_STEP_MINIMUM).toBe(3);
    expect(foldRepeatedSteps(['a', 'a', 'b', 'b'], sameName)).toEqual([
      { kind: 'single', row: 'a' },
      { kind: 'single', row: 'a' },
      { kind: 'single', row: 'b' },
      { kind: 'single', row: 'b' },
    ]);
  });

  test('never folds a row whose key is undefined, and a run restarts after it', () => {
    const key = (row: string) => (row === 'x' ? undefined : row);
    expect(foldRepeatedSteps(['a', 'a', 'x', 'a', 'a', 'a', 'x', 'x', 'x'], key)).toEqual([
      { kind: 'single', row: 'a' },
      { kind: 'single', row: 'a' },
      { kind: 'single', row: 'x' },
      { kind: 'repeated', rows: ['a', 'a', 'a'] },
      { kind: 'single', row: 'x' },
      { kind: 'single', row: 'x' },
      { kind: 'single', row: 'x' },
    ]);
  });

  test('folds only consecutive rows, so the same key apart stays apart', () => {
    expect(foldRepeatedSteps(['a', 'a', 'b', 'a', 'a'], sameName)).toHaveLength(5);
    expect(foldRepeatedSteps([], sameName)).toEqual([]);
  });
});

describe('toolCallFailure (COR-2283, R7)', () => {
  test('a call that did not fail has none', () => {
    expect(toolCallFailure(pairWithResult({ outcome: 'success', content: 'ok' }), 'x')).toBe(
      undefined,
    );
    expect(toolCallFailure({ call: { id: 'c', name: 'read' } } as ToolCallPair, 'x')).toBe(
      undefined,
    );
  });

  test('the error message is the summary and its details are the diagnostic', () => {
    const failure = toolCallFailure(
      pairWithResult({
        outcome: 'error',
        content: null,
        error: {
          code: 'timeout',
          category: 'timeout',
          retryable: true,
          message: 'parcelly.example did not answer within 10 s.',
          details: { url: 'https://parcelly.example/track/4471', attempts: 3 },
        },
      }),
      'This step failed.',
    );
    expect(failure?.summary).toBe('parcelly.example did not answer within 10 s.');
    expect(failure?.diagnostic).toContain('"attempts": 3');
    expect(failure?.copy).toBe(`${failure?.summary}\n\n${failure?.diagnostic}`);
  });

  test('a short result with no error object is the summary alone, not repeated as a diagnostic', () => {
    const failure = toolCallFailure(
      pairWithResult({ outcome: 'error', content: 'Network unavailable' }),
      'This step failed.',
    );
    expect(failure).toEqual({
      summary: 'Network unavailable',
      diagnostic: undefined,
      copy: 'Network unavailable',
    });
  });

  test('a long result with no error object is cut for the summary and kept whole as the diagnostic', () => {
    const long = `Traceback: ${'frame '.repeat(30)}end`;
    const failure = toolCallFailure(
      pairWithResult({ outcome: 'error', content: long }),
      'This step failed.',
    );
    expect(failure?.summary.endsWith('…')).toBe(true);
    expect(failure?.diagnostic).toBe(long);
  });

  test('a result with parts is read through its text and media labels, never their addresses', () => {
    const failure = toolCallFailure(
      pairWithResult({
        outcome: 'error',
        content: null,
        error: { code: 'E', category: 'internal', retryable: false, message: 'Render failed.' },
        parts: [
          { type: 'text', text: 'The chart could not be drawn.' },
          {
            type: 'image',
            mimeType: 'image/png',
            name: 'chart.png',
            source: { kind: 'remote-url', url: 'https://tracker.example/pixel.png' },
          },
        ],
      }),
      'This step failed.',
    );
    expect(failure?.diagnostic).toContain('The chart could not be drawn.');
    expect(failure?.diagnostic).not.toContain('tracker.example');
  });

  test('a failure that says nothing reads the fallback', () => {
    expect(
      toolCallFailure(pairWithResult({ outcome: 'error', content: null }), 'This step failed.')
        ?.summary,
    ).toBe('This step failed.');
  });
});

describe('formatToolCallElapsed (COR-2283, R1)', () => {
  test('counts whole seconds, then minutes and seconds', () => {
    expect(formatToolCallElapsed(0)).toBe('0s');
    expect(formatToolCallElapsed(4_900)).toBe('4s');
    expect(formatToolCallElapsed(65_000)).toBe('1m 5s');
    expect(formatToolCallElapsed(120_000)).toBe('2m');
    expect(formatToolCallElapsed(-20)).toBe('0s');
  });
});

describe('runningStepTitle (COR-2283, R1)', () => {
  test('a running step’s title ends in one ellipsis', () => {
    expect(runningStepTitle('Searching sources')).toBe('Searching sources…');
    expect(runningStepTitle('Searching sources…')).toBe('Searching sources…');
    expect(runningStepTitle('Searching sources...')).toBe('Searching sources…');
  });
});
