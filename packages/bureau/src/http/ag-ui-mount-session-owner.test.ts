/**
 * COR-1588 — every record an AG-UI route uses is authorized against its own owner.
 *
 * A thread is authorized in two steps if its owner of record is read apart from the session the
 * route then serves: a thread deleted and created again under the same id by another owner between
 * the two reads hands the caller the new owner's data. These tests make that window permanent
 * instead of timing it. The Bureau the mount reads answers every `getSession` with bob's session
 * and every `listRuns` with bob's live run, while the authorization says the thread is alice's, as
 * it would have a moment before the recreation. Alice's request must then be answered as a missing
 * thread is, with none of bob's message ids and none of his run id in the response.
 */
import { EventType } from '@ag-ui/core';
import { createDefaultRuntimeServices } from '@lostgradient/lifecycle';
import { type AgentSession, stopWhen } from '@lostgradient/operative';
import { describe, expect, it } from 'bun:test';

import type { RunSummary } from '../types.ts';
import {
  aliceHandlerOver,
  as,
  attachThreadRequest,
  authentication,
  type Harness,
  openHarness,
  runAgentInput,
  startRequest,
} from './ag-ui-fixtures.test-support.ts';
import { createAgUiLeases } from './ag-ui-lease.ts';
import { type AgUiAuthorization, DEFAULT_AG_UI_PATH_PREFIX } from './ag-ui-mount.ts';
import { type AgUiStreamBureau, openRunStream } from './ag-ui-stream.ts';
import { bureauMetadata, readAgUiStream } from './ag-ui-stream.test-support.ts';
import { mayAccessOwnedResource } from './owner-predicate.ts';

const ALICE = 'api-key:alice';
const BOB_MESSAGE = 'bob-secret-message';
const ALICE_THREAD = 'thread-alice';
const BOB_THREAD = 'thread-bob';

const park = {
  kind: 'respond' as const,
  response: {
    content: '',
    toolCalls: [
      {
        id: 'call-1',
        name: 'requestHumanInput',
        arguments: { signalName: 'human-response', prompt: 'Approve this?' },
      },
    ],
  },
};

/** Starts a run for `key` that parks on a human wait, and reads its stream to the interrupt. */
async function startParked(
  harness: Harness,
  key: string,
  threadId: string,
  runId: string,
  messageId: string,
) {
  const frames = await readAgUiStream(
    await harness.handler(
      startRequest(
        runAgentInput({
          threadId,
          runId,
          messages: [{ id: messageId, role: 'user', content: `${messageId} says hello` }],
        }),
        as(key),
      ),
    ),
  );
  const nativeRunId = String(bureauMetadata(frames[0]!.event)['runId']);
  const finished = frames.at(-1)!.event as { outcome: { interrupts: Array<{ id: string }> } };
  return { threadId, runId: nativeRunId, reviewId: finished.outcome.interrupts[0]!.id };
}

type Scene = {
  readonly harness: Harness;
  readonly alice: { threadId: string; runId: string; reviewId: string };
  readonly bob: { threadId: string; runId: string };
  readonly bobSession: AgentSession;
  /** What bob's live run on the thread looks like to `tasks.detail`. */
  readonly bobLiveRun: RunSummary;
};

/** The Bureau's tasks, with bob's run reading as live on alice's thread. */
function tasksWithBobLive(scene: Scene): Harness['bureau']['tasks'] {
  const tasks = scene.harness.bureau.tasks;
  return {
    ...tasks,
    detail: (id: string) => {
      const detail = tasks.detail(id);
      return id === scene.bobLiveRun.id && detail !== undefined
        ? { ...detail, ...scene.bobLiveRun }
        : detail;
    },
  };
}

/** Alice and bob each own a thread, and each thread has a run parked on a human wait. */
async function withScene<T>(body: (scene: Scene) => Promise<T>): Promise<T> {
  const harness = await openHarness({
    script: [park, park, park],
    stopWhen: stopWhen.some(stopWhen.toolCalled('requestHumanInput'), stopWhen.noToolCalls()),
    authentication,
  });
  try {
    const alice = await startParked(
      harness,
      'alice-key',
      ALICE_THREAD,
      'alice-run',
      'alice-message',
    );
    const bob = await startParked(harness, 'bob-key', BOB_THREAD, 'bob-run', BOB_MESSAGE);
    const bobSession = await harness.bureau.contexts.get(BOB_THREAD);
    const bobRun = harness.bureau.tasks.detail(bob.runId);
    if (bobSession === undefined || bobRun === undefined) throw new Error('bob has no session');
    const bobLiveRun: RunSummary = { ...bobRun, sessionId: ALICE_THREAD, status: 'running' };
    return await body({ harness, alice, bob, bobSession, bobLiveRun });
  } finally {
    await harness.dispose();
  }
}

