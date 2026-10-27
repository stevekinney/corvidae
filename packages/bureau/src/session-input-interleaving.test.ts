import type { GenerateContext } from '@lostgradient/operative';
import type { Storage } from '@lostgradient/weft';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSessionInputMailbox } from './session-input-durability';
import {
  admitsSessionInput,
  cancelsSessionInput,
  deferred,
  openProcess,
  pollUntil,
  readsMailbox,
  readsSteeringHead,
  userTexts,
} from './test/session-input-fixtures';
import type { Bureau } from './types';
import { startTaskFrom } from './test/task-start-request.ts';
import { listHeldTasks } from './test';

/**
 * COR-1476 — admission against a run's end, with two Bureau processes on one
 * backend and the interleaving forced by a storage seam that holds one read.
 * Whichever side reads second sees the other: the input ends `canceled` or
 * `promoted`, never open.
 */

let directory: string;
let path: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'corvidae-session-input-interleaving-'));
  path = join(directory, 'bureau.sqlite');
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

const input = { id: 'input-x', principal: 'alice', deliveryMode: 'steer' as const, payload: 'X' };

/** The state of the session's one input, in its current incarnation's mailbox. */
async function mailboxState(bureau: Bureau, storage: Storage, sessionId: string) {
  const session = await bureau.contexts.get(sessionId);
  if (session === undefined) throw new Error(`session ${sessionId} is gone`);
  const mailbox = createSessionInputMailbox(storage, sessionId, session.incarnation, 100);
  const [receipt] = await mailbox.list({ limit: 10 });
  return receipt?.state;
}

describe('admission against a run ending, across two processes (COR-1476)', () => {
  it("(a) the submit side's liveness read is held until the ending run's mailbox read finishes: the run cancels, the submit reads canceled", async () => {
    const stepZeroStarted = deferred();
    const releaseStepZero = deferred();
    const a = await openProcess(
      path,
      async () => {
        stepZeroStarted.resolve();
        await releaseStepZero.promise;
        return { content: 'answer', toolCalls: [] };
      },
      { maximumSteps: 1 },
    );
    const b = await openProcess(path, async () => {
      throw new Error('process B never generates');
    });
    const holds: Array<{ release: () => void }> = [];
    try {
      const run = await startTaskFrom(a.bureau, {
        agentName: 'default',
        input: 'First',
        principal: 'alice',
      });
      await stepZeroStarted.promise;

      // B admits the input while the run is live, and its post-admission
      // liveness read (the steering catch-up it begins with) is held.
      const heldLiveness = b.seam.holdRead(
        readsSteeringHead,
        b.seam.awaitWrite(admitsSessionInput),
      );
      holds.push(heldLiveness);
      const submitting = b.bureau.contexts.input(run.contextId, input);
      await heldLiveness.reached;

      // The run ends: it records its end, reads the mailbox, and cancels the input.
      const cancelledByA = a.seam.awaitWrite(cancelsSessionInput);
      releaseStepZero.resolve();
      await cancelledByA;
      expect(await mailboxState(a.bureau, a.real, run.contextId)).toBe('cancelled');

      // B's liveness read proceeds: no run is live, and the input it would
      // cancel is already cancelled. It reads the receipt back: canceled.
      heldLiveness.release();
      const outcome = await submitting;
      expect(outcome.outcome).toBe('admitted');
      if (outcome.outcome === 'admitted') expect(outcome.receipt.state).toBe('canceled');
      await a.bureau.tasks.wait(run.id);
      expect(listHeldTasks(a.bureau)).toHaveLength(1);
      expect(listHeldTasks(b.bureau)).toHaveLength(0);
    } finally {
      releaseStepZero.resolve();
      holds.forEach((hold) => hold.release());
      await b.bureau.dispose();
      await a.bureau.dispose();
      b.real[Symbol.dispose]();
      a.real[Symbol.dispose]();
    }
  });
});

