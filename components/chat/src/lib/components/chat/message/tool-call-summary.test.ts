import { describe, expect, test } from 'bun:test';

import type { ToolCallPair } from '../conversation-model.ts';
import {
  formatToolCallDuration,
  nextToolCallApprovalDeadline,
  toolCallApprovalDeadline,
  toolCallKeyArgument,
  toolCallResultLine,
  toolCallRowStatus,
  toolCallStatusText,
  toolCallSummarySegments,
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

  test('waits on an approval with no valid deadline', () => {
    expect(toolCallRowStatus(approvalPair('a', undefined), undefined, NOW)).toBe('waiting');
    expect(toolCallRowStatus(approvalPair('a', 'soon'), undefined, NOW)).toBe('waiting');
    expect(toolCallApprovalDeadline(approvalPair('a', 'soon'))).toBeUndefined();
  });

  test('counts an expired approval as expired, never as waiting', () => {
    const pairs = [approvalPair('a', at(-1_000)), approvalPair('b', at(60_000))];
    const statuses = pairs.map((pair) => toolCallRowStatus(pair, undefined, NOW));
    expect(toolCallSummarySegments(pairs, statuses, [undefined, undefined])).toEqual([
      'issue-refund ×2',
      '1 expired',
      '1 waiting for approval',
    ]);
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
