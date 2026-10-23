/**
 * COR-1587 — a durable run whose engine fails it ends, for the session and for the stream. A
 * refused write of the run's durable record, after the run is released, rejects the run's result
 * with a plain error the engine gives no code. The run settles as `error`: the stream's last frame
 * is `RUN_ERROR`, the run record reads `error`, and the session records `lastRunStatus: 'error'`,
 * so the thread takes new input instead of staying `running` until the next boot. Held to the same
 * outcome with a follow-up the run delivered and without one, and with a timeout.
 *
 * A run that fails after it committed a step keeps what it committed: the session's transcript
 * holds the committed rows and any follow-up the run delivered, and the stream sends the thread as
 * a snapshot before `RUN_ERROR`. The streams here are awaited to their end, and a stream that stays
 * open is caught by the test's own timeout.
 */
import { EventType } from '@ag-ui/core';
import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { createScriptedGenerate, type GenerateFunction } from '@lostgradient/operative';
import { MemoryStorage, type Storage } from '@lostgradient/weft';
import { createTool, createToolbox, type Tool } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { ABORTED_RUN_TERMINAL_GRACE_MILLISECONDS } from '../create-bureau.ts';
import {
  keysOf,
  openBureau,
  type Opened,
  refusingStorage,
  say,
  startStream,
} from './ag-ui-engine-failure.test-support.ts';
import { typesOf } from './ag-ui-stream.test-support.ts';

/** The durable run record: the key a run's own writes go to once the run is released. */
const DURABLE_RUN_RECORD = 'durable-run:';

const noopTool = createTool({
  name: 'noop',
  description: 'does nothing',
  input: z.object({}),
  execute: async () => ({ ok: true }),
});

/** The session's transcript as `role:content` rows. */
async function transcriptOf(bureau: Opened['bureau']): Promise<string[]> {
  const session = await bureau.getSession('thread-1');
  return Object.values(session?.conversationHistory.messages ?? {}).map(
    (message) =>
      `${message.role}:${typeof message.content === 'string' ? message.content : '[parts]'}`,
  );
}

describe('a durable run whose engine fails it (COR-1587)', () => {
  for (const withFollowUp of [true, false]) {
    it(`ends the stream, the run record, and the session as error ${withFollowUp ? 'with' : 'without'} a delivered follow-up`, async () => {
      const generate = createScriptedGenerate([
        { kind: 'block', barrier: 'hold' },
        say('First.'),
        say('Answer.'),
      ]);
      const refusing = refusingStorage();
      const opened = await openBureau({ generate, storage: refusing.storage });
      const { bureau } = opened;
      const stream = await startStream(opened);
      try {
        await stream.until(EventType.STEP_STARTED);
        await generate.reached('hold');
        if (withFollowUp) {
          const admitted = await bureau.submitSessionInput('thread-1', {
            id: 'follow-up-1',
            principal: 'anonymous:local',
            deliveryMode: 'steer',
            payload: 'One more thing',
          });
          expect(admitted.outcome).toBe('admitted');
        }
        refusing.refuseWritesUnder(DURABLE_RUN_RECORD);
        generate.release('hold');

        await stream.rest();

        expect(refusing.refused()).toBeGreaterThan(0);
        expect(stream.received.at(-1)?.event.type).toBe(EventType.RUN_ERROR);
        expect(typesOf(stream.received)).not.toContain(EventType.RUN_FINISHED);
        expect(bureau.listRuns()[0]?.status).toBe('error');
        const session = await bureau.getSession('thread-1');
        expect(session?.metadata['lastRunStatus']).toBe('error');
      } finally {
        await stream.cancel().catch(() => undefined);
        await bureau.dispose();
      }
    });
  }
});

