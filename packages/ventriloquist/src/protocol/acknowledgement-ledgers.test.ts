import { describe, expect, test } from 'bun:test';

import { OperationLedger, OutputLedger } from './acknowledgement-ledgers.ts';

function reasonOf(result: ReturnType<OperationLedger['verifyResolution']>): string {
  return result.ok ? 'accepted' : result.failure.reason;
}

describe('OperationLedger', () => {
  test('resolves operations in submission order and no other order', () => {
    const ledger = new OperationLedger();
    ledger.submit(1);
    ledger.submit(3);
    ledger.submit(4);
    expect(ledger.unresolvedCount).toBe(3);
    expect(reasonOf(ledger.verifyResolution(3))).toBe('out-of-order-acknowledgement');
    expect(reasonOf(ledger.verifyResolution(2))).toBe('out-of-order-acknowledgement');
    expect(reasonOf(ledger.verifyResolution(1))).toBe('accepted');
    ledger.resolve();
    expect(ledger.unresolvedCount).toBe(2);
    expect(reasonOf(ledger.verifyResolution(3))).toBe('accepted');
  });

  test('rejects a duplicate, a stale and a future acknowledgement', () => {
    const ledger = new OperationLedger();
    ledger.submit(1);
    ledger.submit(2);
    ledger.resolve();
    ledger.resolve();
    expect(reasonOf(ledger.verifyResolution(2))).toBe('duplicate-acknowledgement');
    expect(reasonOf(ledger.verifyResolution(1))).toBe('stale-acknowledgement');
    expect(reasonOf(ledger.verifyResolution(3))).toBe('future-acknowledgement');
  });

  test('lets a failure after acceptance name any operation that was submitted', () => {
    const ledger = new OperationLedger();
    ledger.submit(1);
    ledger.submit(2);
    ledger.resolve();
    expect(ledger.verifySubmitted(1).ok).toBe(true);
    expect(ledger.verifySubmitted(2).ok).toBe(true);
    expect(ledger.verifySubmitted(3)).toMatchObject({
      ok: false,
      failure: { reason: 'future-acknowledgement' },
    });
  });

  test('refuses a failure that names a sequence which was never a submitted operation', () => {
    // Sequence 2 belonged to some other message, such as an output-consumed frame.
    const ledger = new OperationLedger();
    ledger.submit(1);
    ledger.submit(3);
    expect(ledger.verifySubmitted(1).ok).toBe(true);
    expect(ledger.verifySubmitted(3).ok).toBe(true);
    expect(ledger.verifySubmitted(2)).toMatchObject({
      ok: false,
      failure: { code: 'malformed-frame', reason: 'unknown-operation' },
    });
    expect(ledger.verifySubmitted(0).ok).toBe(false);
    expect(ledger.verifySubmitted(4)).toMatchObject({
      ok: false,
      failure: { reason: 'future-acknowledgement' },
    });
  });

  test('resolving with nothing outstanding changes nothing', () => {
    const ledger = new OperationLedger();
    ledger.resolve();
    expect(ledger.unresolvedCount).toBe(0);
    expect(reasonOf(ledger.verifyResolution(0))).toBe('duplicate-acknowledgement');
  });
});

describe('OutputLedger', () => {
  test('moves the consumed count forward and never past what was produced', () => {
    const ledger = new OutputLedger();
    ledger.record(10);
    ledger.record(5);
    expect(ledger.produced).toBe(15);
    expect(ledger.verifyConsumed(15).ok).toBe(true);
    ledger.commitConsumed(7);
    expect(ledger.consumed).toBe(7);
    expect(ledger.verifyConsumed(15).ok).toBe(true);
  });

  test('rejects an over-counted, a duplicate and a stale count', () => {
    const ledger = new OutputLedger();
    ledger.record(10);
    ledger.commitConsumed(4);
    expect(ledger.verifyConsumed(11)).toMatchObject({
      failure: { reason: 'over-counted-acknowledgement' },
    });
    expect(ledger.verifyConsumed(4)).toMatchObject({
      failure: { reason: 'duplicate-acknowledgement' },
    });
    expect(ledger.verifyConsumed(3)).toMatchObject({
      failure: { reason: 'stale-acknowledgement' },
    });
    expect(ledger.consumed).toBe(4);
  });

  test('refuses to acknowledge anything before any output exists', () => {
    const ledger = new OutputLedger();
    expect(ledger.verifyConsumed(1)).toMatchObject({
      failure: { reason: 'over-counted-acknowledgement' },
    });
    expect(ledger.verifyConsumed(0)).toMatchObject({
      failure: { reason: 'duplicate-acknowledgement' },
    });
  });
});
