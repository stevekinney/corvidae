/**
 * COR-855 — the interrupt vocabulary on its own: the key that identifies a set of
 * interrupts in the command ledger, and the schema that advertises the answer.
 */
import Ajv from 'ajv';
import { describe, expect, it } from 'bun:test';

import type { PendingReview } from '../types.ts';
import { interruptKey, RESUME_PAYLOAD_SCHEMA } from './ag-ui-interrupts.ts';

function approval(id: string, round: number): PendingReview {
  return { kind: 'tool-approval', id, round } as unknown as PendingReview;
}
function humanWait(id: string): PendingReview {
  return { kind: 'human-wait', id } as unknown as PendingReview;
}

describe('interruptKey', () => {
  it('names a set the same whatever order it is given in', () => {
    expect(interruptKey([approval('b', 1), humanWait('a')])).toBe(
      interruptKey([humanWait('a'), approval('b', 1)]),
    );
  });

  it('tells apart sets whose joined text would be the same', () => {
    const one = interruptKey([approval('a@1,b', 0)]);
    const two = interruptKey([approval('a', 1), approval('b', 0)]);

    expect(one).not.toBe(two);
  });

  it('tells apart an id that ends where another begins', () => {
    expect(interruptKey([humanWait('x,y')])).not.toBe(
      interruptKey([humanWait('x'), humanWait('y')]),
    );
  });

  it('moves with the round of a tool approval', () => {
    expect(interruptKey([approval('a', 0)])).not.toBe(interruptKey([approval('a', 1)]));
  });
});

describe('the advertised response schema', () => {
  const validate = new Ajv({ strict: false }).compile(RESUME_PAYLOAD_SCHEMA);

  it.each([
    [{ decision: 'approve' }],
    [{ decision: 'approve', arguments: { cents: 1 } }],
    [{ decision: 'approve', answer: 'yes' }],
    [{ decision: 'deny' }],
    [{ decision: 'deny', reason: 'no' }],
    [{ decision: 'reject', reason: 'Wrong customer' }],
  ])('accepts %j', (payload) => {
    expect(validate(payload)).toBe(true);
  });

  it.each([
    ['a reject with no reason', { decision: 'reject' }],
    ['a reject with a blank reason', { decision: 'reject', reason: '   ' }],
    ['an unknown decision', { decision: 'maybe' }],
    ['a payload with no decision', {}],
    ['a field it does not define', { decision: 'approve', extra: 1 }],
  ])('refuses %s', (_name, payload) => {
    expect(validate(payload)).toBe(false);
  });
});
