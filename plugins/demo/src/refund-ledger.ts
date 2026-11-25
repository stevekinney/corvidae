import { textValueStore, type Storage } from '@lostgradient/storage';
export const REFUND_TOOL_REVISION = '1.1.0';

export type Charge = {
  merchant: string;
  order: string;
  amount: number;
  currency: string;
  paymentReference: string;
  providerAccount: string;
  reserved?: number;
  settled?: number;
};
export type RefundRequest = {
  merchant: string;
  commandId: string;
  order: string;
  amount: number;
  toolRevision: string;
  owner: string;
  existingRunId?: string;
};
type RefundStatus =
  'admitted' | 'submitting' | 'provider-pending' | 'succeeded' | 'failed' | 'needs-reconciliation';
export type Refund = RefundRequest & {
  id: string;
  currency: string;
  paymentReference: string;
  providerAccount: string;
  providerKey: string;
  status: RefundStatus;
  fence: number;
  receipt?: string;
  retryUntil?: number;
  reviewId?: string;
};
export type RefundStart = {
  refundId: string;
  owner: string;
  runId: string;
  sessionId: string;
  fence: number;
  status: 'pending' | 'started';
  arguments: { refundId: string; orderId: string; cents: number; currency: string };
};

const key = (...parts: string[]) => parts.map(encodeURIComponent).join(':');
const chargeKey = (merchant: string, order: string) => key('charge', merchant, order);
const refundKey = (id: string) => key('refund', id);
const commandKey = (merchant: string, id: string) => key('command', merchant, id);
const digestKey = (merchant: string, id: string) => key('command-digest', merchant, id);
const parse = <T>(value: string | null): T | undefined =>
  value === null ? undefined : (JSON.parse(value) as T);

