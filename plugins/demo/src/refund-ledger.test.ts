import { MemoryStorage } from '@lostgradient/storage';
import { throwingRejectionOf } from '@lostgradient/testing/promise-outcome';
import { describe, expect, it } from 'bun:test';
import { createRefundLedger } from './refund-ledger.ts';
import { createFakeProcessor, recoverRefund } from './refund-processor.ts';

describe('refund admission', () => {
  it('deduplicates commands and reserves balance atomically', async () => {
    const storage = new MemoryStorage();
    const ledger = createRefundLedger(storage);
    await ledger.addCharge({
      merchant: 'merchant',
      order: 'order',
      amount: 10000,
      currency: 'USD',
      paymentReference: 'charge',
      providerAccount: 'account',
    });
    const request = {
      merchant: 'merchant',
      commandId: 'command',
      order: 'order',
      amount: 4000,
      toolRevision: '1.1.0',
      owner: 'alice',
    };
    const [first, second] = await Promise.all([ledger.admit(request), ledger.admit(request)]);
    expect(first.id).toBe(second.id);
    for (const prefix of ['refund:', 'reservation:', 'start:']) {
      const entries = [];
      for await (const entry of storage.scan(prefix)) entries.push(entry);
      expect(entries).toHaveLength(1);
    }
    expect(await ledger.get(first.id)).toMatchObject({
      amount: 4000,
      currency: 'USD',
      paymentReference: 'charge',
      providerAccount: 'account',
      toolRevision: '1.1.0',
    });
    expect(await throwingRejectionOf(ledger.admit({ ...request, amount: 3000 }))).toThrow(
      'Conflict',
    );
    expect(await ledger.balance('merchant', 'order')).toMatchObject({ reserved: 4000 });
    const instructions = [];
    for await (const entry of storage.scan('start:')) instructions.push(entry);
    expect(instructions).toHaveLength(1);
  });
  it('serializes distinct reservations against the same balance', async () => {
    for (const [amount, successful, reserved] of [
      [6000, 1, 6000],
      [4000, 2, 8000],
    ] as const) {
      const ledger = createRefundLedger(new MemoryStorage());
      await ledger.addCharge({
        merchant: 'merchant',
        order: 'order',
        amount: 10000,
        currency: 'USD',
        paymentReference: 'charge',
        providerAccount: 'account',
      });
      const request = {
        merchant: 'merchant',
        order: 'order',
        amount,
        toolRevision: '1.1.0',
        owner: 'alice',
      };
      const results = await Promise.allSettled(
        ['one', 'two'].map((commandId) => ledger.admit({ ...request, commandId })),
      );
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(successful);
      expect(await ledger.balance('merchant', 'order')).toMatchObject({ reserved });
    }
  });
  it('releases an unexecuted intent without allowing a later claim', async () => {
    const ledger = createRefundLedger(new MemoryStorage());
    await ledger.addCharge({
      merchant: 'merchant',
      order: 'order',
      amount: 10000,
      currency: 'USD',
      paymentReference: 'charge',
      providerAccount: 'account',
    });
    const refund = await ledger.admit({
      merchant: 'merchant',
      commandId: 'command',
      order: 'order',
      amount: 4000,
      toolRevision: '1.1.0',
      owner: 'alice',
    });
    expect(await ledger.cancel(refund.id)).toBe(true);
    expect(await ledger.cancel(refund.id)).toBe(false);
    expect(await throwingRejectionOf(ledger.claim(refund.id, 100))).toThrow('Refund not claimable');
    expect(await ledger.balance('merchant', 'order')).toMatchObject({ reserved: 0, settled: 0 });
  });
});

