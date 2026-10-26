/**
 * COR-855 — a Bureau child run is a separate native run with its own id and
 * owner. The mount projects it as a separate AG-UI run: its owner attaches by its
 * own id and sees the parent's id on `RUN_STARTED`, anyone else is answered as for
 * a missing run, and the parent's stream carries none of it.
 */
import { EventType } from '@ag-ui/core';
import {
  createAgent,
  createScriptedGenerate,
  type ScriptedGenerate,
  type ScriptedGenerateStep,
  stopWhen,
} from '@lostgradient/operative';
import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';

import { createBureau } from '../create-bureau.ts';
import type { Bureau } from '../types.ts';
import {
  aliceHandlerOver,
  as,
  attachRunRequest,
  authentication,
  cancelRequest,
  runAgentInput,
  startRequest,
} from './ag-ui-fixtures.test-support.ts';
import {
  bureauMetadata,
  FrameReader,
  readAgUiStream,
  typesOf,
} from './ag-ui-stream.test-support.ts';
import { createBureauHandler } from './create-bureau-handler.ts';
import { createMemoryAssetStorage } from '../assets/storage';
import type { AgentDefinitions } from '../agent-catalog';

type Handler = ReturnType<typeof createBureauHandler>;

/** A parent run of alice's, held mid-step, with a child of it running. */
async function withParentAndChild<T>(
  body: (context: {
    bureau: Bureau;
    handler: Handler;
    parent: FrameReader;
    parentRunId: string;
    childId: string;
    script: ScriptedGenerate;
  }) => Promise<T>,
  /** What the child's one step answers once it is released. */
  childStep: ScriptedGenerateStep = {
    kind: 'respond',
    response: { content: 'Child done.', toolCalls: [] },
  },
): Promise<T> {
  const script = createScriptedGenerate([
    // A held step takes the step after it as its answer once released, so each
    // block below is followed by what its call answers. The parent's first step is
    // held while a child is dispatched, and answers 'Parent done.'.
    { kind: 'block', barrier: 'hold' },
    { kind: 'respond', response: { content: 'Parent done.', toolCalls: [] } },
    // The child's only step, which the child's cancellation interrupts once it returns.
    { kind: 'block', barrier: 'child-hold' },
    childStep,
  ]);
  const bureau = await createBureau<AgentDefinitions>({
    assets: { storage: createMemoryAssetStorage() },
    id: 'children-fixture',
    agents: {
      assistant: createAgent({ generate: script, name: 'assistant' }),
      worker: createAgent({ generate: script, name: 'worker' }),
      default: createAgent({
        generate: script,
        toolbox: createToolbox([]),
        stopWhen: stopWhen.noToolCalls(),
      }),
    },
    storage: { type: 'memory' },
    durable: true,
    children: {},
  });
  const handler = createBureauHandler(bureau, { authentication, publish: ['assistant'], agUi: {} });
  try {
    const parent = new FrameReader(await handler(startRequest(runAgentInput(), as('alice-key'))));
    await parent.until(EventType.STEP_STARTED);
    await script.reached('hold');
    const parentRunId = String(bureauMetadata(parent.received[0]!.event)['runId']);
    const dispatched = await bureau.children.dispatch({
      parentRunId,
      agentName: 'worker',
      input: 'child work',
    });
    if (dispatched.outcome !== 'started') throw new Error('expected a started child');
    await script.reached('child-hold');
    return await body({
      bureau: bureau,
      handler,
      parent,
      parentRunId,
      childId: dispatched.child.childRunId,
      script,
    });
  } finally {
    script.release('hold');
    script.release('child-hold');
    await bureau.dispose();
  }
}

