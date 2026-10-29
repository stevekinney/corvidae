/**
 * The `bun:test` shim's own cases, run in the same `node --test` child as the suites it serves. A
 * matcher that passed when it should fail would pass every storage case with no evidence, so each
 * one is shown failing as well as passing, and anything the shim does not implement is shown to
 * throw rather than do nothing.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import * as shim from './bun-test-shim.ts';

const { expect, jest } = shim;

await describe('the Node bun:test shim', async () => {
  await it('passes each matcher on a matching value', () => {
    expect(1).toBe(1);
    expect(new Uint8Array([1, 2])).toEqual(new Uint8Array([1, 2]));
    expect({ a: [1] }).toEqual({ a: [1] });
    expect(null).toBeNull();
    expect(undefined).toBeUndefined();
    expect(0).toBeDefined();
    expect(new TypeError('x')).toBeInstanceOf(Error);
    expect(['a', 'b']).toContain('b');
    expect('abc').toContain('bc');
    expect([1, 2, 3]).toHaveLength(3);
    expect(1).not.toBe(2);
    expect([1]).not.toEqual([2]);
    expect(0).not.toBeNull();
    expect(null).not.toBeUndefined();
    expect('x').not.toBeInstanceOf(Error);
    expect(['a']).not.toContain('b');
    expect([1]).not.toHaveLength(2);
  });

  await it('fails each matcher on a value that does not match', () => {
    const failures: [string, () => void][] = [
      ['toBe', () => expect(1).toBe(2)],
      ['toBe on equal objects', () => expect({}).toBe({})],
      ['toEqual', () => expect([1, 2]).toEqual([1, 3])],
      ['toEqual on a Buffer', () => expect(Buffer.from([1])).toEqual(new Uint8Array([1]))],
      ['toBeNull', () => expect(undefined).toBeNull()],
      ['toBeUndefined', () => expect(null).toBeUndefined()],
      ['toBeDefined', () => expect(undefined).toBeDefined()],
      ['toBeInstanceOf', () => expect({}).toBeInstanceOf(Error)],
      ['toContain', () => expect(['a']).toContain('b')],
      ['toContain on a string', () => expect('abc').toContain('d')],
      ['toHaveLength', () => expect([1]).toHaveLength(2)],
      ['not.toBe', () => expect(1).not.toBe(1)],
      ['not.toEqual', () => expect([1]).not.toEqual([1])],
      ['not.toBeNull', () => expect(null).not.toBeNull()],
      ['not.toContain', () => expect(['a']).not.toContain('a')],
      ['not.toHaveLength', () => expect([1]).not.toHaveLength(1)],
    ];
    for (const [name, failing] of failures) {
      assert.throws(failing, assert.AssertionError, name);
    }
  });

  await it('prefixes a failure with the message passed to expect', () => {
    assert.throws(() => expect(1, 'the child exit code').toBe(0), {
      message: 'the child exit code: expected 1 to be 0',
    });
  });

  await it('throws on a matcher or jest member it does not implement', () => {
    const matchers = expect(1) as unknown as Record<string, () => void>;
    assert.throws(() => matchers['toMatchObject']!(), {
      message: 'the Node bun:test shim does not implement expect().toMatchObject',
    });
    assert.throws(() => (jest as unknown as Record<string, unknown>)['useFakeTimers'], {
      message: 'the Node bun:test shim does not implement jest.useFakeTimers',
    });
    assert.equal(jest.isFakeTimers(), false);
  });

  await it('refuses a test body or hook that takes a done callback, and an options argument', () => {
    const takesDone = ((_done: unknown) => {}) as unknown as () => void;
    assert.throws(() => shim.it('done', takesDone), /done callback/u);
    assert.throws(() => shim.beforeEach(takesDone), /done callback/u);
    assert.throws(
      () => shim.it('options', () => {}, { retry: 1 } as unknown as number),
      /options argument/u,
    );
  });
});
