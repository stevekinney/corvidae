import { stopWhen, createAgent } from '@lostgradient/operative';
import { MemoryStorage, textValueStore } from '@lostgradient/weft';
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
import type { AgentDefinitions } from './agent-catalog';
import { quietFor } from '@lostgradient/testing/wait-until';

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
  const bureau = await createBureau<AgentDefinitions>({
    agents: {
      default: createAgent({
        generate: async () => ({ content: 'answer', toolCalls: [] }),
        toolbox: createToolbox([]),
        stopWhen: stopWhen.noToolCalls(),
      }),
    },
    storage: seam.storage,
    durable: true,
    onDiagnostic: (diagnostic) => void diagnostics.push(diagnostic),
  });
  const held = seam.holdWrite(savesSessionAs('completed'));
  const run = await bureau.createRun({
    agentName: 'default',
    message: 'First',
    principal: 'alice',
    maximumSteps: 1,
  });
  await held.reached;
  return { seam, bureau, run, held, diagnostics };
}

describe('submitSessionInput with no run to deliver the input (COR-1476)', () => {
  it('cancels its own input and returns the re-read receipt', async () => {
    const { seam, bureau, run, held } = await finishedRunWithHeldTerminalWrite();
    try {
      const outcome = await bureau.contexts.input(run.sessionId, input);

      expect(outcome.outcome).toBe('admitted');
      if (outcome.outcome !== 'admitted') throw new Error('expected admitted');
      expect(outcome.receipt.state).toBe('canceled');
      expect(outcome.receipt.id).toBe('input-x');
      const session = await bureau.contexts.get(run.sessionId);
      const mailbox = createSessionInputMailbox(
        seam.storage,
        run.sessionId,
        session?.incarnation ?? '',
        100,
      );
      const [receipt] = await mailbox.list({ limit: 10 });
      expect(receipt?.state).toBe('cancelled');
      expect(receipt?.cancellationReason).toBe('the run ended before the input was delivered');

      // A retry reads the same terminal receipt.
      const retry = await bureau.contexts.input(run.sessionId, input);
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
      const outcome = await bureau.contexts.input(run.sessionId, input);

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

describe('submitSessionInput marks the session again once its admission commits (COR-1476)', () => {
  it('leaves the admitted input listed when a remover deleted the first marker before the admission committed', async () => {
    const real = new MemoryStorage();
    const seam = seamStorage(real);
    const started = deferred();
    const release = deferred();
    const bureau = await createBureau<AgentDefinitions>({
      agents: {
        default: createAgent({
          generate: async () => {
            started.resolve();
            await release.promise;
            return { content: 'answer', toolCalls: [] };
          },
          toolbox: createToolbox([]),
          stopWhen: stopWhen.noToolCalls(),
        }),
      },
      storage: seam.storage,
      durable: true,
    });
    const holds: Array<{ release: () => void }> = [];
    try {
      const run = await bureau.createRun({
        agentName: 'default',
        message: 'First',
        principal: 'alice',
      });
      await started.promise;
      const kv = textValueStore(real, { disposeUnderlyingStorage: false });
      const admission = seam.holdWrite(admitsSessionInput);
      holds.push(admission);
      const submitting = bureau.contexts.input(run.sessionId, input);
      await admission.reached;
      // The first marker is written; a remover deletes it in this window.
      const before = await kv.list('session-input-open:v2:');
      expect(before).toHaveLength(1);
      for (const key of before) await kv.delete(key);
      admission.release();

      const outcome = await submitting;
      expect(outcome.outcome).toBe('admitted');
      if (outcome.outcome === 'admitted') expect(outcome.receipt.state).toBe('accepted');
      expect(await kv.list('session-input-open:v2:')).toHaveLength(1);
    } finally {
      holds.forEach((hold) => hold.release());
      release.resolve();
      await bureau.dispose();
    }
  });
});

describe('submitSessionInput while the bureau shuts down (COR-1476)', () => {
  it('refuses a new submit once shutdown starts, and waits for one in flight before teardown', async () => {
    const seam = seamStorage(new MemoryStorage());
    const started = deferred();
    const diagnostics: BureauDiagnostic[] = [];
    const bureau = await createBureau<AgentDefinitions>({
      agents: {
        default: createAgent({
          generate: async () => {
            started.resolve();
            return new Promise<never>(() => {});
          },
          toolbox: createToolbox([]),
          stopWhen: stopWhen.noToolCalls(),
        }),
      },
      storage: seam.storage,
      durable: true,
      onDiagnostic: (diagnostic) => void diagnostics.push(diagnostic),
    });
    const holds: Array<{ release: () => void }> = [];
    try {
      const run = await bureau.createRun({
        agentName: 'default',
        message: 'First',
        principal: 'alice',
      });
      await started.promise;
      // One admission is committed and held at the engine read that follows.
      const held = seam.holdRead(readsWorkflows, seam.awaitWrite(admitsSessionInput));
      holds.push(held);
      const events: string[] = [];
      const inFlight = bureau.contexts.input(run.sessionId, input).then((outcome) => {
        events.push(`in-flight settled: ${outcome.outcome}`);
        return outcome;
      });
      await held.reached;

      const shuttingDown = bureau.shutdown({ policy: 'abort' }).then(() => {
        events.push('shutdown resolved');
      });
      // A submit that begins after shutdown started is refused outright.
      let refusal: unknown;
      try {
        await bureau.contexts.input(run.sessionId, { ...input, id: 'input-y' });
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toBeInstanceOf(Error);
      expect((refusal as Error).message).toContain('shutting down');
      // Shutdown waits for the held admission: across a real delay it has not
      // resolved, and nothing has settled.
      await quietFor(300);
      expect(events).toEqual([]);

      // Released, the admission finishes its protocol first, on a live engine.
      held.release();
      const outcome = await inFlight;
      expect(outcome.outcome).toBe('admitted');
      await shuttingDown;
      expect(events).toEqual(['in-flight settled: admitted', 'shutdown resolved']);
      expect(
        diagnostics.filter(
          (diagnostic) =>
            diagnostic.scope === 'session-input' && diagnostic.message.includes('cancel'),
        ),
      ).toEqual([]);
    } finally {
      holds.forEach((hold) => hold.release());
      await bureau.dispose();
    }
  });
});

describe('submitSessionInput with a live run (COR-1476)', () => {
  it('leaves the input admitted for the run to deliver', async () => {
    const started = deferred();
    const release = deferred();
    const bureau = await createBureau<AgentDefinitions>({
      agents: {
        default: createAgent({
          generate: async () => {
            started.resolve();
            await release.promise;
            return { content: 'answer', toolCalls: [] };
          },
          toolbox: createToolbox([]),
          stopWhen: stopWhen.noToolCalls(),
        }),
      },
      storage: new MemoryStorage(),
      durable: true,
    });
    try {
      const run = await bureau.createRun({
        agentName: 'default',
        message: 'First',
        principal: 'alice',
      });
      await started.promise;
      const outcome = await bureau.contexts.input(run.sessionId, input);
      expect(outcome.outcome).toBe('admitted');
      if (outcome.outcome === 'admitted') expect(outcome.receipt.state).toBe('accepted');
    } finally {
      release.resolve();
      await bureau.dispose();
    }
  });
});

/** A bureau whose runs park in `generate`, each signalling once it has started. */
async function parkingBureau() {
  const starts: Array<() => void> = [];
  const bureau = await createBureau<AgentDefinitions>({
    agents: {
      default: createAgent({
        generate: async () =>
          new Promise<never>(() => {
            starts.shift()?.();
          }),
        toolbox: createToolbox([]),
        stopWhen: stopWhen.noToolCalls(),
      }),
    },
    storage: new MemoryStorage(),
    durable: true,
  });
  const startRun = async (request: { message: string; sessionId?: string }) => {
    const started = deferred();
    starts.push(started.resolve);
    const run = await bureau.createRun({ agentName: 'default', ...request, principal: 'alice' });
    await started.promise;
    return run;
  };
  return { bureau, startRun };
}

describe('an input id reused after the session is recreated (COR-1476)', () => {
  it('is admitted fresh: the recreated incarnation has its own mailbox and its own identity', async () => {
    const { bureau, startRun } = await parkingBureau();
    const SESSION = 'session-reused';
    try {
      await startRun({ message: 'A', sessionId: SESSION });
      const original = await bureau.contexts.input(SESSION, input);
      expect(original.outcome).toBe('admitted');
      await bureau.contexts.delete(SESSION);
      await startRun({ message: 'B', sessionId: SESSION });

      const reused = await bureau.contexts.input(SESSION, input);
      expect(reused.outcome).toBe('admitted');
      if (reused.outcome === 'admitted') expect(reused.receipt.state).toBe('accepted');
      // And the new incarnation replays its own record, not the deleted one's.
      const replay = await bureau.contexts.input(SESSION, input);
      expect(replay.outcome).toBe('replayed');
      if (replay.outcome === 'replayed') expect(replay.receipt.state).toBe('accepted');
    } finally {
      await bureau.dispose();
    }
  });
});

describe('concurrent submissions of one id (COR-1476)', () => {
  it('answers each on its own: a different payload is a conflict, and so is another session', async () => {
    const { bureau, startRun } = await parkingBureau();
    try {
      const runA = await startRun({ message: 'A' });
      const runB = await startRun({ message: 'B' });
      const [first, second, elsewhere] = await Promise.all([
        bureau.contexts.input(runA.sessionId, { ...input, payload: 'one' }),
        bureau.contexts.input(runA.sessionId, { ...input, payload: 'two' }),
        bureau.contexts.input(runB.sessionId, { ...input, payload: 'one' }),
      ]);
      expect(first.outcome).toBe('admitted');
      expect(second.outcome).toBe('conflict');
      if (second.outcome === 'conflict') expect(second.conflict.reason).toBe('payload-mismatch');
      expect(elsewhere.outcome).toBe('conflict');
      if (elsewhere.outcome === 'conflict') {
        expect(elsewhere.conflict.reason).toBe('session-mismatch');
      }
      // Session B's mailbox holds nothing for the id.
      const sessionB = await bureau.contexts.get(runB.sessionId);
      expect(sessionB).toBeDefined();
    } finally {
      await bureau.dispose();
    }
  });
});