describe('child runs', () => {
  it('are attachable by their owner, and the stream names the parent', async () => {
    await withParentAndChild(async ({ bureau, handler, parentRunId, childId, script }) => {
      const attached = new FrameReader(await handler(attachRunRequest(childId, as('alice-key'))));

      const opening = await attached.until(EventType.STATE_SNAPSHOT);

      // The thread is the parent's session, as on every stream of this mount.
      expect(opening[0]!.event).toMatchObject({
        type: EventType.RUN_STARTED,
        threadId: 'thread-1',
        runId: childId,
        parentRunId,
      });
      expect(bureauMetadata(opening[0]!.event)['runId']).toBe(childId);
      expect(bureauMetadata(opening[0]!.event)['sessionId']).toBe('thread-1');
      // The child ends when it is cancelled, and the stream says so.
      await bureau.children.cancel({ parentRunId, childRunId: childId });
      script.release('child-hold');
      const tail = await attached.rest();
      expect(tail.at(-1)!.event).toMatchObject({
        type: EventType.RUN_FINISHED,
        outcome: { type: 'cancelled' },
      });
    });
  });

  it('are cancelled by their owner through the cancel route', async () => {
    await withParentAndChild(async ({ bureau, handler, parentRunId, childId, script }) => {
      const attached = new FrameReader(await handler(attachRunRequest(childId, as('alice-key'))));
      await attached.until(EventType.STATE_SNAPSHOT);

      const cancelled = await handler(cancelRequest(childId, as('alice-key')));
      script.release('child-hold');
      const tail = await attached.rest();

      expect(cancelled.status).toBe(200);
      expect(await cancelled.json()).toMatchObject({ runId: childId });
      expect(tail.at(-1)!.event).toMatchObject({
        type: EventType.RUN_FINISHED,
        outcome: { type: 'cancelled' },
      });
      const record = await bureau.children.get({ parentRunId, childRunId: childId });
      expect(record?.status).toBe('aborted');
    });
  });

  it('are not cancelled by anyone else, who is answered as for a run that never was', async () => {
    await withParentAndChild(async ({ handler, childId }) => {
      const stranger = await handler(cancelRequest(childId, as('bob-key')));
      const random = await handler(cancelRequest('child-run-never-was', as('bob-key')));

      const strangerText = await stranger.text();
      const randomText = await random.text();

      expect(stranger.status).toBe(404);
      expect(strangerText).toBe(randomText.replaceAll('child-run-never-was', childId));
    });
  });

  it('stream their result under their own row id when they settle while attached', async () => {
    await withParentAndChild(async ({ handler, childId, script }) => {
      const attached = new FrameReader(await handler(attachRunRequest(childId, as('alice-key'))));
      const opening = await attached.until(EventType.STATE_SNAPSHOT);

      script.release('child-hold');
      const tail = await attached.rest();

      const snapshot = opening.find((frame) => frame.event.type === EventType.MESSAGES_SNAPSHOT)!
        .event as unknown as { messages: unknown[] };
      expect(snapshot.messages).toEqual([]);
      expect(typesOf(tail)).toEqual([
        EventType.TEXT_MESSAGE_START,
        EventType.TEXT_MESSAGE_CONTENT,
        EventType.TEXT_MESSAGE_END,
        EventType.RUN_FINISHED,
      ]);
      expect(tail[0]!.event).toMatchObject({ messageId: `${childId}:step:0`, role: 'assistant' });
      expect(tail[1]!.event).toMatchObject({ delta: 'Child done.' });
      expect(tail.at(-1)!.event).toMatchObject({ outcome: { type: 'success' } });
    });
  });

  it('carry their result in the snapshot of a stream that attaches after they settled', async () => {
    await withParentAndChild(async ({ bureau, handler, parentRunId, childId, script }) => {
      script.release('child-hold');
      await bureau.children.wait({ parentRunId, childRunId: childId });

      const frames = await readAgUiStream(
        await handler(attachRunRequest(childId, as('alice-key'))),
      );

      const snapshot = frames.find((frame) => frame.event.type === EventType.MESSAGES_SNAPSHOT)!
        .event as unknown as { messages: unknown[] };
      expect(snapshot.messages).toEqual([
        { id: `${childId}:step:0`, role: 'assistant', content: 'Child done.' },
      ]);
      expect(frames.at(-1)!.event).toMatchObject({ outcome: { type: 'success' } });
    });
  });

  it('end the stream with RUN_ERROR when the child failed', async () => {
    await withParentAndChild(
      async ({ handler, childId, script }) => {
        const attached = new FrameReader(await handler(attachRunRequest(childId, as('alice-key'))));
        await attached.until(EventType.STATE_SNAPSHOT);

        script.release('child-hold');
        const tail = await attached.rest();

        expect(tail.at(-1)!.event).toMatchObject({
          type: EventType.RUN_ERROR,
          code: 'RUN_FAILED',
          message: expect.stringContaining('the child could not answer'),
        });
      },
      { kind: 'fail', error: new Error('the child could not answer') },
    );
  });

  it('answer a non-owner exactly as they answer a run that never was', async () => {
    await withParentAndChild(async ({ handler, childId }) => {
      const mask = (frames: Awaited<ReturnType<typeof readAgUiStream>>, id: string) =>
        JSON.stringify(frames.map((frame) => frame.event))
          .replaceAll(id, '<id>')
          .replace(/"timestamp":\d+/g, '"timestamp":0');

      const stranger = await readAgUiStream(
        await handler(attachRunRequest(childId, as('bob-key'))),
      );
      const random = await readAgUiStream(
        await handler(attachRunRequest('child-run-never-was', as('bob-key'))),
      );

      expect(stranger).toHaveLength(1);
      expect(stranger[0]!.event).toMatchObject({
        type: EventType.RUN_ERROR,
        code: 'RUN_NOT_FOUND',
      });
      expect(mask(stranger, childId)).toBe(mask(random, 'child-run-never-was'));
    });
  });

  it('refuse an authorized attach whose located record is another owner’s (COR-1588)', async () => {
    await withParentAndChild(async ({ bureau, childId }) => {
      // The route authorizes the id as alice's, but the record located under it is bob's, as when
      // whoever dispatches a child chooses an id another owner's run already answers to. The
      // stream checks the record it opens, not only the id the route authorized.
      const handler = aliceHandlerOver({
        ...bureau,
        children: {
          ...bureau.children,
          locate: async (id) => {
            const record = await bureau.children.locate(id);
            return record === undefined ? undefined : { ...record, principal: 'api-key:bob' };
          },
        },
      });

      // The first frame decides it, so a stream that wrongly opens fails here rather than hanging
      // on a child that is still held.
      const attached = new FrameReader(await handler(attachRunRequest(childId, as('alice-key'))));
      try {
        const first = await attached.next();
        expect(first?.event).toMatchObject({ type: EventType.RUN_ERROR, code: 'RUN_NOT_FOUND' });
        expect(await attached.next()).toBeUndefined();
      } finally {
        await attached.cancel();
      }
    });
  });

  it('never put their events or their input on the parent’s stream', async () => {
    await withParentAndChild(async ({ parent, script, childId }) => {
      script.release('hold');
      const tail = await parent.rest();
      const everything = JSON.stringify([...parent.received, ...tail]);

      expect(tail.at(-1)!.event.type).toBe(EventType.RUN_FINISHED);
      expect(everything).not.toContain(childId);
      expect(everything).not.toContain('child work');
    });
  });
});
