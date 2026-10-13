import { describe, expect, test } from 'bun:test';

import { MAXIMUM_SEQUENCE } from './protocol-constants.ts';
import { SequenceCursor } from './sequence-cursor.ts';

describe('SequenceCursor', () => {
  test('accepts each sequence exactly once, in order, starting at 1', () => {
    const cursor = new SequenceCursor();
    expect(cursor.verify(1)).toEqual({ ok: true, value: undefined });
    cursor.commit(1);
    expect(cursor.last).toBe(1);
    expect(cursor.verify(2).ok).toBe(true);
  });

  test('rejects a duplicate, a replay of an older frame, a gap and a restart', () => {
    const cursor = new SequenceCursor(5);
    expect(cursor.verify(5)).toMatchObject({
      ok: false,
      failure: { reason: 'duplicate-sequence' },
    });
    expect(cursor.verify(4)).toMatchObject({
      ok: false,
      failure: { reason: 'out-of-order-sequence' },
    });
    expect(cursor.verify(7)).toMatchObject({
      ok: false,
      failure: { reason: 'out-of-order-sequence' },
    });
    expect(cursor.verify(1)).toMatchObject({
      ok: false,
      failure: { reason: 'out-of-order-sequence' },
    });
    expect(cursor.last).toBe(5);
  });

  test('accepts the largest sequence and then rejects everything as overflow', () => {
    const cursor = new SequenceCursor(MAXIMUM_SEQUENCE - 1);
    expect(cursor.verify(MAXIMUM_SEQUENCE).ok).toBe(true);
    expect(cursor.peekNext()).toEqual({ ok: true, value: MAXIMUM_SEQUENCE });
    cursor.commit(MAXIMUM_SEQUENCE);
    expect(cursor.verify(MAXIMUM_SEQUENCE)).toMatchObject({
      ok: false,
      failure: { code: 'malformed-frame', reason: 'sequence-overflow' },
    });
    expect(cursor.verify(1)).toMatchObject({ ok: false, failure: { reason: 'sequence-overflow' } });
    expect(cursor.peekNext()).toMatchObject({
      ok: false,
      failure: { code: 'transport-failed', reason: 'sequence-overflow' },
    });
  });

  test('does not move when a sequence is only checked or peeked', () => {
    const cursor = new SequenceCursor();
    cursor.verify(1);
    cursor.peekNext();
    expect(cursor.last).toBe(0);
  });
});
