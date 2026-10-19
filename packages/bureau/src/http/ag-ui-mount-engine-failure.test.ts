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
import {
  createAgent,
  createScriptedGenerate,
  type GenerateFunction,
  type ScriptedGenerateStep,
  stopWhen,
} from '@lostgradient/operative';
import { MemoryStorage, type Storage } from '@lostgradient/weft';
import { createTool, createToolbox, type Tool } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createBureau } from '../create-bureau.ts';
import { runAgentInput, startRequest } from './ag-ui-fixtures.test-support.ts';
import { FrameReader, typesOf } from './ag-ui-stream.test-support.ts';
import { createBureauHandler } from './create-bureau-handler.ts';
import { createMemoryAssetStorage } from '../assets/storage';

const WRITES = new Set(['put', 'delete', 'batch', 'conditionalBatch']);
/** The durable run record: the key a run's own writes go to once the run is released. */
const DURABLE_RUN_RECORD = 'durable-run:';

function keysOf(name: string, args: readonly unknown[]): string[] {
  if (name === 'put' || name === 'delete') return [String(args[0])];
  const operations = (name === 'batch' ? args[0] : args[1]) as Array<{ key: string }> | undefined;
  return (operations ?? []).map((operation) => operation.key);
}

/** A memory storage that, once told to, refuses every write whose key starts with a prefix. */
function refusingStorage() {
  const storage = new MemoryStorage();
  let refusedPrefix: string | undefined;
  let refused = 0;
  const proxy = new Proxy(storage, {
    get(target, property, receiver) {
      const member: unknown = Reflect.get(target, property, receiver);
      if (typeof member !== 'function') return member;
      const name = String(property);
      const call = (...args: unknown[]) =>
        (member as (...rest: unknown[]) => unknown).apply(target, args);
      if (!WRITES.has(name)) return call.bind(null);
      return async (...args: unknown[]) => {
        if (
          refusedPrefix !== undefined &&
          keysOf(name, args).some((key) => key.startsWith(refusedPrefix!))
        ) {
          refused += 1;
          throw new Error('This storage write is refused.');
        }
        return call(...args);
      };
    },
  });
  return {
    storage: proxy as unknown as Storage,
    refuseWritesUnder(prefix: string) {
      refusedPrefix = prefix;
    },
    refused: () => refused,
  };
}

const say = (content: string): ScriptedGenerateStep => ({
  kind: 'respond',
  response: { content, toolCalls: [] },
});

const noopTool = createTool({
  name: 'noop',
  description: 'does nothing',
  input: z.object({}),
  execute: async () => ({ ok: true }),
});

type Opened = Awaited<ReturnType<typeof openBureau>>;

async function openBureau(options: {
  readonly generate: GenerateFunction;
  readonly storage: Storage;
  readonly toolbox?: ReturnType<typeof createToolbox<readonly Tool[]>>;
  readonly maximumHistoryEvents?: number;
}) {
  const bureau = await createBureau({
    assets: { storage: createMemoryAssetStorage() },
    id: 'engine-failure',
    agents: {
      assistant: createAgent({
        generate: options.generate,
        name: 'assistant',
        stopWhen: stopWhen.noToolCalls(),
      }),
    },
    generate: options.generate,
    ...(options.toolbox === undefined ? {} : { toolbox: options.toolbox }),
    storage: options.storage,
    durableExecution: true,
    ...(options.maximumHistoryEvents === undefined
      ? {}
      : { durableGuardrails: { history: { maxEvents: options.maximumHistoryEvents } } }),
    sessionPersistenceRetryDelayMilliseconds: 0,
    stopWhen: stopWhen.noToolCalls(),
    onDiagnostic: () => undefined,
  });
  const handler = createBureauHandler(bureau, {
    unauthenticatedAccess: 'allow',
    publish: ['assistant'],
    agUi: {},
  });
  return { bureau, handler };
}

async function startStream({ handler }: Opened) {
  return new FrameReader(
    await handler(startRequest(runAgentInput({ threadId: 'thread-1', runId: 'client-run-1' }))),
  );
}

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
      const summary = await bureau.createRun({ message: 'Go.', sessionId: 'thread-1' });
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
      const summary = await bureau.createRun({ message: 'Go.', sessionId: 'thread-1' });
      await bureau.whenRunRecorded(summary.id);

      expect(bureau.listRuns().find((run) => run.id === summary.id)?.status).toBe('error');
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
});
