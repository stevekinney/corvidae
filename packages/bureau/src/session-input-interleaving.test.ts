import { type GenerateContext, type GenerateFunction, stopWhen } from '@lostgradient/operative';
import { resolveStorage, type Storage } from '@lostgradient/weft';
import { createToolbox } from 'armorer';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createBureau } from './create-bureau';
import { createSessionInputMailbox } from './session-input-durability';
import {
  admitsSessionInput,
  cancelsSessionInput,
  deferred,
  logsRunEnded,
  readsMailbox,
  readsSteeringHead,
  savesSessionAs,
  seamStorage,
  type StorageSeam,
  userTexts,
} from './test/session-input-fixtures';
import type { Bureau } from './types';

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

async function openProcess(
  generate: GenerateFunction,
): Promise<{ bureau: Bureau; seam: StorageSeam; real: Storage }> {
  const real = await resolveStorage({ type: 'sqlite', path });
  const seam = seamStorage(real);
  const bureau = await createBureau({
    agents: {},
    generate,
    toolbox: createToolbox([]),
    storage: seam.storage,
    durableExecution: true,
    stopWhen: stopWhen.noToolCalls(),
  });
  return { bureau, seam, real };
}

const input = { id: 'input-x', principal: 'alice', deliveryMode: 'steer' as const, payload: 'X' };

async function mailboxState(storage: Storage, sessionId: string) {
  const [receipt] = await createSessionInputMailbox(storage, sessionId, 100).list({ limit: 10 });
  return receipt?.state;
}

describe('admission against a run ending, across two processes (COR-1476)', () => {
  it("(a) the submit side's liveness read is held until the ending run's mailbox read finishes: the run cancels, the submit reads canceled", async () => {
    const stepZeroStarted = deferred();
    const releaseStepZero = deferred();
    const a = await openProcess(async () => {
      stepZeroStarted.resolve();
      await releaseStepZero.promise;
      return { content: 'answer', toolCalls: [] };
    });
    const b = await openProcess(async () => {
      throw new Error('process B never generates');
    });
    const holds: Array<{ release: () => void }> = [];
    try {
      const run = await a.bureau.createRun({
        message: 'First',
        principal: 'alice',
        maximumSteps: 1,
      });
      await stepZeroStarted.promise;

      // B admits the input while the run is live, and its post-admission
      // liveness read (the steering catch-up it begins with) is held.
      const heldLiveness = b.seam.holdRead(
        readsSteeringHead,
        b.seam.awaitWrite(admitsSessionInput),
      );
      holds.push(heldLiveness);
      const submitting = b.bureau.submitSessionInput(run.sessionId, input);
      await heldLiveness.reached;

      // The run ends: it records its end, reads the mailbox, and cancels the input.
      const cancelledByA = a.seam.awaitWrite(cancelsSessionInput);
      releaseStepZero.resolve();
      await cancelledByA;
      expect(await mailboxState(a.real, run.sessionId)).toBe('cancelled');

      // B's liveness read proceeds: no run is live, and the input it would
      // cancel is already cancelled. It reads the receipt back: canceled.
      heldLiveness.release();
      const outcome = await submitting;
      expect(outcome.outcome).toBe('admitted');
      if (outcome.outcome === 'admitted') expect(outcome.receipt.state).toBe('canceled');
      await a.bureau.waitForDurableRun(run.id);
      expect(a.bureau.listRuns()).toHaveLength(1);
      expect(b.bureau.listRuns()).toHaveLength(0);
    } finally {
      releaseStepZero.resolve();
      holds.forEach((hold) => hold.release());
      await b.bureau.dispose();
      await a.bureau.dispose();
      b.real[Symbol.dispose]();
      a.real[Symbol.dispose]();
    }
  });

  it("(b) the ending run's mailbox read is held until the admission commits: the submit cancels, the run finds nothing open", async () => {
    const stepZeroStarted = deferred();
    const a = await openProcess(async () => {
      stepZeroStarted.resolve();
      return new Promise<never>(() => {});
    });
    const b = await openProcess(async () => {
      throw new Error('process B never generates');
    });
    const holds: Array<{ release: () => void }> = [];
    try {
      const run = await a.bureau.createRun({ message: 'First', principal: 'alice' });
      await stepZeroStarted.promise;

      // The run is cancelled. Its settlement writes `run-ended` first, and its
      // mailbox read, which comes after, is held. The session's terminal save
      // is held too, so the session still reads as running to the submit side.
      const heldTerminalSave = a.seam.holdWrite(savesSessionAs('aborted'));
      const heldMailboxRead = a.seam.holdRead(readsMailbox, a.seam.awaitWrite(logsRunEnded));
      holds.push(heldTerminalSave, heldMailboxRead);
      const cancelling = a.bureau.cancelDurableRun(run.id);
      await heldMailboxRead.reached;

      // B admits the input now. Its liveness read folds the run's end and finds
      // nothing live, so it cancels the input itself.
      const outcome = await b.bureau.submitSessionInput(run.sessionId, input);
      expect(outcome.outcome).toBe('admitted');
      if (outcome.outcome === 'admitted') expect(outcome.receipt.state).toBe('canceled');
      expect(await mailboxState(a.real, run.sessionId)).toBe('cancelled');

      // The run's read proceeds and finds the input already cancelled.
      heldMailboxRead.release();
      const cancelled = await cancelling;
      expect(cancelled.status).toBe('requested');
      heldTerminalSave.release();
      await a.bureau.waitForDurableRun(run.id);
      expect(await mailboxState(a.real, run.sessionId)).toBe('cancelled');
      expect(a.bureau.listRuns()).toHaveLength(1);
      expect(b.bureau.listRuns()).toHaveLength(0);
    } finally {
      holds.forEach((hold) => hold.release());
      await b.bureau.dispose();
      await a.bureau.dispose();
      b.real[Symbol.dispose]();
      a.real[Symbol.dispose]();
    }
  });
});

