import { MemoryStorage, textValueStore } from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import { createSessionInputMailbox } from './session-input-durability';
import {
  cancelOpenSessionInput,
  createSessionInputSettlement,
  forEachOpenReceipt,
  OPEN_SESSION_INPUT_STATES,
  SESSION_INPUT_RUN_ENDED_REASON,
} from './session-input-settlement';

/**
 * COR-1476 — the marker index of sessions with open input, and the sweep that
 * cancels input no run will deliver: only with no run live or starting, in
 * admission order, in full, and never while the bureau is closing.
 */

const SESSION_ID = 'settlement-session';
const MARKER_PREFIX = 'session-input-open:v1:';

function fixture() {
  const storage = new MemoryStorage();
  const kv = textValueStore(storage, { disposeUnderlyingStorage: false });
  const mailbox = createSessionInputMailbox(storage, SESSION_ID, 1000);
  let live: readonly string[] = [];
  let closed = false;
  let incarnation: string | undefined = 'incarnation-1';
  const diagnostics: string[] = [];
  const settlement = createSessionInputSettlement({
    kv,
    incarnationOf: () => Promise.resolve(incarnation),
    liveRunIds: () => Promise.resolve(live),
    mailboxOf: () => mailbox,
    isClosed: () => closed,
    diagnose: (message) => void diagnostics.push(message),
  });

  /** What a submit does: marker first, then the admission. */
  async function admit(id: string): Promise<string> {
    await settlement.markOpen(SESSION_ID);
    return admitOnly(id);
  }
  async function admitOnly(id: string): Promise<string> {
    const admission = await mailbox.admit({
      caller: 'alice',
      target: SESSION_ID,
      kind: 'session-input:steer',
      payload: { form: 'inline', value: { incarnation: 'incarnation-1', payload: id } },
      idempotencyKey: id,
    });
    if (admission.status !== 'admitted')
      throw new Error(`expected admitted, got ${admission.status}`);
    return admission.receipt.commandId;
  }

  return {
    kv,
    mailbox,
    settlement,
    admit,
    admitOnly,
    diagnostics,
    setLive: (runIds: readonly string[]) => {
      live = runIds;
    },
    setClosed: (value: boolean) => {
      closed = value;
    },
    deleteSession: () => {
      incarnation = undefined;
    },
    markers: () => kv.list(MARKER_PREFIX),
    /** Each command's id and state, with every open state read as `open`. */
    states: async () => {
      const receipts = await mailbox.list({ limit: 1000 });
      return receipts.map(
        (receipt) =>
          [
            receipt.idempotencyKey,
            (OPEN_SESSION_INPUT_STATES as readonly string[]).includes(receipt.state)
              ? 'open'
              : receipt.state,
          ] as const,
      );
    },
    openCount: async () => {
      const open = await mailbox.list({ states: OPEN_SESSION_INPUT_STATES, limit: 1000 });
      return open.length;
    },
  };
}

