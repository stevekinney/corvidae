import { describe, expect, test } from 'bun:test';

import { materializeToolResult } from '../../src/protocol';

describe('tool protocol materialization normalization edge cases', () => {
  test('normalizeJSONValue falls back to a tag when coercion throws and there is no cycle to break', () => {
    const unstringifiable: Record<string, unknown> = {
      // Forces JSON.stringify to throw, so the value reaches the last-resort coercion at all.
      big: 1n,
      toString: () => {
        throw new Error('coercion refused');
      },
    };

    const result = materializeToolResult({
      callId: 'c6-throwing-tostring',
      outcome: 'success',
      content: unstringifiable,
    });

    // Normalization must still produce a string rather than propagate the hook's error.
    expect(result.content).toBe('[unstringifiable]');
  });

  test('normalizeJSONValue survives a throwing Symbol.toStringTag on the terminal path', () => {
    const hostile: Record<string, unknown> = {
      // Forces JSON.stringify to throw so the value reaches the last-resort coercion.
      big: 1n,
      toString: () => {
        throw new Error('coercion refused');
      },
    };
    // `Object.prototype.toString` would Get(value, Symbol.toStringTag), so a throwing accessor
    // there used to escape materialization entirely. The terminal tag must not dispatch.
    Object.defineProperty(hostile, Symbol.toStringTag, {
      get: () => {
        throw new Error('toStringTag refused');
      },
    });

    const result = materializeToolResult({
      callId: 'c6-hostile-tag',
      outcome: 'success',
      content: hostile,
    });

    expect(result.content).toBe('[unstringifiable]');
  });

  test("normalizeJSONValue keeps a nested acyclic array's own toString through elision", () => {
    const inner: any[] = ['x'];
    Object.defineProperty(inner, 'toString', { value: () => 'INNER' });

    const outer: any[] = [inner];
    outer.push(outer);
    // Deterministic stand-in for the engine throw, so the elision path runs on both runtimes.
    Object.defineProperty(outer, 'join', {
      value: () => {
        throw new RangeError('simulated engine cycle overflow');
      },
    });

    const result = materializeToolResult({
      callId: 'c6-nested-hook',
      outcome: 'success',
      content: outer as unknown,
    });

    // `inner` sits on no cycle, so it is returned by reference rather than rebuilt, and still
    // renders through its own hook. Only `outer` — which actually carries the back-reference —
    // is rewritten.
    expect(result.content).toBe('INNER,');
  });

  test('normalizeJSONValue tags a cycle whose elements still refuse coercion', () => {
    const refuses = {
      toString: () => {
        throw new Error('coercion refused');
      },
    };
    const circular: any[] = [refuses];
    circular.push(circular);
    Object.defineProperty(circular, 'join', {
      value: () => {
        throw new RangeError('simulated engine cycle overflow');
      },
    });

    const result = materializeToolResult({
      callId: 'c6-cycle-then-refuse',
      outcome: 'success',
      content: circular as unknown,
    });

    // The cycle is broken, but the surviving element still throws, so the terminal tag applies.
    expect(result.content).toBe('[unstringifiable]');
  });

  test('normalizeJSONValue keeps a nested acyclic array holding NaN unrebuilt', () => {
    const inner: any[] = [Number.NaN];
    Object.defineProperty(inner, 'toString', { value: () => 'INNER' });

    const outer: any[] = [inner];
    outer.push(outer);
    Object.defineProperty(outer, 'join', {
      value: () => {
        throw new RangeError('simulated engine cycle overflow');
      },
    });

    const result = materializeToolResult({
      callId: 'c6-nan',
      outcome: 'success',
      content: outer as unknown,
    });

    // `NaN !== NaN`, so an identity comparison would mark `inner` as changed, rebuild it as a
    // plain array and lose its hook — rendering 'NaN,' instead.
    expect(result.content).toBe('INNER,');
  });

  test('normalizeJSONValue leaves a proxy reporting a non-finite length untouched', () => {
    const target: any[] = [1, 2];
    Object.defineProperty(target, 'join', {
      value: () => {
        throw new RangeError('simulated engine cycle overflow');
      },
    });

    const hostile: any = new Proxy(target, {
      get(receiverTarget, property, receiver) {
        if (property === 'length') return Number.POSITIVE_INFINITY;
        return Reflect.get(receiverTarget, property, receiver);
      },
    });

    // An unguarded `for (i = 0; i < Infinity; i += 1)` would hang here rather than throw, which
    // is a worse failure than the one this function exists to prevent.
    const result = materializeToolResult({
      callId: 'c6-infinite-length',
      outcome: 'success',
      content: hostile,
    });

    expect(result.content).toBe('[unstringifiable]');
  });

  test('normalizeJSONValue leaves a proxy reporting a length beyond the array limit untouched', () => {
    const target: any[] = [1, 2];
    Object.defineProperty(target, 'join', {
      value: () => {
        throw new RangeError('simulated engine cycle overflow');
      },
    });

    const hostile: any = new Proxy(target, {
      get(receiverTarget, property, receiver) {
        // A safe integer, so a bare Number.isSafeInteger check admits it — but far outside the
        // 2^32 - 1 a real array can report, so walking it would attempt billions of reads.
        if (property === 'length') return 2 ** 40;
        return Reflect.get(receiverTarget, property, receiver);
      },
    });

    const result = materializeToolResult({
      callId: 'c6-oversized-length',
      outcome: 'success',
      content: hostile,
    });

    expect(result.content).toBe('[unstringifiable]');
  });

  test('normalizeJSONValue abandons an oversized traversal instead of walking it', () => {
    // A legitimate sparse array — no Proxy needed. Its length is a valid array length, so the
    // array-length cap accepts it; only the traversal budget stops the walk.
    const huge: any[] = Array.from({ length: 2_000_000 });
    huge[0] = 1n; // forces JSON.stringify to throw, so the last-resort path is reached
    Object.defineProperty(huge, 'join', {
      value: () => {
        throw new RangeError('simulated engine cycle overflow');
      },
    });

    const result = materializeToolResult({
      callId: 'c6-oversized-traversal',
      outcome: 'success',
      content: huge as unknown,
    });

    expect(result.content).toBe('[unstringifiable]');
  });

  test('normalizeJSONValue contains a throw from the elision traversal itself', () => {
    const target: any[] = [1, 2];

    const hostile: any = new Proxy(target, {
      get(receiverTarget, property, receiver) {
        // Fails both the initial coercion and the traversal that tries to rescue it.
        if (property === '0') throw new Error('index trap refused');
        return Reflect.get(receiverTarget, property, receiver);
      },
    });

    const result = materializeToolResult({
      callId: 'c6-throwing-traversal',
      outcome: 'success',
      content: hostile,
    });

    expect(result.content).toBe('[unstringifiable]');
  });

  test('normalizeJSONValue treats a null Symbol.toPrimitive as absent, not as a custom hook', () => {
    const circular: any[] = [1, 2];
    circular.push(circular);
    // JS coercion treats a null or undefined Symbol.toPrimitive as absent and falls through to
    // toString, so this must render like any other cyclic array.
    Object.defineProperty(circular, Symbol.toPrimitive, { value: null });

    const result = materializeToolResult({
      callId: 'c6-null-toprimitive',
      outcome: 'success',
      content: circular as unknown,
    });

    expect(result.content).toBe('1,2,');
  });

  test('normalizeJSONValue does not dispatch through an input-controlled map', () => {
    const circular: any[] = [1, 2];
    circular.push(circular);
    // An array carrying its own `map` (metadata, or a subclass override) must not be invoked:
    // `String()` never consults `map`, so normalization must not either. Before this guard the
    // elision called `value.map(...)` and threw here.
    Object.defineProperty(circular, 'map', { value: null });

    const result = materializeToolResult({
      callId: 'c6-map',
      outcome: 'success',
      content: circular as unknown,
    });

    expect(result.content).toBe('1,2,');
  });

  test('normalizeJSONValue falls back to String() for circular objects', () => {
    const circular: any = { a: 1 };
    circular.self = circular;

    const result = materializeToolResult({
      callId: 'c7',
      outcome: 'success',
      content: circular,
    });

    expect(result.content).toBe(String(circular));
  });
});
