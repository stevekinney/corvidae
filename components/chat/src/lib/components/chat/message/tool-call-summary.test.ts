import { describe, expect, test } from 'bun:test';

import type { ToolCallPair } from '../conversation-model.ts';
import {
  formatToolCallDuration,
  toolCallKeyArgument,
  toolCallResultLine,
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