describe("a run's end against a session recreated while it ran (COR-1476)", () => {
  it("touches only its own incarnation's mailbox: it cancels what that incarnation left open and never the recreated session's input", async () => {
    const SESSION = 'session-recreated-at-end';
    const run1Started = deferred();
    const release1 = deferred();
    const a = await openProcess(
      path,
      async () => {
        run1Started.resolve();
        await release1.promise;
        return { content: 'done', toolCalls: [] };
      },
      { maximumSteps: 1 },
    );
    const b = await openProcess(path, async () => ({ content: 'done', toolCalls: [] }));
    try {
      const first = await startTaskFrom(a.bureau, {
        agentName: 'default',
        input: 'First',
        principal: 'alice',
        contextId: SESSION,
      });
      await run1Started.promise;
      const oldSession = await a.bureau.contexts.get(SESSION);
      if (oldSession === undefined) throw new Error('the session is gone');

      // Process B deletes and recreates the session; its run ends at once.
      // Input lands in both incarnations' mailboxes with no run live for the
      // new one: one admitted late under the old incarnation, which run 1, on
      // its last step, can no longer deliver, and one for the new.
      await b.bureau.contexts.delete(SESSION);
      const second = await b.bureau.tasks.start('default', 'Second', {
        contextId: SESSION,
        principal: 'alice',
      });
      await b.bureau.tasks.wait(second.id);
      const recreated = await b.bureau.contexts.get(SESSION);
      if (recreated === undefined) throw new Error('the recreated session is gone');
      const admitTo = async (incarnation: string, id: string) => {
        const mailbox = createSessionInputMailbox(b.real, SESSION, incarnation, 100);
        const admission = await mailbox.admit({
          caller: 'alice',
          target: SESSION,
          kind: 'session-input:steer',
          payload: { form: 'inline', value: { incarnation, payload: id } },
          idempotencyKey: id,
        });
        if (admission.status !== 'admitted') throw new Error(admission.status);
        return { mailbox, commandId: admission.receipt.commandId };
      };
      const old = await admitTo(oldSession.incarnation, 'input-old');
      const fresh = await admitTo(recreated.incarnation, 'input-new');

      // Run 1 ends. Its settlement reads and cancels its own incarnation's
      // mailbox, which is what it started in, and nothing else.
      release1.resolve();
      await a.bureau.tasks.wait(first.id);
      // The settlement follows the run's terminal save.
      await pollUntil(async () => {
        const receipt = await old.mailbox.receipt(old.commandId);
        return receipt?.state === 'cancelled';
      });
      const freshReceipt = await fresh.mailbox.receipt(fresh.commandId);
      expect(freshReceipt?.state).toBe('available');
    } finally {
      release1.resolve();
      await a.bureau.dispose();
      await b.bureau.dispose();
    }
  });
});

describe('input admitted to a recreated session while an old run still drains (COR-1476)', () => {
  it("reaches the new incarnation's run and is never refused by the old one: each incarnation has its own mailbox", async () => {
    const SESSION = 'session-window';
    const stepZeroStarted = deferred();
    const releaseStepZero = deferred();
    const a = await openProcess(
      path,
      async () => {
        stepZeroStarted.resolve();
        await releaseStepZero.promise;
        return { content: 'answer', toolCalls: [] };
      },
      { maximumSteps: 3 },
    );
    const prompts2: string[][] = [];
    const run2Started = deferred();
    const release2 = deferred();
    const b = await openProcess(path, async (context: GenerateContext) => {
      prompts2.push(userTexts(context.conversation));
      if (prompts2.length === 1) {
        run2Started.resolve();
        await release2.promise;
      }
      return { content: 'done', toolCalls: [] };
    });
    const holds: Array<{ release: () => void }> = [];
    try {
      const run = await startTaskFrom(a.bureau, {
        agentName: 'default',
        input: 'First',
        principal: 'alice',
        contextId: SESSION,
      });
      await stepZeroStarted.promise;
      // The late drain after step 0: the old run's gate's first mailbox read is held.
      const held = a.seam.holdRead(readsMailbox);
      holds.push(held);
      releaseStepZero.resolve();
      await held.reached;

      // Inside that window process B deletes and recreates the session, its run
      // holds the new incarnation's step, and the client submits input to it.
      await b.bureau.contexts.delete(SESSION);
      const second = await b.bureau.tasks.start('default', 'Second', {
        contextId: SESSION,
        principal: 'alice',
      });
      await run2Started.promise;
      const admitted = await b.bureau.contexts.input(SESSION, input);
      expect(admitted.outcome).toBe('admitted');

      // The old run drains its own, empty mailbox and ends; the new run
      // delivers the input at its next boundary.
      held.release();
      await a.bureau.tasks.wait(run.id);
      release2.resolve();
      await b.bureau.tasks.wait(second.id);
      expect(prompts2).toEqual([['Second'], ['Second', 'X']]);
      expect(await mailboxState(b.bureau, b.real, SESSION)).toBe('applied');
    } finally {
      releaseStepZero.resolve();
      release2.resolve();
      holds.forEach((hold) => hold.release());
      await a.bureau.dispose();
      await b.bureau.dispose();
    }
  });
});