describe('the open-input marker and the sweep (COR-1476)', () => {
  it('heals a crash between the marker and the admission: the sweep removes the marker over an empty mailbox', async () => {
    const f = fixture();
    await f.settlement.markOpen(SESSION_ID);
    expect(await f.markers()).toHaveLength(1);

    await f.settlement.sweep();

    expect(await f.markers()).toHaveLength(0);
  });

  it('leaves open input, and its marker, alone while a run is live or starting', async () => {
    const f = fixture();
    await f.admit('input-x');
    f.setLive(['run-1']);

    await f.settlement.sweep();

    expect(await f.states()).toEqual([['input-x', 'open']]);
    expect(await f.markers()).toHaveLength(1);
  });

  it('cancels open input in admission order, with the run-ended reason, and removes the marker, when no run is live', async () => {
    const f = fixture();
    await f.admit('input-x');
    await f.admit('input-y');

    await f.settlement.sweep();

    const receipts = await f.mailbox.list({ limit: 10 });
    expect(receipts.map((receipt) => [receipt.idempotencyKey, receipt.state])).toEqual([
      ['input-x', 'cancelled'],
      ['input-y', 'cancelled'],
    ]);
    expect(receipts.map((receipt) => receipt.cancellationReason)).toEqual([
      SESSION_INPUT_RUN_ENDED_REASON,
      SESSION_INPUT_RUN_ENDED_REASON,
    ]);
    expect(await f.markers()).toHaveLength(0);
    expect(f.diagnostics).toEqual([]);
  });

  it('cancels only the input whose turn is not among the delivered commands', async () => {
    const f = fixture();
    const delivered = await f.admit('input-delivered');
    await f.admit('input-open');

    const cancelled = await f.settlement.cancelUndelivered(SESSION_ID, new Set([delivered]));

    expect(cancelled).toHaveLength(1);
    expect(await f.states()).toEqual([
      ['input-delivered', 'open'],
      ['input-open', 'cancelled'],
    ]);
    // Something is still open, so the marker stays for the next sweep.
    expect(await f.markers()).toHaveLength(1);
  });

  it('cancels nothing while the bureau is closing', async () => {
    const f = fixture();
    await f.admit('input-x');
    f.setClosed(true);

    await f.settlement.sweep();

    expect(await f.states()).toEqual([['input-x', 'open']]);
    expect(await f.markers()).toHaveLength(1);
  });

  it('removes the marker of a deleted session, whose deletion retired its input', async () => {
    const f = fixture();
    await f.settlement.markOpen(SESSION_ID);
    f.deleteSession();

    await f.settlement.sweep();

    expect(await f.markers()).toHaveLength(0);
  });

  it('cancels open input with no marker at all: a missing marker is never a reason to return early', async () => {
    const f = fixture();
    // The marker was removed between a submit's bump and its admission.
    await f.admitOnly('input-x');
    expect(await f.markers()).toHaveLength(0);

    const cancelled = await f.settlement.cancelUndelivered(SESSION_ID, new Set());

    expect(cancelled).toHaveLength(1);
    expect(await f.states()).toEqual([['input-x', 'cancelled']]);
  });

  it('keeps the marker when the listing is empty but the mailbox counts open input', async () => {
    const f = fixture();
    await f.admit('input-x');
    // A listing stops at a scan ceiling: here it finds nothing, while the
    // mailbox's own open count still says one command is open.
    const original = f.mailbox.list.bind(f.mailbox);
    f.mailbox.list = async () => [];
    try {
      await f.settlement.sweep();
    } finally {
      f.mailbox.list = original;
    }

    expect(await f.markers()).toHaveLength(1);
    expect(await f.states()).toEqual([['input-x', 'open']]);
  });

  it('keeps an input listed when a remover deletes the marker between the submit bump and the admission', async () => {
    const f = fixture();
    // The submit's first bump.
    await f.settlement.markOpen(SESSION_ID);
    // A remover reads the bumped marker and an empty mailbox; the admission
    // commits right after its emptiness read; its conditional delete then
    // succeeds, because the marker's version has not changed.
    const originalCapacity = f.mailbox.capacity.bind(f.mailbox);
    let admitted = false;
    f.mailbox.capacity = async () => {
      const result = await originalCapacity();
      if (!admitted) {
        admitted = true;
        await f.admitOnly('input-x');
      }
      return result;
    };
    try {
      await f.settlement.sweep();
    } finally {
      f.mailbox.capacity = originalCapacity;
    }
    expect(admitted).toBe(true);
    expect(await f.markers()).toHaveLength(0);
    expect(await f.states()).toEqual([['input-x', 'open']]);

    // The submit's second bump, after its admission committed, lists it again,
    // and the next sweep settles it.
    await f.settlement.markOpen(SESSION_ID);
    expect(await f.markers()).toHaveLength(1);
    await f.settlement.sweep();
    expect(await f.states()).toEqual([['input-x', 'cancelled']]);
    expect(await f.markers()).toHaveLength(0);
  });

  it('does not remove a marker over input admitted after the marker was read', async () => {
    const f = fixture();
    await f.settlement.markOpen(SESSION_ID);
    // The sweep reads the marker, then the mailbox: input admitted between the
    // two bumps the marker, so the sweep's conditional delete loses.
    const reads: string[] = [];
    const original = f.mailbox.list.bind(f.mailbox);
    let admitted = false;
    f.mailbox.list = async (options) => {
      const result = await original(options);
      if (!admitted) {
        admitted = true;
        reads.push('mailbox');
        await f.admit('input-late');
      }
      return result;
    };

    await f.settlement.sweep();

    expect(reads).toEqual(['mailbox']);
    expect(await f.markers()).toHaveLength(1);
    expect(await f.states()).toEqual([['input-late', 'open']]);
  });
});