describe('a run whose session is recreated while it starts (COR-1476)', () => {
  it('never delivers input admitted to the new incarnation: its gate is bound to the incarnation it was promoted in', async () => {
    const SESSION = 'session-recreated';
    const prompts1: string[][] = [];
    const run1Started = deferred();
    const a = await openProcess(async (context: GenerateContext) => {
      prompts1.push(userTexts(context.conversation));
      run1Started.resolve();
      return new Promise<never>(() => {});
    });
    const prompts2: string[][] = [];
    const run2Started = deferred();
    const release2 = deferred();
    const b = await openProcess(async (context: GenerateContext) => {
      prompts2.push(userTexts(context.conversation));
      if (prompts2.length === 1) {
        run2Started.resolve();
        await release2.promise;
      }
      return { content: 'done', toolCalls: [] };
    });
    const holds: Array<{ release: () => void }> = [];
    try {
      // Process A starts run 1. Its start loads the session body twice after
      // its running save committed: once for its steering promotion, once to
      // build its input gate. The second load is held.
      let bodyReads = 0;
      const gateLoad = a.seam.holdRead(
        (key) => {
          if (!key.startsWith('agent-session-v2:body:')) return false;
          bodyReads += 1;
          return bodyReads === 2;
        },
        a.seam.awaitWriteCommitted(savesSessionAs('running')),
      );
      holds.push(gateLoad);
      const creating = a.bureau.createRun({
        message: 'First',
        principal: 'alice',
        sessionId: SESSION,
      });
      await gateLoad.reached;

      // Process B deletes and recreates the session meanwhile, with a live run
      // of the new incarnation, and admits input to it.
      await b.bureau.deleteSession(SESSION);
      const second = await b.bureau.createRun({
        message: 'Second',
        principal: 'alice',
        sessionId: SESSION,
      });
      await run2Started.promise;
      const admitted = await b.bureau.submitSessionInput(SESSION, input);
      expect(admitted.outcome).toBe('admitted');

      // Run 1 starts on the session it was promoted in, which is gone: it has
      // no gate, and its first step sees only its own message.
      gateLoad.release();
      await creating;
      await run1Started.promise;
      expect(prompts1).toEqual([['First']]);

      // The new incarnation's run delivers the input at its next boundary.
      release2.resolve();
      await b.bureau.waitForDurableRun(second.id);
      expect(prompts2).toEqual([['Second'], ['Second', 'X']]);
    } finally {
      release2.resolve();
      holds.forEach((hold) => hold.release());
      await a.bureau.dispose();
      await b.bureau.dispose();
    }
  });
});

describe("a run's end against a session recreated while it ran (COR-1476)", () => {
  it("leaves the recreated incarnation's open input alone: its cancel pass is bound to the incarnation it started in", async () => {
    const SESSION = 'session-recreated-at-end';
    const run1Started = deferred();
    const release1 = deferred();
    const a = await openProcess(async () => {
      run1Started.resolve();
      await release1.promise;
      return { content: 'done', toolCalls: [] };
    });
    const b = await openProcess(async () => ({ content: 'done', toolCalls: [] }));
    try {
      const first = await a.bureau.createRun({
        message: 'First',
        principal: 'alice',
        sessionId: SESSION,
      });
      await run1Started.promise;

      // Process B deletes and recreates the session; its run ends at once, and
      // input for the new incarnation is admitted directly to the mailbox, with
      // no run live to deliver it yet.
      await b.bureau.deleteSession(SESSION);
      const second = await b.bureau.createRun({
        message: 'Second',
        principal: 'alice',
        sessionId: SESSION,
      });
      await b.bureau.waitForDurableRun(second.id);
      const recreated = await b.bureau.getSession(SESSION);
      const admission = await createSessionInputMailbox(b.real, SESSION, 100).admit({
        caller: 'alice',
        target: SESSION,
        kind: 'session-input:steer',
        payload: {
          form: 'inline',
          value: { incarnation: recreated?.incarnation ?? '', payload: 'for the new session' },
        },
        idempotencyKey: 'input-new',
      });
      if (admission.status !== 'admitted') throw new Error(admission.status);

      // Run 1 ends. Its settlement finds a session it did not start in and
      // cancels nothing; the new incarnation's input is the sweep's or its own
      // run's to settle.
      release1.resolve();
      await a.bureau.waitForDurableRun(first.id);
      // Disposal drains the run-end settlement.
      await a.bureau.dispose();
      expect(await mailboxState(b.real, SESSION)).toBe('available');
    } finally {
      release1.resolve();
      await a.bureau.dispose();
      await b.bureau.dispose();
    }
  });
});