describe('a durable run the engine times out (COR-1587)', () => {
  it('ends the stream with RUN_ERROR, and the run record and session read error', async () => {
    const generate = createScriptedGenerate([say('First.'), say('Second.'), say('Answer.')]);
    // A history this short is breached by the run's own events, which the engine reports as a
    // timeout: a `WorkflowTimeoutError` that carries no `run.error` of its own.
    const opened = await openBureau({
      generate,
      storage: new MemoryStorage(),
      maximumHistoryEvents: 4,
    });
    const { bureau } = opened;
    const stream = await startStream(opened);
    try {
      await stream.rest();

      expect(stream.received.at(-1)?.event.type).toBe(EventType.RUN_ERROR);
      expect(typesOf(stream.received)).not.toContain(EventType.RUN_FINISHED);
      expect(bureau.listRuns()[0]?.status).toBe('error');
      const session = await bureau.getSession('thread-1');
      expect(session?.metadata['lastRunStatus']).toBe('error');
    } finally {
      await stream.cancel().catch(() => undefined);
      await bureau.dispose();
    }
  });
});

describe('a durable run that fails after it committed a step (COR-1587)', () => {
  /** Step 0 calls a tool and commits; step 1 waits at `hold` until the test has armed its failure. */
  function stepZeroThenHold() {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    let reached!: () => void;
    const reachedStepOne = new Promise<void>((resolve) => (reached = resolve));
    const generate: GenerateFunction = async ({ step }) => {
      if (step === 0) {
        return {
          content: 'Calling the tool.',
          toolCalls: [{ name: 'noop', arguments: {} }],
          usage: { prompt: 10, completion: 5, total: 15 },
        };
      }
      reached();
      await hold;
      return { content: 'Answer.', toolCalls: [], usage: { prompt: 1, completion: 1, total: 2 } };
    };
    return { generate, release, reachedStepOne };
  }

  it('keeps the committed step, its usage, and its rows when a later write is refused', async () => {
    const { generate, release, reachedStepOne } = stepZeroThenHold();
    const refusing = refusingStorage();
    const { bureau } = await openBureau({
      generate,
      storage: refusing.storage,
      toolbox: createToolbox<readonly Tool[]>([noopTool]),
    });
    try {
      const summary = await bureau.createRun({
        agentName: 'bureau',
        message: 'Go.',
        sessionId: 'thread-1',
      });
      await reachedStepOne;
      refusing.refuseWritesUnder(DURABLE_RUN_RECORD);
      release();
      await bureau.whenRunRecorded(summary.id);

      expect(bureau.listRuns().find((run) => run.id === summary.id)?.status).toBe('error');
      expect(bureau.getRunReport(summary.id)?.usage.total).toBe(15);
      expect(await transcriptOf(bureau)).toEqual([
        'user:Go.',
        'assistant:Calling the tool.',
        expect.stringContaining('tool-call'),
        expect.stringContaining('tool-result'),
      ]);
    } finally {
      await bureau.dispose();
    }
  });

  it('keeps a delivered follow-up and the committed reply, and sends the thread before RUN_ERROR', async () => {
    const generate = createScriptedGenerate([
      { kind: 'block', barrier: 'hold' },
      say('First.'),
      { kind: 'block', barrier: 'hold-two' },
      say('Answer.'),
    ]);
    const refusing = refusingStorage();
    const opened = await openBureau({ generate, storage: refusing.storage });
    const { bureau } = opened;
    const stream = await startStream(opened);
    try {
      await stream.until(EventType.STEP_STARTED);
      await generate.reached('hold');
      const admitted = await bureau.submitSessionInput('thread-1', {
        id: 'follow-up-1',
        principal: 'anonymous:local',
        deliveryMode: 'steer',
        payload: 'One more thing',
      });
      expect(admitted.outcome).toBe('admitted');
      generate.release('hold');
      // The follow-up is delivered at step 0's boundary and the run is now in step 1.
      await generate.reached('hold-two');
      refusing.refuseWritesUnder(DURABLE_RUN_RECORD);
      generate.release('hold-two');

      await stream.rest();

      expect(typesOf(stream.received).slice(-2)).toEqual([
        EventType.MESSAGES_SNAPSHOT,
        EventType.RUN_ERROR,
      ]);
      expect(await transcriptOf(bureau)).toEqual(
        expect.arrayContaining(['assistant:First.', 'user:One more thing']),
      );
      const session = await bureau.getSession('thread-1');
      expect(session?.metadata['lastRunStatus']).toBe('error');
    } finally {
      await stream.cancel().catch(() => undefined);
      await bureau.dispose();
    }
  });

  it('keeps the committed step when the engine times the run out', async () => {
    const { generate, release } = stepZeroThenHold();
    release();
    const { bureau } = await openBureau({
      generate,
      storage: new MemoryStorage(),
      toolbox: createToolbox<readonly Tool[]>([noopTool]),
      maximumHistoryEvents: 6,
    });
    try {
      const summary = await bureau.createRun({
        agentName: 'bureau',
        message: 'Go.',
        sessionId: 'thread-1',
      });
      await bureau.whenRunRecorded(summary.id);

      expect(bureau.listRuns().find((run) => run.id === summary.id)?.status).toBe('error');
      // The breaker ends the run at step 1's checkpoint, and the engine settles the run only after
      // that step's activity has landed (COR-1597), so the reply it wrote is part of what the
      // session keeps. The run was never cut short of a write the session then missed.
      expect(await transcriptOf(bureau)).toEqual([
        'user:Go.',
        'assistant:Calling the tool.',
        expect.stringContaining('tool-call'),
        expect.stringContaining('tool-result'),
        'assistant:Answer.',
      ]);
    } finally {
      await bureau.dispose();
    }
  });
});