describe('refund recovery', () => {
  it('reconciles an accepted refund without a second monetary effect', async () => {
    const ledger = createRefundLedger(new MemoryStorage());
    const processor = createFakeProcessor(new MemoryStorage());
    await ledger.addCharge({
      merchant: 'merchant',
      order: 'order',
      amount: 10000,
      currency: 'USD',
      paymentReference: 'charge',
      providerAccount: 'account',
    });
    const refund = await ledger.admit({
      merchant: 'merchant',
      commandId: 'command',
      order: 'order',
      amount: 4000,
      toolRevision: '1.1.0',
      owner: 'alice',
    });
    const attempt = await ledger.claim(refund.id, 100);
    await processor.submit(attempt);
    await recoverRefund(ledger, processor, refund.id, 10);
    expect(await processor.refunds()).toHaveLength(1);
    expect(await ledger.get(refund.id)).toMatchObject({ status: 'provider-pending' });
  });
  it('fences old evidence and applies terminal accounting once', async () => {
    const ledger = createRefundLedger(new MemoryStorage());
    const processor = createFakeProcessor(new MemoryStorage());
    await ledger.addCharge({
      merchant: 'merchant',
      order: 'order',
      amount: 10000,
      currency: 'USD',
      paymentReference: 'charge',
      providerAccount: 'account',
    });
    const refund = await ledger.admit({
      merchant: 'merchant',
      commandId: 'command',
      order: 'order',
      amount: 4000,
      toolRevision: '1.1.0',
      owner: 'alice',
    });
    const old = await ledger.claim(refund.id, 100);
    const pending = await processor.submit(old);
    await ledger.apply(refund.id, old.fence, 'provider-pending', pending.receipt);
    await processor.update(refund.providerKey, 'succeeded');
    expect(await recoverRefund(ledger, processor, refund.id, 10)).toBe(true);
    expect(await ledger.apply(refund.id, old.fence, 'provider-pending', 'old')).toBe(false);
    expect(await ledger.get(refund.id)).toMatchObject({
      status: 'succeeded',
      receipt: pending.receipt,
    });
    expect(await ledger.balance('merchant', 'order')).toMatchObject({ reserved: 0, settled: 4000 });
  });
  it('holds pending funds and releases a definitive failure', async () => {
    const ledger = createRefundLedger(new MemoryStorage());
    const processor = createFakeProcessor(new MemoryStorage());
    await ledger.addCharge({
      merchant: 'merchant',
      order: 'order',
      amount: 10000,
      currency: 'USD',
      paymentReference: 'charge',
      providerAccount: 'account',
    });
    const refund = await ledger.admit({
      merchant: 'merchant',
      commandId: 'command',
      order: 'order',
      amount: 4000,
      toolRevision: '1.1.0',
      owner: 'alice',
    });
    const attempt = await ledger.claim(refund.id, 100);
    const pending = await processor.submit(attempt);
    await ledger.apply(refund.id, attempt.fence, pending.status, pending.receipt);
    expect(await ledger.balance('merchant', 'order')).toMatchObject({ reserved: 4000, settled: 0 });
    await processor.update(refund.providerKey, 'failed');
    await recoverRefund(ledger, processor, refund.id, 10);
    expect(await ledger.get(refund.id)).toMatchObject({ status: 'failed' });
    expect(await ledger.balance('merchant', 'order')).toMatchObject({ reserved: 0, settled: 0 });
  });
  it('cannot release a reservation after provider submission was admitted', async () => {
    const ledger = createRefundLedger(new MemoryStorage());
    await ledger.addCharge({
      merchant: 'merchant',
      order: 'order',
      amount: 10000,
      currency: 'USD',
      paymentReference: 'charge',
      providerAccount: 'account',
    });
    const refund = await ledger.admit({
      merchant: 'merchant',
      commandId: 'command',
      order: 'order',
      amount: 4000,
      toolRevision: '1.1.0',
      owner: 'alice',
    });
    const submitted = await ledger.claim(refund.id, 100);
    expect(await ledger.cancel(refund.id)).toBe(false);
    expect(await ledger.get(refund.id)).toEqual(submitted);
    expect(await ledger.balance('merchant', 'order')).toMatchObject({ reserved: 4000, settled: 0 });
  });
  it('retains funds after an unavailable lookup and an expired guarantee', async () => {
    const ledger = createRefundLedger(new MemoryStorage());
    const processor = createFakeProcessor(new MemoryStorage());
    await ledger.addCharge({
      merchant: 'merchant',
      order: 'order',
      amount: 10000,
      currency: 'USD',
      paymentReference: 'charge',
      providerAccount: 'account',
    });
    const refund = await ledger.admit({
      merchant: 'merchant',
      commandId: 'command',
      order: 'order',
      amount: 4000,
      toolRevision: '1.1.0',
      owner: 'alice',
    });
    const attempt = await ledger.claim(refund.id, 100);
    await processor.submit(attempt);
    expect(await processor.submissions()).toBe(1);
    await processor.expire(attempt.providerKey);
    await recoverRefund(ledger, processor, refund.id, 101, false);
    await recoverRefund(ledger, processor, refund.id, 102, false);
    expect(await processor.submissions()).toBe(1);
    expect(await ledger.get(refund.id)).toMatchObject({ status: 'needs-reconciliation' });
    expect(await ledger.balance('merchant', 'order')).toMatchObject({ reserved: 4000 });
    expect(await processor.refunds()).toHaveLength(1);
  });
});
