import {
  type GenerateContext,
  type GenerateFunction,
  stopWhen,
  createAgent,
} from '@lostgradient/operative';
import { MemoryStorage, textValueStore } from '@lostgradient/storage';
import { createTool, createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { type Conversation, CURRENT_SCHEMA_VERSION } from 'conversationalist';
import { z } from 'zod';

import { createBureau } from './create-bureau';
import { admitSessionInput, createSessionInputMailbox } from './session-input-durability';
import type { Bureau } from './types';
import type { AgentDefinitions } from './agent-catalog';
import { waitUntil } from '@lostgradient/testing/wait-until';

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

async function pollUntil(check: () => boolean | Promise<boolean>): Promise<true> {
  await waitUntil(check, { message: 'pollUntil' });
  return true;
}

async function openBureau(generate: GenerateFunction): Promise<Bureau> {
  return createBureau<AgentDefinitions>({
    agents: {
      default: createAgent({
        generate,
        toolbox: createToolbox([nextTool]),
        stopWhen: stopWhen.noToolCalls(),
      }),
    },
    storage: new MemoryStorage(),
    durable: true,
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
      const run = await bureau.tasks.start('default', 'Start', { principal: 'alice' });
      await stepZeroStarted.promise;

      const first = await bureau.contexts.input(run.contextId, {
        id: 'input-a',
        principal: 'alice',
        deliveryMode: 'steer',
        payload: 'first',
      });
      const second = await bureau.contexts.input(run.contextId, {
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
      const replay = await bureau.contexts.input(run.contextId, {
        id: 'input-a',
        principal: 'alice',
        deliveryMode: 'steer',
        payload: 'first',
      });
      expect(replay.outcome).toBe('replayed');
      if (replay.outcome !== 'replayed') throw new Error('expected replayed');
      expect(replay.receipt.state).toBe('promoted');
      const replayB = await bureau.contexts.input(run.contextId, {
        id: 'input-b',
        principal: 'alice',
        deliveryMode: 'queue',
        payload: 'second',
      });
      if (replayB.outcome !== 'replayed') throw new Error('expected replayed');
      expect(replayB.receipt.state).toBe('promoted');

      // A promotion rides the session outbox; it must not stop the drain from
      // reaching the session's later facts.
      await bureau.maintain();
      expect(await bureau.internals.sessionStore?.outbox.pending()).toEqual([]);

      releaseStepTwo.resolve();
      await pollUntil(async () => {
        const session = await bureau.contexts.get(run.contextId);
        return session?.metadata['lastRunStatus'] === 'completed';
      });
    } finally {
      releaseStepZero.resolve();
      releaseStepTwo.resolve();
      await bureau.dispose();
    }
  });

  it("answers input sent during a run's final step in that same run, in order", async () => {
    const stepZeroStarted = deferred();
    const releaseStepZero = deferred();
    const prompts: string[][] = [];
    const bureau = await openBureau(async (context: GenerateContext) => {
      prompts.push(userTexts(context.conversation));
      if (context.step === 0) {
        stepZeroStarted.resolve();
        await releaseStepZero.promise;
      }
      // No tool calls: step 0 would end the run.
      return { content: `answer ${context.step}`, toolCalls: [] };
    });
    try {
      const run = await bureau.tasks.start('default', 'First', { principal: 'alice' });
      await stepZeroStarted.promise;
      for (const [id, payload] of [
        ['input-a', 'sent while the agent was answering'],
        ['input-b', 'and a second thing'],
      ] as const) {
        const admitted = await bureau.contexts.input(run.contextId, {
          id,
          principal: 'alice',
          deliveryMode: 'steer',
          payload,
        });
        expect(admitted.outcome).toBe('admitted');
      }
      releaseStepZero.resolve();
      await bureau.tasks.wait(run.id);

      expect(prompts).toEqual([
        ['First'],
        ['First', 'sent while the agent was answering', 'and a second thing'],
      ]);
    } finally {
      releaseStepZero.resolve();
      await bureau.dispose();
    }
  });

  it('does not hand a recreated session the input its deleted incarnation left pending', async () => {
    const hold = deferred();
    const prompts: { run: number; texts: string[] }[] = [];
    let runNumber = 0;
    const firstStarted = deferred();
    const bureau = await openBureau(async (context: GenerateContext) => {
      prompts.push({ run: runNumber, texts: userTexts(context.conversation) });
      if (runNumber === 1) {
        firstStarted.resolve();
        await hold.promise;
      }
      return { content: 'done', toolCalls: [] };
    });
    try {
      runNumber = 1;
      const first = await bureau.tasks.start('default', 'First', { principal: 'alice' });
      await firstStarted.promise;
      const admitted = await bureau.contexts.input(first.contextId, {
        id: 'input-a',
        principal: 'alice',
        deliveryMode: 'steer',
        payload: 'meant for the deleted session',
      });
      expect(admitted.outcome).toBe('admitted');

      await bureau.contexts.delete(first.contextId);
      hold.resolve();

      runNumber = 2;
      const second = await bureau.tasks.start('default', 'Second', {
        contextId: first.contextId,
        principal: 'alice',
      });
      await bureau.tasks.wait(second.id);

      const secondRun = prompts.filter(({ run }) => run === 2);
      expect(secondRun).toEqual([{ run: 2, texts: ['Second'] }]);
    } finally {
      hold.resolve();
      await bureau.dispose();
    }
  });

  it('answers unsupported-capability for a session id of exactly 300 bytes, which no command could carry as its target', async () => {
    const started = deferred();
    const hold = deferred();
    const bureau = await openBureau(async () => {
      started.resolve();
      await hold.promise;
      return { content: 'done', toolCalls: [] };
    });
    try {
      const longId = 's'.repeat(300);
      const run = await bureau.tasks.start('default', 'Start', {
        contextId: longId,
        principal: 'alice',
      });
      await started.promise;
      const outcome = await bureau.contexts.input(run.contextId, {
        id: 'input-a',
        principal: 'alice',
        deliveryMode: 'steer',
        payload: 'hello',
      });
      expect(outcome).toEqual({
        outcome: 'unsupported-capability',
        reason: 'durable-mailbox-unavailable',
      });
    } finally {
      hold.resolve();
      await bureau.dispose();
    }
  });

  it('answers unsupported-capability, rather than throwing, for a session id too long to address a mailbox', async () => {
    const started = deferred();
    const hold = deferred();
    const bureau = await openBureau(async () => {
      started.resolve();
      await hold.promise;
      return { content: 'done', toolCalls: [] };
    });
    try {
      const longId = `session-${'x'.repeat(300)}`;
      const run = await bureau.tasks.start('default', 'Start', {
        contextId: longId,
        principal: 'alice',
      });
      await started.promise;
      const outcome = await bureau.contexts.input(run.contextId, {
        id: 'input-a',
        principal: 'alice',
        deliveryMode: 'steer',
        payload: 'hello',
      });
      expect(outcome).toEqual({
        outcome: 'unsupported-capability',
        reason: 'durable-mailbox-unavailable',
      });
    } finally {
      hold.resolve();
      await bureau.dispose();
    }
  });

  it('still settles an input whose cancellation arrives while the step holding it generates', async () => {
    const storage = new MemoryStorage();
    const stepZeroStarted = deferred();
    const releaseStepZero = deferred();
    const stepOneStarted = deferred();
    const releaseStepOne = deferred();
    const prompts: string[][] = [];
    const bureau = await createBureau<AgentDefinitions>({
      agents: {
        default: createAgent({
          generate: async (context: GenerateContext) => {
            prompts.push(userTexts(context.conversation));
            if (context.step === 0) {
              stepZeroStarted.resolve();
              await releaseStepZero.promise;
              return { content: 'working', toolCalls: [{ name: 'next', arguments: {} }] };
            }
            stepOneStarted.resolve();
            await releaseStepOne.promise;
            return { content: 'done', toolCalls: [] };
          },
          toolbox: createToolbox([nextTool]),
          stopWhen: stopWhen.noToolCalls(),
        }),
      },
      storage,
      durable: true,
    });
    try {
      const run = await bureau.tasks.start('default', 'Start', { principal: 'alice' });
      await stepZeroStarted.promise;
      await bureau.contexts.input(run.contextId, {
        id: 'input-a',
        principal: 'alice',
        deliveryMode: 'steer',
        payload: 'cancel me later',
      });
      releaseStepZero.resolve();
      await stepOneStarted.promise;

      // The step already holds the input; the caller cancels it now.
      const session = await bureau.contexts.get(run.contextId);
      const mailbox = createSessionInputMailbox(
        storage,
        run.contextId,
        session?.incarnation ?? '',
        100,
      );
      const [receipt] = await mailbox.list({ states: ['claimed'], limit: 1 });
      await mailbox.requestCancellation({
        commandId: receipt!.commandId,
        reason: 'changed my mind',
      });
      releaseStepOne.resolve();
      await bureau.tasks.wait(run.id);

      // The transcript holds it, so the receipt is promoted even though the
      // mailbox closed the command as cancelled.
      expect(prompts[1]).toEqual(['Start', 'cancel me later']);
      const final = await mailbox.receipt(receipt!.commandId);
      expect(final?.state).toBe('cancelled');
      const replay = await admitSessionInput({
        storage,
        kv: textValueStore(storage),
        sessionMailbox: mailbox,
        sessionId: run.contextId,
        incarnation: session?.incarnation ?? '',
        id: 'input-a',
        principal: 'alice',
        deliveryMode: 'steer',
        payload: {
          schemaVersion: CURRENT_SCHEMA_VERSION,
          incarnation: session?.incarnation ?? '',
          payload: 'cancel me later',
        },
        principalBacklogLimit: 100,
        sessionBacklogLimitForCrossSessionRead: 100,
        nowMs: Date.now(),
      });
      expect(replay.outcome).toBe('replayed');
      if (replay.outcome === 'replayed') expect(replay.receipt.state).toBe('promoted');
    } finally {
      releaseStepZero.resolve();
      releaseStepOne.resolve();
      await bureau.dispose();
    }
  });
});
