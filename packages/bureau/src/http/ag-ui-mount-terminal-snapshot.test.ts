/**
 * COR-1490 — the end-of-run `MESSAGES_SNAPSHOT` over storage that is not instant. A run that
 * delivered session input must end its stream with the thread as a snapshot, whatever the storage
 * costs: the stream waits for the session to record the run's end, and no count of event-loop turns
 * decides whether the snapshot is sent. A session that cannot be read ends the stream with an
 * error, never with a plain success that omits it, because a client that sees success and no
 * snapshot resends an input the run already took.
 */
import { EventType } from '@ag-ui/core';
import {
  createAgent,
  createScriptedGenerate,
  type ScriptedGenerateStep,
  stopWhen,
} from '@lostgradient/operative';
import { MemoryStorage, type Storage } from '@lostgradient/storage';
import { describe, expect, it, spyOn } from 'bun:test';

import { createBureau } from '../create-bureau.ts';
import { runAgentInput, startRequest } from './ag-ui-fixtures.test-support.ts';
import { FrameReader, typesOf } from './ag-ui-stream.test-support.ts';
import { createBureauHandler } from './create-bureau-handler.ts';
import { createMemoryAssetStorage } from '../assets/storage';
import type { AgentDefinitions } from '../agent-catalog';
import { listHeldTasks } from '../test';

const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

type StorageBehavior = {
  /** How long each read waits before it answers. */
  readonly readMilliseconds?: number;
  /** How long each write waits before it commits. */
  readonly writeMilliseconds?: number;
  /** Fails the first write of a session body once `arm()` has been called. */
  readonly failFirstSessionWrite?: boolean;
  /**
   * Once `arm()` has been called, corrupts the run's checkpoint under the next conditional write
   * of it, so its terminal checkpoint commit loses the compare-and-swap and the engine abandons the
   * run for whoever owns it, without a write.
   */
  readonly loseCheckpointCompareAndSwap?: boolean;
  /** Once `arm()` has been called, refuses every write of a session body, however often it is retried. */
  readonly refuseSessionWrites?: boolean;
};

