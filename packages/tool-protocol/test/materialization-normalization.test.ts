import { describe, expect, test } from 'bun:test';

import { materializeToolResult } from '../src';

describe('tool protocol materialization normalization', () => {
  test('normalizeJSONValue coerces undefined content to null', () => {
    const result = materializeToolResult({
      callId: 'c2',
      outcome: 'success',
      content: undefined,
    });

    expect(result.content).toBe(null);
  });

  test('normalizeJSONValue replaces non-finite numbers with null via JSON round-trip', () => {
    const result = materializeToolResult({
      callId: 'c3',
      outcome: 'success',
      content: { value: Infinity },
    });

    expect(result.content).toEqual({ value: null });
  });

  test('normalizeJSONValue drops symbol-valued properties via JSON round-trip', () => {
    const result = materializeToolResult({
      callId: 'c4',
      outcome: 'success',
      content: { tag: Symbol('test') },
    });

    expect(result.content).toEqual({});
  });

  test('normalizeJSONValue falls back to String() for bare symbols', () => {
    const result = materializeToolResult({
      callId: 'c5',
      outcome: 'success',
      content: Symbol('fallback'),
    });

    expect(result.content).toBe('Symbol(fallback)');
  });

  test('normalizeJSONValue falls back to String() for circular arrays', () => {
    const circular: any[] = [1, 2];
    circular.push(circular);

    const result = materializeToolResult({
      callId: 'c6',
      outcome: 'success',
      content: circular as unknown,
    });

    // Asserted as a literal rather than as `String(circular)`: the expression under test is
    // exactly the one that is unsafe on some engines (Bun >= 1.4 overflows the stack instead of
    // applying join()'s cycle guard), so computing the expectation that way would make this test
    // pass or crash depending on the host rather than on the code.
    expect(result.content).toBe('1,2,');
  });

  test('normalizeJSONValue elides nested and mutual array cycles the same way join does', () => {
    const outer: any[] = ['a'];
    const inner: any[] = ['b', outer];
    outer.push(inner);

    const result = materializeToolResult({
      callId: 'c6-mutual',
      outcome: 'success',
      content: outer as unknown,
    });

    expect(result.content).toBe('a,b,');
  });

  test('normalizeJSONValue renders a shared but acyclic array reference normally', () => {
    const shared: any[] = [1];
    // The BigInt is what forces the `stringifyNonJSON` path: it makes `JSON.stringify` throw.
    // A function would not, since `JSON.stringify` silently nulls it and the value round-trips.
    const content: any[] = [shared, shared, 1n];

    const result = materializeToolResult({
      callId: 'c6-shared',
      outcome: 'success',
      content: content as unknown,
    });

    // `shared` appears twice but is never its own ancestor, so neither occurrence is a cycle.
    expect(result.content).toBe('1,1,1');
  });

  test('normalizeJSONValue leaves circular plain objects rendering as [object Object]', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;

    const result = materializeToolResult({
      callId: 'c6-object',
      outcome: 'success',
      content: circular,
    });

    expect(result.content).toBe('[object Object]');
  });

  test("normalizeJSONValue preserves a circular array's own toString hook", () => {
    const circular: any[] = [1, 2];
    circular.push(circular);
    // A custom hook is what `String()` actually calls, and it does not recurse the way the
    // default comma-join does, so eliding here would replace real output with a joined clone.
    circular.toString = () => 'custom-array';

    const result = materializeToolResult({
      callId: 'c6-tostring',
      outcome: 'success',
      content: circular as unknown,
    });

    expect(result.content).toBe('custom-array');
  });

  test("normalizeJSONValue preserves a circular array's Symbol.toPrimitive hook", () => {
    const circular: any[] = [1, 2];
    circular.push(circular);
    Object.defineProperty(circular, Symbol.toPrimitive, {
      value: () => 'primitive-array',
    });

    const result = materializeToolResult({
      callId: 'c6-toprimitive',
      outcome: 'success',
      content: circular as unknown,
    });

    expect(result.content).toBe('primitive-array');
  });

  test("normalizeJSONValue preserves a circular array's overridden join", () => {
    const circular: any[] = [1, 2];
    circular.push(circular);
    // `Array.prototype.toString` delegates to `this.join`, so overriding join is as much a
    // custom coercion hook as overriding toString.
    circular.join = () => 'custom-join';

    const result = materializeToolResult({
      callId: 'c6-join',
      outcome: 'success',
      content: circular as unknown,
    });

    expect(result.content).toBe('custom-join');
  });

  test('normalizeJSONValue elides and retries when array coercion throws', () => {
    const circular: any[] = [1, 2];
    circular.push(circular);
    // Deterministic stand-in for the engine behaviour this guards against: Bun >= 1.4 throws a
    // RangeError out of the default join on a self-referential array, where 1.3.13 returns
    // '1,2,'. Forcing the throw here exercises the elide-and-retry path on BOTH engines, so the
    // recovery is covered on the pinned runtime rather than only on the newer one.
    Object.defineProperty(circular, 'join', {
      value: () => {
        throw new RangeError('simulated engine cycle overflow');
      },
    });

    const result = materializeToolResult({
      callId: 'c6-throwing-join',
      outcome: 'success',
      content: circular as unknown,
    });

    expect(result.content).toBe('1,2,');
  });
});