function bobsData(scene: Scene): readonly string[] {
  return [BOB_MESSAGE, scene.bob.runId, scene.bobSession.id];
}

function expectNothingOfBob(scene: Scene, body: string): void {
  for (const fragment of bobsData(scene)) expect(body).not.toContain(fragment);
}

const THREAD_NOT_FOUND = { type: EventType.RUN_ERROR, code: 'THREAD_NOT_FOUND' };

describe('a thread whose session is another owner’s than the one authorized', () => {
  it('is a missing thread on GET /threads/<id>/messages', async () => {
    await withScene(async (scene) => {
      const handler = aliceHandlerOver({
        ...scene.harness.bureau,
        contexts: { ...scene.harness.bureau.contexts, get: async () => scene.bobSession },
        tasks: tasksWithBobLive(scene),
      });

      const response = await handler(
        new Request(
          `http://localhost${DEFAULT_AG_UI_PATH_PREFIX}/threads/${ALICE_THREAD}/messages`,
        ),
      );
      const text = await response.text();

      expect(response.status).toBe(404);
      expect(JSON.parse(text)).toMatchObject({
        code: 'NotFound',
        data: { resource: 'thread', identifier: ALICE_THREAD },
      });
      expectNothingOfBob(scene, text);
    });
  });

  it('is one THREAD_NOT_FOUND event on an attach by thread', async () => {
    await withScene(async (scene) => {
      const handler = aliceHandlerOver({
        ...scene.harness.bureau,
        contexts: { ...scene.harness.bureau.contexts, get: async () => scene.bobSession },
        tasks: tasksWithBobLive(scene),
      });

      const response = await handler(attachThreadRequest(ALICE_THREAD));
      const text = await response.clone().text();
      const frames = await readAgUiStream(response);

      expect(frames).toHaveLength(1);
      expect(frames[0]!.event).toMatchObject(THREAD_NOT_FOUND);
      expectNothingOfBob(scene, text);
    });
  });

  it('is one THREAD_NOT_FOUND event on a new start, decided before the thread lease', async () => {
    await withScene(async (scene) => {
      const runtime = createDefaultRuntimeServices();
      const handler = aliceHandlerOver({
        ...scene.harness.bureau,
        contexts: { ...scene.harness.bureau.contexts, get: async () => scene.bobSession },
        tasks: tasksWithBobLive(scene),
      });
      // Another start holds the thread: a caller who may not use the thread must not learn that.
      const leases = createAgUiLeases({ kv: scene.harness.bureau.internals.kv!, runtime });
      const held = await leases.acquire('thread', ALICE_THREAD);
      expect(held).toBeDefined();
      try {
        const response = await handler(
          startRequest(runAgentInput({ threadId: ALICE_THREAD, runId: 'alice-start' })),
        );
        const text = await response.clone().text();
        const frames = await readAgUiStream(response);

        expect(frames).toHaveLength(1);
        expect(frames[0]!.event).toMatchObject(THREAD_NOT_FOUND);
        expectNothingOfBob(scene, text);
      } finally {
        await held!.release();
      }
    });
  });

  it('is one THREAD_NOT_FOUND event on a start whose session is read under the lease', async () => {
    await withScene(async (scene) => {
      // The thread is free when the owner is first checked, and another owner's by the time the
      // start reads it under the lease.
      let reads = 0;
      const handler = aliceHandlerOver({
        ...scene.harness.bureau,
        contexts: {
          ...scene.harness.bureau.contexts,
          get: async () => (reads++ === 0 ? undefined : scene.bobSession),
        },
        tasks: tasksWithBobLive(scene),
      });

      const response = await handler(
        startRequest(runAgentInput({ threadId: ALICE_THREAD, runId: 'alice-start' })),
      );
      const text = await response.clone().text();
      const frames = await readAgUiStream(response);

      expect(reads).toBeGreaterThan(1);
      expect(frames).toHaveLength(1);
      expect(frames[0]!.event).toMatchObject(THREAD_NOT_FOUND);
      expectNothingOfBob(scene, text);
    });
  });

  it('is acknowledged only, with no MESSAGES_SNAPSHOT, on a resume', async () => {
    await withScene(async (scene) => {
      const handler = aliceHandlerOver({
        ...scene.harness.bureau,
        contexts: { ...scene.harness.bureau.contexts, get: async () => scene.bobSession },
        tasks: tasksWithBobLive(scene),
      });

      const response = await handler(
        startRequest(
          runAgentInput({
            threadId: ALICE_THREAD,
            runId: 'alice-resume',
            messages: [],
            resume: [{ interruptId: scene.alice.reviewId, status: 'cancelled' }],
          }),
        ),
      );
      const text = await response.clone().text();
      const frames = await readAgUiStream(response);

      expect(frames.map((frame) => frame.event.type)).toEqual([
        EventType.RUN_STARTED,
        EventType.RUN_FINISHED,
      ]);
      expectNothingOfBob(scene, text);
    });
  });
});

