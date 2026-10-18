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
  as,
  attachRunRequest,
  authentication,
  cancelRequest,
  runAgentInput,
  startRequest,
} from './ag-ui-fixtures.test-support.ts';
import { bureauMetadata, FrameReader, readAgUiStream } from './ag-ui-stream.test-support.ts';
import { createBureauHandler } from './create-bureau-handler.ts';

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
  const bureau = await createBureau({
    id: 'children-fixture',
    agents: {
      assistant: createAgent({ generate: script, name: 'assistant' }),
      worker: createAgent({ generate: script, name: 'worker' }),
    },
    generate: script,
    toolbox: createToolbox([]),
    stopWhen: stopWhen.noToolCalls(),
    storage: { type: 'memory' },
    durableExecution: true,
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
      bureau: bureau as unknown as Bureau,
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
      expect((await bureau.children.get({ parentRunId, childRunId: childId }))?.status).toBe(
        'aborted',
      );
    });
  });

  it('are not cancelled by anyone else, who is answered as for a run that never was', async () => {
    await withParentAndChild(async ({ handler, childId }) => {
      const stranger = await handler(cancelRequest(childId, as('bob-key')));
      const random = await handler(cancelRequest('child-run-never-was', as('bob-key')));

      expect(stranger.status).toBe(404);
      expect(await stranger.text()).toBe(
        (await random.text()).replaceAll('child-run-never-was', childId),
      );
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
