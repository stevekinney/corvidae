import { stopWhen } from '@lostgradient/operative';
import { MemoryStorage } from '@lostgradient/weft';
import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';

import { createBureau } from './create-bureau';
import { createSessionInputMailbox } from './session-input-durability';
import {
  admitsSessionInput,
  deferred,
  readsWorkflows,
  savesSessionAs,
  seamStorage,
} from './test/session-input-fixtures';
import type { BureauDiagnostic } from './types';

/**
 * COR-1476 — `submitSessionInput` writes the marker, commits the admission,
 * catches up steering, and reads liveness, in that order. With no run live or
 * starting it cancels its own input and returns the re-read receipt; a liveness
 * read that fails is answered the same way.
 */

const input = { id: 'input-x', principal: 'alice', deliveryMode: 'steer' as const, payload: 'hi' };

/**
 * A bureau whose only run has finished, with the write that marks the session
 * completed held: the session still reads as running, and no run is live.
 */
async function finishedRunWithHeldTerminalWrite() {
  const seam = seamStorage(new MemoryStorage());
  const diagnostics: BureauDiagnostic[] = [];
  const bureau = await createBureau({
    agents: {},
    generate: async () => ({ content: 'answer', toolCalls: [] }),
    toolbox: createToolbox([]),
    storage: seam.storage,
    durableExecution: true,
    stopWhen: stopWhen.noToolCalls(),
    onDiagnostic: (diagnostic) => void diagnostics.push(diagnostic),
  });
  const held = seam.holdWrite(savesSessionAs('completed'));
  const run = await bureau.createRun({ message: 'First', principal: 'alice', maximumSteps: 1 });
  await held.reached;
  return { seam, bureau, run, held, diagnostics };
}

describe('submitSessionInput with no run to deliver the input (COR-1476)', () => {
  it('cancels its own input and returns the re-read receipt', async () => {
    const { seam, bureau, run, held } = await finishedRunWithHeldTerminalWrite();
    try {
      const outcome = await bureau.submitSessionInput(run.sessionId, input);

      expect(outcome.outcome).toBe('admitted');
      if (outcome.outcome !== 'admitted') throw new Error('expected admitted');
      expect(outcome.receipt.state).toBe('canceled');
      expect(outcome.receipt.id).toBe('input-x');
      const mailbox = createSessionInputMailbox(seam.storage, run.sessionId, 100);
      const [receipt] = await mailbox.list({ limit: 10 });
      expect(receipt?.state).toBe('cancelled');
      expect(receipt?.cancellationReason).toBe('the run ended before the input was delivered');

      // A retry reads the same terminal receipt.
      const retry = await bureau.submitSessionInput(run.sessionId, input);
      expect(retry.outcome).toBe('replayed');
      if (retry.outcome === 'replayed') expect(retry.receipt.state).toBe('canceled');
    } finally {
      held.release();
      await bureau.dispose();
    }
  });

  it('fails closed when the liveness read throws: the input is cancelled rather than left open', async () => {
    const { seam, bureau, run, held, diagnostics } = await finishedRunWithHeldTerminalWrite();
    // Once the admission has committed, the engine cannot be read.
    const failing = seam.failReads(
      readsWorkflows,
      new Error('the engine is unavailable'),
      seam.awaitWrite(admitsSessionInput),
    );
    try {
      const outcome = await bureau.submitSessionInput(run.sessionId, input);

      expect(outcome.outcome).toBe('admitted');
      if (outcome.outcome !== 'admitted') throw new Error('expected admitted');
      expect(outcome.receipt.state).toBe('canceled');
      expect(failing.attempts()).toBeGreaterThan(0);
      expect(
        diagnostics.some(
          (diagnostic) =>
            diagnostic.scope === 'session-input' &&
            diagnostic.message.includes('cancelled rather than left open'),
        ),
      ).toBe(true);
    } finally {
      failing.stop();
      held.release();
      await bureau.dispose();
    }
  });
});

describe('submitSessionInput with a live run (COR-1476)', () => {
  it('leaves the input admitted for the run to deliver', async () => {
    const started = deferred();
    const release = deferred();
    const bureau = await createBureau({
      agents: {},
      generate: async () => {
        started.resolve();
        await release.promise;
        return { content: 'answer', toolCalls: [] };
      },
      toolbox: createToolbox([]),
      storage: new MemoryStorage(),
      durableExecution: true,
      stopWhen: stopWhen.noToolCalls(),
    });
    try {
      const run = await bureau.createRun({ message: 'First', principal: 'alice' });
      await started.promise;
      const outcome = await bureau.submitSessionInput(run.sessionId, input);
      expect(outcome.outcome).toBe('admitted');
      if (outcome.outcome === 'admitted') expect(outcome.receipt.state).toBe('accepted');
    } finally {
      release.resolve();
      await bureau.dispose();
    }
  });
});
