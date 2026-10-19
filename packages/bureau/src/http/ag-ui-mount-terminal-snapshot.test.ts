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
import { MemoryStorage, type Storage } from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import { createBureau } from '../create-bureau.ts';
import { runAgentInput, startRequest } from './ag-ui-fixtures.test-support.ts';
import { FrameReader, typesOf } from './ag-ui-stream.test-support.ts';
import { createBureauHandler } from './create-bureau-handler.ts';

const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

type StorageBehavior = {
  /** How long each read waits before it answers. */
  readonly readMilliseconds?: number;
  /** How long each write waits before it commits. */
  readonly writeMilliseconds?: number;
  /** Fails the first write of a session body once `arm()` has been called. */
  readonly failFirstSessionWrite?: boolean;
};

const READS = new Set(['get']);
const WRITES = new Set(['put', 'delete', 'batch', 'conditionalBatch']);
const SESSION_BODY = 'agent-session-v2:body:';

function touchesSessionBody(args: readonly unknown[]): boolean {
  return JSON.stringify(args).includes(SESSION_BODY);
}

/** A memory storage whose reads and writes cost what the test says, and whose first session write can fail. */
function behaving(behavior: StorageBehavior) {
  const storage = new MemoryStorage();
  let armed = false;
  let failed = false;
  const proxy = new Proxy(storage, {
    get(target, property, receiver) {
      const member: unknown = Reflect.get(target, property, receiver);
      if (typeof member !== 'function') return member;
      const name = String(property);
      const call = (...args: unknown[]) =>
        (member as (...rest: unknown[]) => unknown).apply(target, args);
      if (WRITES.has(name)) {
        return async (...args: unknown[]) => {
          if ((behavior.writeMilliseconds ?? 0) > 0) await sleep(behavior.writeMilliseconds ?? 0);
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
  retryDelayMilliseconds?: number;
}) {
  const generate = createScriptedGenerate(options.script);
  const storage = behaving(options.behavior ?? {});
  const bureau = await createBureau({
    id: 'terminal-snapshot',
    agents: {
      assistant: createAgent({ generate, name: 'assistant', stopWhen: stopWhen.noToolCalls() }),
    },
    generate,
    storage: storage.storage,
    durableExecution: true,
    sessionPersistenceRetryDelayMilliseconds: options.retryDelayMilliseconds ?? 0,
    stopWhen: stopWhen.noToolCalls(),
  });
  return { bureau, generate, storage };
}

type Opened = Awaited<ReturnType<typeof openBureau>>;

function mountOver(bureau: Parameters<typeof createBureauHandler>[0]) {
  return createBureauHandler(bureau, {
    unauthenticatedAccess: 'allow',
    publish: ['assistant'],
    agUi: {},
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
  const admitted = await opened.bureau.submitSessionInput(threadId, {
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
      retryDelayMilliseconds: 10,
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
        getSession: async (id: string) => {
          // The thread is readable while the run is going and owned, and unreadable once it ended.
          if (opened.bureau.getRun(opened.bureau.listRuns()[0]?.id ?? '')?.status === 'completed') {
            throw new Error('The session store is unavailable.');
          }
          return opened.bureau.getSession(id);
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
      await opened.bureau.submitSessionInput('thread-1', {
        id: 'follow-up-1',
        principal: 'anonymous:local',
        deliveryMode: 'steer',
        payload: 'One more thing',
      });
      opened.generate.release('hold');
      await opened.generate.reached('second');
      opened.bureau.abortRun(opened.bureau.listRuns()[0]!.id);
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