/**
 * A memory storage that can hold one atomic write of the session transcript, the write that also
 * promotes a follow-up the run delivered. Armed, it stops that write before it lands, and the
 * test releases it once the run has been ended.
 */
function holdingTranscriptStorage() {
  const memory = new MemoryStorage();
  let armed = false;
  let releaseHeld: (() => void) | undefined;
  let markHeld!: () => void;
  const held = new Promise<void>((resolve) => (markHeld = resolve));
  const proxy = new Proxy(memory, {
    get(target, property, receiver) {
      const member: unknown = Reflect.get(target, property, receiver);
      if (typeof member !== 'function') return member;
      const name = String(property);
      const call = (...args: unknown[]) =>
        (member as (...rest: unknown[]) => unknown).apply(target, args);
      if (name !== 'conditionalBatch') return call.bind(null);
      return async (...args: unknown[]) => {
        const writesTranscript = keysOf(name, args).some((key) =>
          /^durable-run:.*:transcript$/.test(key),
        );
        if (armed && writesTranscript) {
          armed = false;
          markHeld();
          await new Promise<void>((resolve) => (releaseHeld = resolve));
        }
        return call(...args);
      };
    },
  });
  return {
    storage: proxy as unknown as Storage,
    arm() {
      armed = true;
    },
    held,
    release: () => releaseHeld?.(),
  };
}

