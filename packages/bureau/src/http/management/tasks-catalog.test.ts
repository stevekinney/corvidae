/**
 * A `bureau.run()` dispatch is a task too. It owns no session and records no durable
 * `run.*` events, so its stream is the snapshot alone; its human wait is a review of the
 * task; and an abort through its own handle leaves a cleanup the cancel operation reports.
 */
import { createAgent, type GenerateContext, stopWhen } from '@lostgradient/operative';
import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';

import { waitForCondition } from '../../test';
import {
  answering,
  openBureau,
  type OpenedBureau,
  OWNER,
  parkingUntilAborted,
  readFrames,
  rpc,
  subscribeRequest,
} from './management-fixtures.test-support.ts';

async function withBureau<T>(
  options: Parameters<typeof openBureau>[0],
  body: (opened: OpenedBureau) => Promise<T>,
): Promise<T> {
  const opened = await openBureau(options);
  try {
    return await body(opened);
  } finally {
    await opened.dispose();
  }
}

const holder = createAgent({ name: 'holder', generate: parkingUntilAborted });

/** An agent that asks a human, parks, and thanks them once answered. */
const asker = createAgent({
  generate: async (context: GenerateContext) =>
    context.step === 0
      ? {
          content: '',
          toolCalls: [
            {
              id: 'call-1',
              name: 'requestHumanInput',
              arguments: { signalName: 'answer', prompt: 'Which environment?' },
            },
          ],
        }
      : { content: 'thanks', toolCalls: [] },
  toolbox: createToolbox([]),
  stopWhen: stopWhen.some(stopWhen.toolCalled('requestHumanInput'), stopWhen.noToolCalls()),
});

describe('a catalog task', () => {
  it('ends its event stream after the snapshot, because it records no durable history to follow', async () => {
    await withBureau({ agents: { holder }, durableHistory: true }, async (opened) => {
      const run = opened.bureau.run('holder', 'work', { principal: OWNER.alice });
      try {
        await waitForCondition(
          async () => (await opened.bureau.tasks.get(run.id)) !== undefined,
          'the dispatch was never recorded as a task',
        );

        const frames = await readFrames(
          await opened.handler(
            subscribeRequest('bureau.tasks.events', { taskId: run.id }, 'alice-key'),
          ),
          { timeoutMs: 1_500 },
        );

        expect(frames.map((frame) => frame.event)).toEqual(['task.snapshot']);
      } finally {
        run.abort('test over');
        await run.closed();
      }
    });
  });

  it('carries the answer of a completed catalog task in its snapshot, as an artifact', async () => {
    const answerer = createAgent({ name: 'answerer', generate: answering('the catalog answer') });
    await withBureau({ agents: { answerer }, durableHistory: true }, async (opened) => {
      const run = opened.bureau.run('answerer', 'question', { principal: OWNER.alice });
      await run.result();
      await waitForCondition(async () => {
        const task = await opened.bureau.tasks.get(run.id);
        return task?.status === 'completed';
      }, 'the task never settled as completed');

      const frames = await readFrames(
        await opened.handler(
          subscribeRequest('bureau.tasks.events', { taskId: run.id }, 'alice-key'),
        ),
        { timeoutMs: 1_500 },
      );

      expect(frames.map((frame) => frame.event)).toEqual(['task.snapshot']);
      expect(frames[0]?.data).toMatchObject({
        status: 'completed',
        artifact: { artifactId: `${run.id}:result`, text: 'the catalog answer', truncated: false },
      });
    });
  });

  it('answers a cancel after an abort through its own handle with the cleanup the handle reported', async () => {
    await withBureau({ agents: { holder } }, async (opened) => {
      const run = opened.bureau.run('holder', 'work', { principal: OWNER.alice });
      await waitForCondition(async () => {
        const task = await opened.bureau.tasks.get(run.id);
        return task !== undefined;
      }, 'the dispatch was never recorded as a task');
      run.abort('stopped by its owner');
      const acknowledgement = await run.closed();
      await waitForCondition(async () => {
        const task = await opened.bureau.tasks.get(run.id);
        return task?.status === 'canceled';
      }, 'the task never settled as canceled');

      const body = await rpc(
        opened.handler,
        'bureau.tasks.cancel',
        { taskId: run.id },
        'alice-key',
      );

      expect(acknowledgement.status).toBe('completed');
      expect(body.result).toMatchObject({ receipt: 'cleaned-up' });
      const task = await rpc(opened.handler, 'bureau.tasks.get', { taskId: run.id }, 'alice-key');
      expect(task.result).toMatchObject({ status: 'canceled', cleanup: 'cleaned-up' });
    });
  });

  it('is input-required while its run waits on a human, and respond answers that wait', async () => {
    await withBureau({ agents: { asker }, humanInput: true }, async (opened) => {
      const run = opened.bureau.run('asker', 'which one?', { principal: OWNER.alice });
      await waitForCondition(
        () => opened.bureau.listPendingReviews().some((review) => review.runId === run.id),
        'the run never parked',
      );

      const waiting = await rpc(
        opened.handler,
        'bureau.tasks.get',
        { taskId: run.id },
        'alice-key',
      );
      const answered = await rpc(
        opened.handler,
        'bureau.tasks.respond',
        { taskId: run.id, messageId: 'm1', answer: 'staging' },
        'alice-key',
      );
      const result = await run.result();

      expect(waiting.result).toMatchObject({
        status: 'input-required',
        openWaits: [{ kind: 'human-wait', signalName: 'answer' }],
      });
      expect(answered.result).toMatchObject({ kind: 'human-wait', receipt: 'applied' });
      expect(result.finishReason).toBe('stop-condition');
    });
  });
});