export function createRefundLedger(storage: Storage) {
  const records = textValueStore(storage, { disposeUnderlyingStorage: false });
  async function addCharge(charge: Charge) {
    charge = { ...charge };
    if (
      ![
        charge.merchant,
        charge.order,
        charge.currency,
        charge.paymentReference,
        charge.providerAccount,
      ].every((value) => typeof value === 'string' && value.length > 0)
    )
      throw new Error('Invalid charge');
    charge.currency = charge.currency.toUpperCase();
    if (!/^[A-Z]{3}$/.test(charge.currency)) throw new Error('Invalid currency');
    if (!Number.isSafeInteger(charge.amount) || charge.amount <= 0)
      throw new Error('Invalid charge');
    const committed = await records.conditionalBatch(
      [{ key: chargeKey(charge.merchant, charge.order), expectedValue: null }],
      [
        {
          type: 'set',
          key: chargeKey(charge.merchant, charge.order),
          value: JSON.stringify({ ...charge, reserved: 0, settled: 0 }),
        },
      ],
    );
    if (!committed) {
      const existing = await balance(charge.merchant, charge.order);
      if (
        !existing ||
        existing.amount !== charge.amount ||
        existing.currency !== charge.currency ||
        existing.paymentReference !== charge.paymentReference ||
        existing.providerAccount !== charge.providerAccount
      )
        throw new Error('Charge conflict');
    }
  }
  async function get(id: string) {
    return parse<Refund>(await records.get(refundKey(id)));
  }
  async function find(merchant: string, commandId: string) {
    const id = await records.get(commandKey(merchant, commandId));
    return id === null ? undefined : get(id);
  }
  async function recoverable(): Promise<Refund[]> {
    const keys = await records.list('refund:');
    const refunds = await Promise.all(
      keys.map(async (entry) => parse<Refund>(await records.get(entry))),
    );
    return refunds.filter(
      (refund): refund is Refund =>
        refund !== undefined &&
        (refund.status === 'submitting' ||
          refund.status === 'provider-pending' ||
          refund.status === 'needs-reconciliation'),
    );
  }
  async function awaitingReview(): Promise<Refund[]> {
    const keys = await records.list('refund:');
    const refunds = await Promise.all(
      keys.map(async (entry) => parse<Refund>(await records.get(entry))),
    );
    return refunds.filter(
      (refund): refund is Refund => refund !== undefined && refund.status === 'admitted',
    );
  }
  async function balance(merchant: string, order: string) {
    return parse<Charge>(await records.get(chargeKey(merchant, order)));
  }
  async function admit(request: RefundRequest): Promise<Refund> {
    request = { ...request };
    if (
      ![
        request.merchant,
        request.commandId,
        request.order,
        request.toolRevision,
        request.owner,
      ].every((value) => typeof value === 'string' && value.length > 0)
    )
      throw new Error('Invalid request');
    if (!Number.isSafeInteger(request.amount) || request.amount <= 0)
      throw new Error('Invalid amount');
    const command = commandKey(request.merchant, request.commandId);
    const digestRecord = digestKey(request.merchant, request.commandId);
    const digest = Array.from(
      new Uint8Array(
        await crypto.subtle.digest(
          'SHA-256',
          new TextEncoder().encode(JSON.stringify([request.order, request.amount])),
        ),
      ),
      (byte) => byte.toString(16).padStart(2, '0'),
    ).join('');
    const charge = chargeKey(request.merchant, request.order);
    for (;;) {
      const existing = await records.get(command);
      if (existing !== null) {
        if ((await records.get(digestRecord)) !== digest) throw new Error('Conflict');
        const refund = await get(existing);
        if (!refund) throw new Error('Missing refund');
        if (
          refund.order !== request.order ||
          refund.amount !== request.amount ||
          refund.owner !== request.owner ||
          refund.toolRevision !== request.toolRevision
        )
          throw new Error('Conflict');
        return refund;
      }
      const raw = await records.get(charge);
      const account = parse<Charge>(raw);
      if (!account) throw new Error('Charge not found');
      if (account.amount - (account.reserved ?? 0) - (account.settled ?? 0) < request.amount)
        throw new Error('Insufficient balance');
      const refund: Refund = {
        ...request,
        id: crypto.randomUUID(),
        currency: account.currency,
        paymentReference: account.paymentReference,
        providerAccount: account.providerAccount,
        providerKey: crypto.randomUUID(),
        status: 'admitted',
        fence: 0,
      };
      const committed = await records.conditionalBatch(
        [
          { key: command, expectedValue: null },
          { key: charge, expectedValue: raw },
        ],
        [
          { type: 'set', key: command, value: refund.id },
          { type: 'set', key: digestRecord, value: digest },
          { type: 'set', key: refundKey(refund.id), value: JSON.stringify(refund) },
          {
            type: 'set',
            key: key('reservation', refund.id),
            value: JSON.stringify({
              refundId: refund.id,
              amount: refund.amount,
              status: 'reserved',
            }),
          },
          {
            type: 'set',
            key: charge,
            value: JSON.stringify({
              ...account,
              reserved: (account.reserved ?? 0) + request.amount,
            }),
          },
          ...(request.existingRunId === undefined
            ? [
                {
                  type: 'set',
                  key: key('start', refund.id),
                  value: JSON.stringify({
                    refundId: refund.id,
                    owner: request.owner,
                    runId: crypto.randomUUID(),
                    sessionId: crypto.randomUUID(),
                    fence: 0,
                    status: 'pending',
                    arguments: {
                      refundId: refund.id,
                      orderId: refund.order,
                      cents: refund.amount,
                      currency: refund.currency,
                    },
                  }),
                } as const,
              ]
            : []),
        ],
      );
      if (committed) return refund;
    }
  }
  async function getStart(id: string): Promise<RefundStart | undefined> {
    return parse<RefundStart>(await records.get(key('start', id)));
  }
  async function pendingStarts(): Promise<RefundStart[]> {
    const keys = await records.list('start:');
    const starts = await Promise.all(
      keys.map(async (entry) => parse<RefundStart>(await records.get(entry))),
    );
    return starts.filter(
      (start): start is RefundStart => start !== undefined && start.status === 'pending',
    );
  }
  async function startForRun(runId: string): Promise<RefundStart | undefined> {
    const keys = await records.list('start:');
    const starts = await Promise.all(
      keys.map(async (entry) => parse<RefundStart>(await records.get(entry))),
    );
    return starts.find((start) => start?.runId === runId);
  }
  async function claimStart(id: string): Promise<RefundStart> {
    const startKey = key('start', id);
    for (;;) {
      const raw = await records.get(startKey);
      const start = parse<RefundStart>(raw);
      if (!start) throw new Error('Refund start not found');
      if (start.status === 'started') return start;
      const refundRaw = await records.get(refundKey(id));
      const refund = parse<Refund>(refundRaw);
      if (
        !refund ||
        refund.status !== 'admitted' ||
        (refund.existingRunId && refund.existingRunId !== start.runId)
      )
        throw new Error('Refund start does not match the intent');
      const claimed = { ...start, fence: start.fence + 1 };
      if (
        await records.conditionalBatch(
          [
            { key: startKey, expectedValue: raw },
            { key: refundKey(id), expectedValue: refundRaw },
          ],
          [
            { type: 'set', key: startKey, value: JSON.stringify(claimed) },
            {
              type: 'set',
              key: refundKey(id),
              value: JSON.stringify({ ...refund, existingRunId: start.runId }),
            },
          ],
        )
      )
        return claimed;
    }
  }
  async function completeStart(id: string, fence: number): Promise<boolean> {
    const startKey = key('start', id);
    for (;;) {
      const raw = await records.get(startKey);
      const start = parse<RefundStart>(raw);
      if (!start || start.fence !== fence) return false;
      if (start.status === 'started') return true;
      if (
        await records.conditionalBatch(
          [{ key: startKey, expectedValue: raw }],
          [{ type: 'set', key: startKey, value: JSON.stringify({ ...start, status: 'started' }) }],
        )
      )
        return true;
    }
  }
  async function linkReview(id: string, runId: string, reviewId: string): Promise<boolean> {
    if (reviewId !== `approval:${runId}:reviewed-call`)
      throw new Error('Review does not match the reserved call');
    for (;;) {
      const raw = await records.get(refundKey(id));
      const refund = parse<Refund>(raw);
      if (!refund || refund.existingRunId !== runId) return false;
      if (refund.reviewId !== undefined) return refund.reviewId === reviewId;
      if (
        await records.conditionalBatch(
          [{ key: refundKey(id), expectedValue: raw }],
          [{ type: 'set', key: refundKey(id), value: JSON.stringify({ ...refund, reviewId }) }],
        )
      )
        return true;
    }
  }
  async function claim(id: string, retryUntil?: number): Promise<Refund> {
    if (retryUntil !== undefined && (!Number.isFinite(retryUntil) || retryUntil <= 0))
      throw new Error('Invalid provider guarantee');
    for (;;) {
      const raw = await records.get(refundKey(id));
      const refund = parse<Refund>(raw);
      if (!refund || refund.status === 'succeeded' || refund.status === 'failed')
        throw new Error('Refund not claimable');
      if (refund.status === 'admitted' && retryUntil === undefined)
        throw new Error('Approval required');
      if (refund.status !== 'admitted' && retryUntil !== undefined)
        throw new Error('Refund already submitted');
      const next: Refund = {
        ...refund,
        status: refund.status === 'admitted' ? 'submitting' : refund.status,
        fence: refund.fence + 1,
        ...(retryUntil === undefined ? {} : { retryUntil }),
      };
      if (
        await records.conditionalBatch(
          [{ key: refundKey(id), expectedValue: raw }],
          [{ type: 'set', key: refundKey(id), value: JSON.stringify(next) }],
        )
      )
        return next;
    }
  }
  async function cancel(id: string): Promise<boolean> {
    for (;;) {
      const raw = await records.get(refundKey(id));
      const refund = parse<Refund>(raw);
      if (!refund || refund.status !== 'admitted') return false;
      const accountKey = chargeKey(refund.merchant, refund.order);
      const accountRaw = await records.get(accountKey);
      const account = parse<Charge>(accountRaw);
      if (!account) throw new Error('Charge not found');
      if (
        await records.conditionalBatch(
          [
            { key: refundKey(id), expectedValue: raw },
            { key: accountKey, expectedValue: accountRaw },
          ],
          [
            {
              type: 'set',
              key: refundKey(id),
              value: JSON.stringify({ ...refund, status: 'failed' }),
            },
            {
              type: 'set',
              key: accountKey,
              value: JSON.stringify({
                ...account,
                reserved: (account.reserved ?? 0) - refund.amount,
              }),
            },
            {
              type: 'set',
              key: key('reservation', id),
              value: JSON.stringify({ refundId: id, amount: refund.amount, status: 'released' }),
            },
          ],
        )
      )
        return true;
    }
  }
  async function apply(
    id: string,
    fence: number,
    status: 'provider-pending' | 'succeeded' | 'failed' | 'needs-reconciliation',
    receipt?: string,
  ): Promise<boolean> {
    for (;;) {
      const raw = await records.get(refundKey(id));
      const refund = parse<Refund>(raw);
      if (
        !refund ||
        refund.fence !== fence ||
        refund.status === 'admitted' ||
        refund.status === 'succeeded' ||
        refund.status === 'failed'
      )
        return false;
      const accountKey = chargeKey(refund.merchant, refund.order);
      const accountRaw = await records.get(accountKey);
      const account = parse<Charge>(accountRaw);
      if (!account) throw new Error('Charge not found');
      if ((status === 'succeeded' || status === 'provider-pending') && !receipt)
        throw new Error('Receipt required');
      const terminal = status === 'succeeded' || status === 'failed';
      const next = { ...refund, status, ...(receipt === undefined ? {} : { receipt }) };
      const nextAccount = {
        ...account,
        reserved: (account.reserved ?? 0) - (terminal ? refund.amount : 0),
        settled: (account.settled ?? 0) + (status === 'succeeded' ? refund.amount : 0),
      };
      if (
        await records.conditionalBatch(
          [
            { key: refundKey(id), expectedValue: raw },
            { key: accountKey, expectedValue: accountRaw },
          ],
          [
            { type: 'set', key: refundKey(id), value: JSON.stringify(next) },
            { type: 'set', key: accountKey, value: JSON.stringify(nextAccount) },
            ...(terminal
              ? [
                  {
                    type: 'set' as const,
                    key: key('reservation', id),
                    value: JSON.stringify({
                      refundId: id,
                      amount: refund.amount,
                      status: status === 'succeeded' ? 'settled' : 'released',
                    }),
                  },
                ]
              : []),
          ],
        )
      )
        return true;
    }
  }
  return {
    addCharge,
    get,
    find,
    recoverable,
    awaitingReview,
    balance,
    admit,
    getStart,
    pendingStarts,
    startForRun,
    claimStart,
    completeStart,
    linkReview,
    cancel,
    claim,
    apply,
  };
}