const READS = new Set(['get']);
const WRITES = new Set(['put', 'delete', 'batch', 'conditionalBatch']);
const SESSION_BODY = 'agent-session-v2:body:';
const RUN_CHECKPOINT = /wf:[^"]*:ckpt/;

function touchesSessionBody(args: readonly unknown[]): boolean {
  return JSON.stringify(args).includes(SESSION_BODY);
}

/** A memory storage whose reads and writes cost what the test says, and whose first session write can fail. */
function behaving(behavior: StorageBehavior) {
  const storage = new MemoryStorage();
  let armed = false;
  let failed = false;
  let checkpointLost = false;
  const proxy = new Proxy(storage, {
    get(target, property, receiver) {
      const member: unknown = Reflect.get(target, property, receiver);
      if (typeof member !== 'function') return member;
      const name = String(property);
      const call = (...args: unknown[]) =>
        (member as (...rest: unknown[]) => unknown).apply(target, args);
      if (behavior.loseCheckpointCompareAndSwap === true && name === 'conditionalBatch') {
        return async (...args: unknown[]) => {
          const key = RUN_CHECKPOINT.exec(JSON.stringify(args))?.[0];
          if (armed && key !== undefined && !checkpointLost) {
            checkpointLost = true;
            await target.put(key, new Uint8Array([1, 2, 3]));
          }
          return call(...args);
        };
      }
      if (WRITES.has(name)) {
        return async (...args: unknown[]) => {
          if ((behavior.writeMilliseconds ?? 0) > 0) await sleep(behavior.writeMilliseconds ?? 0);
          if (behavior.refuseSessionWrites === true && armed && touchesSessionBody(args)) {
            throw new Error('Every session write is refused.');
          }
          if (
            behavior.failFirstSessionWrite === true &&
            armed &&
            !failed &&
            touchesSessionBody(args)
          ) {
            failed = true;
            throw new Error('The first session write failed.');
          }
          return call(...args);
        };
      }
      if (READS.has(name) && (behavior.readMilliseconds ?? 0) > 0) {
        return async (...args: unknown[]) => {
          await sleep(behavior.readMilliseconds ?? 0);
          return call(...args);
        };
      }
      return call.bind(null);
    },
  });
  return {
    storage: proxy as unknown as Storage,
    arm() {
      armed = true;
    },
  };
}

const say = (content: string): ScriptedGenerateStep => ({
  kind: 'respond',
  response: { content, toolCalls: [] },
});

async function openBureau(options: {
  script: readonly ScriptedGenerateStep[];
  behavior?: StorageBehavior;
  /** Collects what the Bureau reports, which a scenario that breaks storage on purpose expects to. */
  diagnostics?: string[];
}) {
  const generate = createScriptedGenerate(options.script);
  const storage = behaving(options.behavior ?? {});
  const bureau = await createBureau<AgentDefinitions>({
    assets: { storage: createMemoryAssetStorage() },
    id: 'terminal-snapshot',
    agents: {
      assistant: createAgent({ generate, name: 'assistant', stopWhen: stopWhen.noToolCalls() }),
      default: createAgent({ generate, stopWhen: stopWhen.noToolCalls() }),
    },
    storage: storage.storage,
    durable: true,
    ...(options.diagnostics === undefined
      ? {}
      : {
          onDiagnostic: (diagnostic: { message?: string }) => {
            options.diagnostics?.push(diagnostic.message ?? '');
          },
        }),
  });
  return { bureau, generate, storage };
}

type Opened = Awaited<ReturnType<typeof openBureau>>;

function mountOver(
  bureau: Parameters<typeof createBureauHandler>[0],
  maxStreamDurationMs?: number,
) {
  return createBureauHandler(bureau, {
    unauthenticatedAccess: 'allow',
    agUi: maxStreamDurationMs === undefined ? {} : { maxStreamDurationMs },
  });
}

/** Starts a run, holds it at its first step, gives the thread an input, and lets the run go on. */
async function runThatTakesInput(
  opened: Opened,
  handler: ReturnType<typeof mountOver>,
  options: { threadId?: string; runId?: string; beforeRelease?: () => Promise<void> | void } = {},
) {
  const threadId = options.threadId ?? 'thread-1';
  const stream = new FrameReader(
    await handler(
      startRequest(runAgentInput({ threadId, runId: options.runId ?? 'client-run-1' })),
    ),
  );
  await stream.until(EventType.STEP_STARTED);
  await opened.generate.reached('hold');
  const admitted = await opened.bureau.contexts.input(threadId, {
    id: 'follow-up-1',
    principal: 'anonymous:local',
    deliveryMode: 'steer',
    payload: 'One more thing',
  });
  expect(admitted.outcome).toBe('admitted');
  await options.beforeRelease?.();
  opened.generate.release('hold');
  await stream.rest();
  return stream;
}

const tail = (stream: FrameReader, count: number) => typesOf(stream.received).slice(-count);
const finishOutcome = (stream: FrameReader) => {
  const last = stream.received.at(-1)?.event;
  return last?.type === EventType.RUN_FINISHED ? last.outcome : undefined;
};
const snapshotIds = (stream: FrameReader): string[] => {
  const event = stream.received
    .map((frame) => frame.event)
    .findLast((candidate) => candidate.type === EventType.MESSAGES_SNAPSHOT);
  return event?.type === EventType.MESSAGES_SNAPSHOT
    ? event.messages.map((message) => message.id)
    : [];
};

describe('the end-of-run snapshot over storage that is not instant', () => {
  for (const [label, behavior] of [
    ['writes slower than reads', { readMilliseconds: 0, writeMilliseconds: 15 }],
    ['writes and reads both slow', { readMilliseconds: 3, writeMilliseconds: 12 }],
  ] as const) {
    it(`is sent, before RUN_FINISHED, when ${label}`, async () => {
      const opened = await openBureau({
        script: [{ kind: 'block', barrier: 'hold' }, say('First.'), say('Answer.')],
        behavior,
      });
      try {
        const stream = await runThatTakesInput(opened, mountOver(opened.bureau));

        expect(tail(stream, 2)).toEqual([EventType.MESSAGES_SNAPSHOT, EventType.RUN_FINISHED]);
        expect(finishOutcome(stream)).toEqual({ type: 'success' });
        expect(snapshotIds(stream)).toContain('follow-up-1');
      } finally {
        await opened.bureau.dispose();
      }
    });
  }

  it('is sent when the first save of the session fails and is retried', async () => {
    const opened = await openBureau({
      script: [{ kind: 'block', barrier: 'hold' }, say('First.'), say('Answer.')],
      behavior: { failFirstSessionWrite: true },
    });
    try {
      const stream = await runThatTakesInput(opened, mountOver(opened.bureau), {
        beforeRelease: () => opened.storage.arm(),
      });

      expect(tail(stream, 2)).toEqual([EventType.MESSAGES_SNAPSHOT, EventType.RUN_FINISHED]);
      expect(snapshotIds(stream)).toContain('follow-up-1');
    } finally {
      await opened.bureau.dispose();
    }
  });
});

describe('a session that cannot be read at the end of a run that took input', () => {
  it('ends the stream with RUN_ERROR and says why, never with a success that omits the snapshot', async () => {
    const opened = await openBureau({
      script: [{ kind: 'block', barrier: 'hold' }, say('First.'), say('Answer.')],
    });
    try {
      const failing = {
        ...opened.bureau,
        contexts: {
          ...opened.bureau.contexts,
          get: async (id: string) => {
            // The thread is readable while the run is going and owned, and unreadable once it ended.
            if (
              opened.bureau.tasks.detail(listHeldTasks(opened.bureau)[0]?.id ?? '')?.status ===
              'completed'
            ) {
              throw new Error('The session store is unavailable.');
            }
            return opened.bureau.contexts.get(id);
          },
        },
      };
      const stream = await runThatTakesInput(opened, mountOver(failing));

      const last = stream.received.at(-1)?.event;
      expect(last?.type).toBe(EventType.RUN_ERROR);
      expect(last).toMatchObject({ code: 'RUN_FAILED' });
      expect((last as { message: string }).message).toContain('could not be read');
      expect(typesOf(stream.received)).not.toContain(EventType.RUN_FINISHED);
    } finally {
      await opened.bureau.dispose();
    }
  });
});

describe('the other ways a run that took input can end', () => {
  it('sends the snapshot before RUN_ERROR when the run fails after taking the input', async () => {
    const opened = await openBureau({
      script: [
        { kind: 'block', barrier: 'hold' },
        say('First.'),
        { kind: 'fail', error: new Error('The model failed.') },
      ],
    });
    try {
      const stream = await runThatTakesInput(opened, mountOver(opened.bureau));

      expect(tail(stream, 2)).toEqual([EventType.MESSAGES_SNAPSHOT, EventType.RUN_ERROR]);
      expect(snapshotIds(stream)).toContain('follow-up-1');
    } finally {
      await opened.bureau.dispose();
    }
  });

  it('sends the snapshot before the cancelled RUN_FINISHED when the run is aborted after taking the input', async () => {
    const opened = await openBureau({
      script: [
        { kind: 'block', barrier: 'hold' },
        say('First.'),
        { kind: 'block', barrier: 'second' },
      ],
    });
    try {
      const handler = mountOver(opened.bureau);
      const stream = new FrameReader(await handler(startRequest(runAgentInput())));
      await stream.until(EventType.STEP_STARTED);
      await opened.generate.reached('hold');
      await opened.bureau.contexts.input('thread-1', {
        id: 'follow-up-1',
        principal: 'anonymous:local',
        deliveryMode: 'steer',
        payload: 'One more thing',
      });
      opened.generate.release('hold');
      await opened.generate.reached('second');
      await opened.bureau.tasks.cancel(listHeldTasks(opened.bureau)[0]!.id);
      await stream.rest();

      expect(tail(stream, 2)).toEqual([EventType.MESSAGES_SNAPSHOT, EventType.RUN_FINISHED]);
      expect(finishOutcome(stream)).toEqual({ type: 'cancelled' });
      expect(snapshotIds(stream)).toContain('follow-up-1');
    } finally {
      await opened.bureau.dispose();
    }
  });
});

describe('a later run on a thread that once took input', () => {
  it('ends without a snapshot, because it delivered none itself', async () => {
    const opened = await openBureau({
      script: [{ kind: 'block', barrier: 'hold' }, say('First.'), say('Answer.'), say('Plain.')],
    });
    try {
      const handler = mountOver(opened.bureau);
      const first = await runThatTakesInput(opened, handler);
      expect(typesOf(first.received)).toContain(EventType.MESSAGES_SNAPSHOT);

      const second = new FrameReader(
        await handler(
          startRequest(
            runAgentInput({
              threadId: 'thread-1',
              runId: 'client-run-2',
              messages: [{ id: 'user-2', role: 'user', content: 'A new question' }],
            }),
          ),
        ),
      );
      await second.rest();

      expect(typesOf(second.received)).not.toContain(EventType.MESSAGES_SNAPSHOT);
      expect(tail(second, 1)).toEqual([EventType.RUN_FINISHED]);
    } finally {
      await opened.bureau.dispose();
    }
  });
});

describe('a run that reported an error and was then abandoned without a save', () => {
  /** The deadline a hung stream would end at, which a prompt end is far from. */
  const DEADLINE_MILLISECONDS = 3000;

  it('ends its stream with the run’s own error, not at the stream’s deadline', async () => {
    // Weft reports a lost compare-and-swap to operators as a process warning. It is part of the
    // scenario, so capture it rather than let it reach stderr, and check it was raised.
    const warnings: Error[] = [];
    const emitWarning = spyOn(process, 'emitWarning').mockImplementation((warning) => {
      if (warning instanceof Error) warnings.push(warning);
    });
    const opened = await openBureau({
      script: [
        { kind: 'block', barrier: 'hold' },
        say('First.'),
        { kind: 'block', barrier: 'second' },
        { kind: 'fail', error: new Error('The model failed.') },
      ],
      behavior: { loseCheckpointCompareAndSwap: true },
    });
    try {
      const handler = mountOver(opened.bureau, DEADLINE_MILLISECONDS);
      const stream = new FrameReader(await handler(startRequest(runAgentInput())));
      await stream.until(EventType.STEP_STARTED);
      await opened.generate.reached('hold');
      await opened.bureau.contexts.input('thread-1', {
        id: 'follow-up-1',
        principal: 'anonymous:local',
        deliveryMode: 'steer',
        payload: 'One more thing',
      });
      opened.generate.release('hold');
      await opened.generate.reached('second');
      opened.storage.arm();
      const recorded = opened.bureau.internals
        .whenTaskRecorded(listHeldTasks(opened.bureau)[0]!.id)
        .then(
          () => 'resolved',
          (error: unknown) => (error instanceof Error ? error.name : 'rejected'),
        );
      opened.generate.release('second');
      await stream.rest();

      const last = stream.received.at(-1)?.event;
      expect(last?.type).toBe(EventType.RUN_ERROR);
      expect(last).toMatchObject({ message: 'The model failed.' });
      expect(last).not.toMatchObject({ code: 'STREAM_DEADLINE' });
      // No save of the run's end happened here, so nothing will ever record it: the wait says so.
      expect(await recorded).toBe('TerminalSessionRecordAbandonedError');
      expect(warnings.map((warning) => warning.name)).toEqual([
        'WeftWorkflowCheckpointConflictWarning',
      ]);
    } finally {
      emitWarning.mockRestore();
      await opened.bureau.dispose();
    }
  });
});

describe('the other ways a run that took input can end without its end being recorded', () => {
  const DEADLINE_MILLISECONDS = 3000;

  it('ends the stream promptly, naming the unreadable thread, when every save of the session is refused', async () => {
    const diagnostics: string[] = [];
    const opened = await openBureau({
      script: [{ kind: 'block', barrier: 'hold' }, say('First.'), say('Answer.')],
      behavior: { refuseSessionWrites: true },
      diagnostics,
    });
    try {
      const stream = await runThatTakesInput(
        opened,
        mountOver(opened.bureau, DEADLINE_MILLISECONDS),
        {
          beforeRelease: () => opened.storage.arm(),
        },
      );

      const last = stream.received.at(-1)?.event;
      expect(last).toMatchObject({ type: EventType.RUN_ERROR, code: 'RUN_FAILED' });
      expect((last as { message: string }).message).toContain('could not be read');
      expect(diagnostics.some((message) => message.includes('Failed to persist'))).toBe(true);
    } finally {
      await opened.bureau.dispose();
    }
  });

  it('ends the stream promptly when the Bureau is disposed while the run is going, and the record settles', async () => {
    const opened = await openBureau({
      script: [
        { kind: 'block', barrier: 'hold' },
        say('First.'),
        { kind: 'block', barrier: 'second' },
      ],
    });
    const handler = mountOver(opened.bureau, DEADLINE_MILLISECONDS);
    const stream = new FrameReader(await handler(startRequest(runAgentInput())));
    await stream.until(EventType.STEP_STARTED);
    await opened.generate.reached('hold');
    await opened.bureau.contexts.input('thread-1', {
      id: 'follow-up-1',
      principal: 'anonymous:local',
      deliveryMode: 'steer',
      payload: 'One more thing',
    });
    opened.generate.release('hold');
    await opened.generate.reached('second');
    const runId = listHeldTasks(opened.bureau)[0]!.id;
    // Disposing ends the run, and the save of its end settles the record: it does not stay pending.
    const recorded = opened.bureau.internals.whenTaskRecorded(runId).then(
      () => 'settled',
      () => 'settled',
    );

    await opened.bureau.dispose();
    await stream.rest();

    expect(await recorded).toBe('settled');
    expect(stream.received.at(-1)).not.toMatchObject({ event: { code: 'STREAM_DEADLINE' } });
  });
});
