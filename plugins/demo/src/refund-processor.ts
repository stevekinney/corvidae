import { textValueStore, type Storage } from '@lostgradient/storage';
import type { createRefundLedger, Refund } from './refund-ledger.ts';

type ProcessorRefund = {
  key: string;
  providerAccount: string;
  paymentReference: string;
  currency: string;
  amount: number;
  receipt: string;
  status: 'provider-pending' | 'succeeded' | 'failed';
};
type Ledger = ReturnType<typeof createRefundLedger>;

export function createFakeProcessor(storage: Storage, onAccepted?: () => Promise<void>) {
  const records = textValueStore(storage, { disposeUnderlyingStorage: false });
  const keyOf = (key: string) => `provider-key:${encodeURIComponent(key)}`;
  const recordOf = (receipt: string) => `processor:${encodeURIComponent(receipt)}`;
  async function lookup(key: string): Promise<ProcessorRefund | undefined> {
    const receipt = await records.get(keyOf(key));
    const raw = receipt === null ? null : await records.get(recordOf(receipt));
    return raw === null ? undefined : (JSON.parse(raw) as ProcessorRefund);
  }
  async function submit(refund: Refund): Promise<ProcessorRefund> {
    const candidate: ProcessorRefund = {
      key: refund.providerKey,
      providerAccount: refund.providerAccount,
      paymentReference: refund.paymentReference,
      currency: refund.currency,
      amount: refund.amount,
      receipt: crypto.randomUUID(),
      status: 'provider-pending',
    };
    for (;;) {
      const count = await records.get('submissions');
      if (
        await records.conditionalBatch(
          [{ key: 'submissions', expectedValue: count }],
          [{ type: 'set', key: 'submissions', value: String(Number(count ?? 0) + 1) }],
        )
      )
        break;
    }
    await records.conditionalBatch(
      [{ key: keyOf(candidate.key), expectedValue: null }],
      [
        { type: 'set', key: keyOf(candidate.key), value: candidate.receipt },
        { type: 'set', key: recordOf(candidate.receipt), value: JSON.stringify(candidate) },
      ],
    );
    await onAccepted?.();
    const result = await lookup(candidate.key);
    if (
      !result ||
      result.providerAccount !== candidate.providerAccount ||
      result.paymentReference !== candidate.paymentReference ||
      result.currency !== candidate.currency ||
      result.amount !== candidate.amount
    )
      throw new Error('Processor key conflict');
    return result;
  }
  async function update(key: string, status: 'succeeded' | 'failed') {
    for (;;) {
      const receipt = await records.get(keyOf(key));
      if (receipt === null) throw new Error('Processor refund not found');
      const record = recordOf(receipt);
      const raw = await records.get(record);
      if (raw === null) throw new Error('Processor refund not found');
      const refund = JSON.parse(raw) as ProcessorRefund;
      if (refund.status !== 'provider-pending') throw new Error('Processor refund is terminal');
      if (
        await records.conditionalBatch(
          [
            { key: record, expectedValue: raw },
            { key: keyOf(key), expectedValue: receipt },
          ],
          [{ type: 'set', key: record, value: JSON.stringify({ ...refund, status }) }],
        )
      )
        return;
    }
  }
  async function refunds() {
    const keys = await records.list('processor:');
    return Promise.all(
      keys.map(async (key) => JSON.parse((await records.get(key))!) as ProcessorRefund),
    );
  }
  async function submissions() {
    return Number((await records.get('submissions')) ?? 0);
  }
  async function expire(key: string) {
    await records.delete(keyOf(key));
  }
  return { lookup, submit, update, refunds, submissions, expire };
}

type Processor = ReturnType<typeof createFakeProcessor>;
export async function submitApprovedRefund(
  ledger: Ledger,
  processor: Processor,
  id: string,
  retryUntil: number,
) {
  const refund = await ledger.claim(id, retryUntil);
  if (refund.status !== 'submitting') throw new Error('Refund already submitted');
  const result = await processor.submit(refund);
  await ledger.apply(id, refund.fence, result.status, result.receipt);
  return ledger.get(id);
}
export async function recoverRefund(
  ledger: Ledger,
  processor: Processor,
  id: string,
  now: number,
  lookupAvailable = true,
) {
  let refund: Refund;
  try {
    refund = await ledger.claim(id);
  } catch (error) {
    const current = await ledger.get(id);
    if (current?.status === 'succeeded' || current?.status === 'failed') return false;
    throw error;
  }
  let result = lookupAvailable ? await processor.lookup(refund.providerKey) : undefined;
  if (
    !result &&
    refund.status === 'submitting' &&
    refund.retryUntil !== undefined &&
    now < refund.retryUntil
  )
    result = await processor.submit(refund);
  if (!result) return ledger.apply(id, refund.fence, 'needs-reconciliation');
  if (
    result.providerAccount !== refund.providerAccount ||
    result.paymentReference !== refund.paymentReference ||
    result.currency !== refund.currency ||
    result.amount !== refund.amount
  )
    throw new Error('Processor receipt does not match refund');
  return ledger.apply(id, refund.fence, result.status, result.receipt);
}