describe('a run stream over a session or run that is another owner’s than the one authorized', () => {
  const environmentFor = (bureau: AgUiStreamBureau) => ({
    bureau,
    runtime: createDefaultRuntimeServices(),
    maxStreamDurationMs: 5000,
    liveBufferSize: 100,
    keepAliveMs: 1000,
  });

  it('shows none of the session’s conversation, in its snapshot or in what the run delivered', async () => {
    await withScene(async (scene) => {
      // The run is no longer held, so the stream is built from the session it reads, which is
      // bob's, and the run names a row of it as one it took from its client.
      const bureau: AgUiStreamBureau = {
        ...scene.harness.bureau,
        internals: { ...scene.harness.bureau.internals, whenTaskRecorded: async () => undefined },
        tasks: { ...scene.harness.bureau.tasks, detail: () => undefined },
        contexts: {
          ...scene.harness.bureau.contexts,
          get: async () => scene.bobSession,
          inputsDeliveredBy: async () => [BOB_MESSAGE],
        },
      };

      const response = openRunStream(environmentFor(bureau), {
        threadId: ALICE_THREAD,
        runId: 'attach',
        nativeRunId: scene.alice.runId,
        owner: ALICE,
        replay: 'open-step',
        messagesSnapshot: true,
      });
      const text = await response.clone().text();
      const frames = await readAgUiStream(response);

      expectNothingOfBob(scene, text);
      const snapshot = frames.find((frame) => frame.event.type === EventType.MESSAGES_SNAPSHOT);
      expect((snapshot?.event as { messages?: unknown[] } | undefined)?.messages).toEqual([]);
    });
  });

  it('is one RUN_NOT_FOUND event when the run held is not the authorized owner’s', async () => {
    await withScene(async (scene) => {
      const held = scene.harness.bureau.tasks.detail(scene.alice.runId);
      if (held === undefined) throw new Error('alice has no run');
      const bureau: AgUiStreamBureau = {
        ...scene.harness.bureau,
        tasks: {
          ...scene.harness.bureau.tasks,
          detail: () => ({ ...held, principal: 'api-key:bob' }),
        },
      };

      const response = openRunStream(environmentFor(bureau), {
        threadId: ALICE_THREAD,
        runId: 'attach',
        nativeRunId: scene.alice.runId,
        owner: ALICE,
        replay: 'open-step',
        messagesSnapshot: true,
      });
      const frames = await readAgUiStream(response);

      expect(frames).toHaveLength(1);
      expect(frames[0]!.event).toMatchObject({ type: EventType.RUN_ERROR, code: 'RUN_NOT_FOUND' });
    });
  });
});

describe('a live run of another owner on an authorized thread', () => {
  it('is not attached to by thread', async () => {
    await withScene(async (scene) => {
      // The session is alice's own, and the live run it last started is bob's.
      const aliceSession = await scene.harness.bureau.contexts.get(ALICE_THREAD);
      if (aliceSession === undefined) throw new Error('alice has no session');
      const handler = aliceHandlerOver({
        ...scene.harness.bureau,
        contexts: {
          ...scene.harness.bureau.contexts,
          get: async () => ({
            ...aliceSession,
            metadata: { ...aliceSession.metadata, lastRunId: scene.bob.runId },
          }),
        },
        tasks: tasksWithBobLive(scene),
      });

      const response = await handler(attachThreadRequest(ALICE_THREAD));
      const text = await response.clone().text();
      const frames = await readAgUiStream(response);

      expect(frames).toHaveLength(1);
      expect(frames[0]!.event).toMatchObject({ type: EventType.RUN_ERROR, code: 'RUN_NOT_FOUND' });
      expectNothingOfBob(scene, text);
    });
  });
});

describe('AgUiAuthorization.ownerOf', () => {
  it('does not take a session, whose owner of record the mount reads from the session itself', () => {
    const authorization: AgUiAuthorization = {
      mayAccess: mayAccessOwnedResource,
      ownerOf: async () => undefined,
    };

    // @ts-expect-error a session's owner is read from the loaded session, never looked up apart
    void authorization.ownerOf({ kind: 'session', id: ALICE_THREAD });
    void authorization.ownerOf({ kind: 'run', id: 'run-1' });
    void authorization.ownerOf({ kind: 'review', id: 'review-1' });
  });
});