async function macrotasks(count: number): Promise<void> {
  for (let turn = 0; turn < count; turn += 1)
    await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('a durable run ended while its step is being committed (COR-1597)', () => {
  /** A run that holds at step 0 until the test has admitted a steered follow-up. */
  function holdAtStepZero() {
    return createScriptedGenerate([
      { kind: 'block', barrier: 'hold' },
      say('First.'),
      say('Answer.'),
      say('Spare.'),
    ]);
  }

  async function admitFollowUp(bureau: Opened['bureau']): Promise<void> {
    const admitted = await bureau.submitSessionInput('thread-1', {
      id: 'follow-up-1',
      principal: 'anonymous:local',
      deliveryMode: 'steer',
      payload: 'One more thing',
    });
    expect(admitted.outcome).toBe('admitted');
  }

  it('keeps a delivered follow-up when the history cap ends the run at the transcript write', async () => {
    const generate = holdAtStepZero();
    const opened = await openBureau({
      generate,
      storage: new MemoryStorage(),
      maximumHistoryEvents: 2,
    });
    const { bureau } = opened;
    const stream = await startStream(opened);
    try {
      await generate.reached('hold');
      await admitFollowUp(bureau);
      generate.release('hold');

      await stream.rest();

      const runId = bureau.listRuns()[0]!.id;
      expect(await bureau.sessionInputsDeliveredBy(runId, 'thread-1')).toEqual(['follow-up-1']);
      expect(await transcriptOf(bureau)).toEqual(expect.arrayContaining(['user:One more thing']));
      expect(typesOf(stream.received).slice(-2)).toEqual([
        EventType.MESSAGES_SNAPSHOT,
        EventType.RUN_ERROR,
      ]);
    } finally {
      await stream.cancel().catch(() => undefined);
      await bureau.dispose();
    }
  });

  it('keeps the committed step when abortRun lands while its transcript write is in flight', async () => {
    const generate = holdAtStepZero();
    const holding = holdingTranscriptStorage();
    const opened = await openBureau({ generate, storage: holding.storage });
    const { bureau } = opened;
    const stream = await startStream(opened);
    try {
      await generate.reached('hold');
      await admitFollowUp(bureau);
      holding.arm();
      generate.release('hold');
      await holding.held;
      const runId = bureau.listRuns()[0]!.id;

      bureau.abortRun(runId);
      // The cancel is committed and the settle has had every chance to read: the write is still held.
      await macrotasks(50);
      holding.release();
      await bureau.whenRunRecorded(runId);
      await stream.rest();

      expect(await transcriptOf(bureau)).toEqual(expect.arrayContaining(['assistant:First.']));
      expect(bureau.listRuns().find((run) => run.id === runId)?.status).toBe('aborted');
    } finally {
      holding.release();
      await stream.cancel().catch(() => undefined);
      await bureau.dispose();
    }
  });

  it("settles the session as aborted when Bureau shuts down while a cancelled run's write is in flight", async () => {
    const generate = holdAtStepZero();
    const holding = holdingTranscriptStorage();
    // Shutdown waits a bounded grace for the aborted run to end before it disposes the engine;
    // the manual runtime lets the test end that grace without waiting it out.
    const runtime = createManualRuntimeServices();
    const opened = await openBureau({ generate, storage: holding.storage, runtime });
    const { bureau } = opened;
    const stream = await startStream(opened);
    try {
      await generate.reached('hold');
      await admitFollowUp(bureau);
      holding.arm();
      generate.release('hold');
      await holding.held;
      const runId = bureau.listRuns()[0]!.id;

      bureau.abortRun(runId);
      let durableRun = await bureau.getDurableRun(runId);
      while (durableRun?.status !== 'cancelled') {
        await macrotasks(1);
        durableRun = await bureau.getDurableRun(runId);
      }
      let shutdownDone = false;
      const disposing = bureau.dispose().finally(() => (shutdownDone = true));
      // Where the cancelled run stays unsettled, shutdown waits out a grace and then disposes the
      // engine while the run's result is held; the write is released only afterwards. A run that
      // settles at once ends shutdown before any grace is armed.
      const graceArmed = () =>
        runtime
          .pendingTimers()
          .some(
            (timer) =>
              timer.dueAt === runtime.monotonic.now() + ABORTED_RUN_TERMINAL_GRACE_MILLISECONDS,
          );
      while (!shutdownDone && !graceArmed()) await macrotasks(1);
      if (!shutdownDone) await runtime.advance(ABORTED_RUN_TERMINAL_GRACE_MILLISECONDS);
      await macrotasks(5);
      holding.release();
      await disposing;

      const session = await bureau.getSession('thread-1');
      expect(session?.metadata['lastRunStatus']).toBe('aborted');
    } finally {
      holding.release();
      await stream.cancel().catch(() => undefined);
      await bureau.dispose();
    }
  });
});