describe('a lease a gone holder left behind (COR-1476)', () => {
  it('is cancelled while it stands, and settles once it lapses, with the marker removed', async () => {
    let now = Date.parse('2026-10-17T12:00:00.000Z');
    const storage = new MemoryStorage();
    const kv = textValueStore(storage, { disposeUnderlyingStorage: false });
    const mailbox = createSessionInputMailbox(storage, SESSION_ID, 1000, () => now);
    const settlement = createSessionInputSettlement({
      kv,
      incarnationOf: () => Promise.resolve('incarnation-1'),
      liveRunIds: () => Promise.resolve([]),
      mailboxOf: () => mailbox,
      isClosed: () => false,
      diagnose: () => {},
    });
    await settlement.markOpen(SESSION_ID);
    await mailbox.admit({
      caller: 'alice',
      target: SESSION_ID,
      kind: 'session-input:steer',
      payload: { form: 'inline', value: { incarnation: 'incarnation-1', payload: 'x' } },
      idempotencyKey: 'input-x',
    });
    // A gate in a process that then died claims it.
    const claimed = await mailbox.claim();
    expect(claimed.status).toBe('claimed');
    const state = async () => {
      const [receipt] = await mailbox.list({ limit: 10 });
      return receipt?.state;
    };

    // The lease still stands: the cancellation is requested, and the marker
    // stays until the command is over.
    await settlement.sweep();
    expect(await state()).toBe('cancellation-requested');
    expect(await kv.list(MARKER_PREFIX)).toHaveLength(1);

    // Past the visibility timeout, the sweep's maintenance settles it.
    now += 31_000;
    await settlement.sweep();
    expect(await state()).toBe('cancelled');
    expect(await kv.list(MARKER_PREFIX)).toHaveLength(0);
  });
});

describe('a deleted session over a lease a gone holder left behind (COR-1476)', () => {
  it('clears the marker once the lease lapses, because the idle check runs maintenance first', async () => {
    let now = Date.parse('2026-10-17T12:00:00.000Z');
    const storage = new MemoryStorage();
    const kv = textValueStore(storage, { disposeUnderlyingStorage: false });
    const mailbox = createSessionInputMailbox(storage, SESSION_ID, 1000, () => now);
    let incarnation: string | undefined = 'incarnation-1';
    const settlement = createSessionInputSettlement({
      kv,
      incarnationOf: () => Promise.resolve(incarnation),
      liveRunIds: () => Promise.resolve([]),
      mailboxOf: () => mailbox,
      isClosed: () => false,
      diagnose: () => {},
    });
    await settlement.markOpen(SESSION_ID);
    const admitted = await mailbox.admit({
      caller: 'alice',
      target: SESSION_ID,
      kind: 'session-input:steer',
      payload: { form: 'inline', value: { incarnation: 'incarnation-1', payload: 'x' } },
      idempotencyKey: 'input-x',
    });
    if (admitted.status !== 'admitted') throw new Error('expected admitted');
    const claimed = await mailbox.claim();
    expect(claimed.status).toBe('claimed');
    // The session is deleted: its open input is asked to cancel, which the
    // gone holder never settles.
    incarnation = undefined;
    await mailbox.requestCancellation({
      commandId: admitted.receipt.commandId,
      reason: 'the session was deleted',
    });
    const state = async () => {
      const [receipt] = await mailbox.list({ limit: 10 });
      return receipt?.state;
    };

    await settlement.sweep();
    expect(await state()).toBe('cancellation-requested');
    expect(await kv.list(MARKER_PREFIX)).toHaveLength(1);

    now += 31_000;
    await settlement.sweep();
    expect(await state()).toBe('cancelled');
    expect(await kv.list(MARKER_PREFIX)).toHaveLength(0);
  });
});

describe('backlog paging (COR-1476)', () => {
  it('cancels a backlog deeper than one batch in full', async () => {
    const f = fixture();
    for (let index = 0; index < 250; index += 1) await f.admitOnly(`input-${index}`);

    const cancelled = await cancelOpenSessionInput(f.mailbox, new Set());

    expect(cancelled).toHaveLength(250);
    expect(await f.openCount()).toBe(0);
    expect(await f.mailbox.list({ states: ['cancelled'], limit: 1000 })).toHaveLength(250);
  });

  it('ends on a page of commands whose cancellation was already requested, and still reaches the input behind it', async () => {
    const f = fixture();
    for (let index = 0; index < 150; index += 1) await f.admitOnly(`input-${index}`);
    // The first hundred are leased by a run elsewhere, and their cancellation
    // has been requested: they stay `cancellation-requested` until that run
    // settles them, which nothing here can do.
    for (let index = 0; index < 100; index += 1) {
      const claimed = await f.mailbox.claim();
      if (claimed.status !== 'claimed') throw new Error('expected a claim');
      await f.mailbox.requestCancellation({
        commandId: claimed.claim.receipt.commandId,
        reason: 'leased elsewhere',
      });
    }
    expect(await f.mailbox.list({ states: ['cancellation-requested'], limit: 1000 })).toHaveLength(
      100,
    );

    const visited: string[] = [];
    await forEachOpenReceipt(f.mailbox, async (commandId) => {
      visited.push(commandId);
      await f.mailbox.requestCancellation({ commandId, reason: SESSION_INPUT_RUN_ENDED_REASON });
    });

    expect(visited).toHaveLength(50);
    expect(await f.mailbox.list({ states: ['cancelled'], limit: 1000 })).toHaveLength(50);
    expect(await f.mailbox.list({ states: ['cancellation-requested'], limit: 1000 })).toHaveLength(
      100,
    );
  });
});
