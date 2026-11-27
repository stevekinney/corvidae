import { MemoryStorage } from '@lostgradient/storage';
import { throwingRejectionOf } from '@lostgradient/testing/promise-outcome';
import { describe, expect, it } from 'bun:test';
import { createRefundLedger } from './refund-ledger.ts';
import { createFakeProcessor, recoverRefund, submitApprovedRefund } from './refund-processor.ts';

describe('refund admission', () => {
  it('finds the committed refund and instruction after the admission acknowledgement is lost', async () => {
    class LostAcknowledgementStorage extends MemoryStorage {
      loseNext = false;
      override async conditionalBatch(...args: Parameters<MemoryStorage['conditionalBatch']>) {
        const committed = await super.conditionalBatch(...args);
        if (committed && this.loseNext) {
          this.loseNext = false;
          throw new Error('Acknowledgement lost');
        }
        return committed;
      }
    }
    const storage = new LostAcknowledgementStorage();
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
    storage.loseNext = true;
    expect(await throwingRejectionOf(ledger.admit(request))).toThrow('Acknowledgement lost');
    const successor = createRefundLedger(storage);
    const refund = await successor.admit(request);
    expect(await successor.pendingStarts()).toMatchObject([
      { refundId: refund.id, status: 'pending' },
    ]);
    expect(await successor.balance('merchant', 'order')).toMatchObject({ reserved: 4000 });
    storage.loseNext = true;
    expect(await throwingRejectionOf(successor.claimStart(refund.id))).toThrow(
      'Acknowledgement lost',
    );
    const abandoned = await successor.getStart(refund.id);
    if (!abandoned) throw new Error('Missing claimed start');
    const recovered = await createRefundLedger(storage).claimStart(refund.id);
    expect(recovered).toMatchObject({
      runId: abandoned.runId,
      sessionId: abandoned.sessionId,
      fence: abandoned.fence + 1,
    });
    expect(await successor.completeStart(refund.id, abandoned.fence)).toBe(false);
    storage.loseNext = true;
    expect(await throwingRejectionOf(successor.completeStart(refund.id, recovered.fence))).toThrow(
      'Acknowledgement lost',
    );
    expect(await createRefundLedger(storage).completeStart(refund.id, recovered.fence)).toBe(true);
  });
  it('retains one start identity and fences a superseded worker', async () => {
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
    const first = await ledger.claimStart(refund.id);
    expect(await ledger.get(refund.id)).toMatchObject({ existingRunId: first.runId });
    const successor = await ledger.claimStart(refund.id);
    expect(successor).toMatchObject({
      runId: first.runId,
      sessionId: first.sessionId,
      fence: first.fence + 1,
    });
    expect(await ledger.completeStart(refund.id, first.fence)).toBe(false);
    expect(await ledger.completeStart(refund.id, successor.fence)).toBe(true);
    expect(await ledger.claimStart(refund.id)).toMatchObject({ ...successor, status: 'started' });
    expect(await ledger.pendingStarts()).toEqual([]);
    const reviewId = `approval:${successor.runId}:reviewed-call`;
    expect(await ledger.linkReview(refund.id, successor.runId, reviewId)).toBe(true);
    expect(await ledger.linkReview(refund.id, successor.runId, reviewId)).toBe(true);
    expect(await ledger.get(refund.id)).toMatchObject({ reviewId });
    expect(await ledger.linkReview(refund.id, 'other', 'approval:other:reviewed-call')).toBe(false);
  });
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
      if (amount === 4000) {
        const refunds = results.flatMap((result) =>
          result.status === 'fulfilled' ? [result.value] : [],
        );
        expect(new Set(refunds.map((refund) => refund.id)).size).toBe(2);
        const processor = createFakeProcessor(new MemoryStorage());
        const receipts: string[] = [];
        for (const refund of refunds) {
          const submitted = await submitApprovedRefund(ledger, processor, refund.id, 100);
          expect(submitted?.status).toBe('provider-pending');
          if (!submitted?.receipt) throw new Error('Missing provider receipt');
          receipts.push(submitted.receipt);
          await processor.update(refund.providerKey, 'succeeded');
          expect(await recoverRefund(ledger, processor, refund.id, 10)).toBe(true);
          expect(await ledger.get(refund.id)).toMatchObject({
            status: 'succeeded',
            receipt: submitted.receipt,
          });
        }
        expect(new Set(receipts).size).toBe(2);
        const payments = await processor.refunds();
        expect(payments).toHaveLength(2);
        expect(payments).toEqual(
          expect.arrayContaining(
            refunds.map((refund, index) =>
              expect.objectContaining({
                key: refund.providerKey,
                receipt: receipts[index],
                amount: 4000,
                status: 'succeeded',
              }),
            ),
          ),
        );
        expect(await processor.submissions()).toBe(2);
        expect(await ledger.balance('merchant', 'order')).toMatchObject({
          reserved: 0,
          settled: 8000,
        });
      }
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
  it('does not resubmit or finalize when receipt-only recovery finds no provider evidence', async () => {
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
      commandId: 'unknown',
      order: 'order',
      amount: 4000,
      toolRevision: '1.1.0',
      owner: 'alice',
    });
    const liveClaim = await ledger.claim(refund.id, 100);
    expect(await recoverRefund(ledger, processor, refund.id, 10, true, false)).toBe(false);
    expect(await processor.submissions()).toBe(0);
    expect(await processor.refunds()).toEqual([]);
    expect(await ledger.get(refund.id)).toMatchObject({
      status: 'submitting',
      fence: liveClaim.fence,
    });
    const accepted = await processor.submit(liveClaim);
    expect(await ledger.apply(refund.id, liveClaim.fence, accepted.status, accepted.receipt)).toBe(
      true,
    );
  });
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
    const reconciled = await ledger.get(refund.id);
    expect(reconciled).toMatchObject({ status: 'provider-pending' });
    expect(await recoverRefund(ledger, processor, refund.id, 10, true, false)).toBe(true);
    expect(await ledger.get(refund.id)).toEqual(reconciled);
    expect(await processor.submissions()).toBe(1);
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
  it('looks up the receipt again after claiming a recovery fence', async () => {
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
      commandId: 'settled-during-recovery',
      order: 'order',
      amount: 4000,
      toolRevision: '1.1.0',
      owner: 'alice',
    });
    const attempt = await ledger.claim(refund.id, 100);
    const pending = await processor.submit(attempt);
    let competingFence: number | undefined;
    const recoveringLedger = {
      ...ledger,
      async claim(id: string) {
        // The first lookup observed pending. A peer claims after observing settlement.
        await processor.update(refund.providerKey, 'succeeded');
        expect(await processor.lookup(refund.providerKey)).toMatchObject({ status: 'succeeded' });
        const competingClaim = await ledger.claim(id);
        competingFence = competingClaim.fence;
        return ledger.claim(id);
      },
    };

    expect(await recoverRefund(recoveringLedger, processor, refund.id, 10, true, false)).toBe(true);
    if (competingFence === undefined) throw new Error('The competing claim was not admitted');
    expect(await ledger.apply(refund.id, competingFence, 'succeeded', pending.receipt)).toBe(false);
    expect(await ledger.get(refund.id)).toMatchObject({
      status: 'succeeded',
      receipt: pending.receipt,
    });
    expect(await ledger.balance('merchant', 'order')).toMatchObject({ reserved: 0, settled: 4000 });
    expect(await processor.submissions()).toBe(1);
    expect(await processor.refunds()).toHaveLength(1);
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
