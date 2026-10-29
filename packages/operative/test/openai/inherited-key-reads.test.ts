/**
 * Regression tests for one defect class: a plain-object lookup answering for a name every object
 * inherits. Model names, scratchpad keys, command ids and field paths are all free-form strings,
 * so each case uses `constructor` and expects the lookup to find nothing.
 *
 * The check in `scripts/check-inherited-key-reads.ts` keeps new reads of this kind out of `src`.
 */

import { describe, expect, test } from 'bun:test';
import { mergeAssembledField } from '../../src/providers/openai-parts';

describe('a name of __proto__ chosen from outside', () => {
  test('is stored as an own field of a streamed message', () => {
    const assembled: Record<string, unknown> = {};
    mergeAssembledField(assembled, '__proto__', 'a');
    mergeAssembledField(assembled, '__proto__', 'b');
    mergeAssembledField(assembled, 'refusal', 'no');
    expect(Object.getPrototypeOf(assembled)).toBe(Object.prototype);
    expect(Object.keys(assembled)).toEqual(['__proto__', 'refusal']);
    expect(Object.getOwnPropertyDescriptor(assembled, '__proto__')?.value).toBe('ab');
  });
});
