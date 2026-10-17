import type { GenerateContext, GenerateFunction } from '@lostgradient/operative';
import { yieldToPortableEventLoop } from '@lostgradient/weft';
import { createTool, createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import type { Conversation } from 'conversationalist';
import { z } from 'zod';

import { createBureau } from './create-bureau';
import type { Bureau } from './types';

/**
 * COR-1476 — input `submitSessionInput` admits reaches the live durable run at
 * its next step boundary, and its receipt moves to `promoted`.
 */

const nextTool = createTool({
  name: 'next',
  description: 'continue',
  input: z.object({}),
  execute: async () => 'ok',
});

function deferred<T = void>() {
  let release!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, resolve: release };
}

function userTexts(conversation: Conversation): string[] {
  return conversation
    .getMessages()
    .filter((message) => message.role === 'user')
    .map((message) => (typeof message.content === 'string' ? message.content : ''));
}

async function pollUntil(
  check: () => boolean | Promise<boolean>,
  attempts = 200,
): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await check()) return true;
    await yieldToPortableEventLoop();
  }
  return check();
}

async function openBureau(generate: GenerateFunction): Promise<Bureau> {
  return createBureau({
    agents: {},
    generate,
    toolbox: createToolbox([nextTool]),
    storage: { type: 'memory' },
    durableExecution: true,
  });
}

describe('createBureau delivers admitted session input at the next step boundary (COR-1476)', () => {
  it('shows two inputs to the model in admission order, promotes their receipts, and leaves the outbox drainable', async () => {
    const stepZeroStarted = deferred();
    const releaseStepZero = deferred();
    const stepTwoStarted = deferred();
    const releaseStepTwo = deferred();
    const prompts: string[][] = [];
    const bureau = await openBureau(async (context: GenerateContext) => {
      prompts[context.step] = userTexts(context.conversation);
      if (context.step === 0) {
        stepZeroStarted.resolve();
        await releaseStepZero.promise;
        return { content: 'working', toolCalls: [{ name: 'next', arguments: {} }] };
      }
      if (context.step === 1) {
        return { content: 'still working', toolCalls: [{ name: 'next', arguments: {} }] };
      }
      stepTwoStarted.resolve();
      await releaseStepTwo.promise;
      return { content: 'done', toolCalls: [] };
    });
    try {
      const run = await bureau.createRun({ message: 'Start', principal: 'alice' });
      await stepZeroStarted.promise;

      const first = await bureau.submitSessionInput(run.sessionId, {
        id: 'input-a',
        principal: 'alice',
        deliveryMode: 'steer',
        payload: 'first',
      });
      const second = await bureau.submitSessionInput(run.sessionId, {
        id: 'input-b',
        principal: 'alice',
        deliveryMode: 'queue',
        payload: 'second',
      });
      expect(first.outcome).toBe('admitted');
      expect(second.outcome).toBe('admitted');
      if (first.outcome !== 'admitted') throw new Error('expected admitted');
      expect(first.receipt.state).toBe('accepted');

      releaseStepZero.resolve();
      await stepTwoStarted.promise;

      // Step 1 was the boundary that delivered both, in the order admitted; step
      // 2 sees them once, not again.
      expect(prompts[0]).toEqual(['Start']);
      expect(prompts[1]).toEqual(['Start', 'first', 'second']);
      expect(prompts[2]).toEqual(['Start', 'first', 'second']);

      // Step 1's result is durable by now, so the receipt reads promoted.
      const replay = await bureau.submitSessionInput(run.sessionId, {
        id: 'input-a',
        principal: 'alice',
        deliveryMode: 'steer',
        payload: 'first',
      });
      expect(replay.outcome).toBe('replayed');
      if (replay.outcome !== 'replayed') throw new Error('expected replayed');
      expect(replay.receipt.state).toBe('promoted');
      const replayB = await bureau.submitSessionInput(run.sessionId, {
        id: 'input-b',
        principal: 'alice',
        deliveryMode: 'queue',
        payload: 'second',
      });
      if (replayB.outcome !== 'replayed') throw new Error('expected replayed');
      expect(replayB.receipt.state).toBe('promoted');

      // A promotion rides the session outbox; it must not stop the drain from
      // reaching the session's later facts.
      await bureau.runDurableMaintenance();
      expect(await bureau.sessionStore?.outbox.pending()).toEqual([]);

      releaseStepTwo.resolve();
      await pollUntil(async () => {
        const session = await bureau.getSession(run.sessionId);
        return session?.metadata['lastRunStatus'] === 'completed';
      });
    } finally {
      releaseStepZero.resolve();
      releaseStepTwo.resolve();
      await bureau.dispose();
    }
  });
});
