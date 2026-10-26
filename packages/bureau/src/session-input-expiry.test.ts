import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import {
  createAgent,
  type GenerateContext,
  type GenerateFunction,
  stopWhen,
} from '@lostgradient/operative';
import { createTool, createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import type { Conversation } from 'conversationalist';
import { z } from 'zod';

import type { AgentDefinitions } from './agent-catalog';
import { createBureau } from './create-bureau';
import { deferred } from './test/session-input-fixtures';

/**
 * COR-1661 — a queued input's `expiresAt` is honored: an input still waiting for a step boundary
 * when its instant passes is not delivered, and its receipt reads `expired`.
 */

const nextTool = createTool({
  name: 'next',
  description: 'continue',
  input: z.object({}),
  execute: async () => 'ok',
});

const ORIGIN = '2026-10-22T00:00:00.000Z';

function userTexts(conversation: Conversation): string[] {
  return conversation
    .getMessages()
    .filter((message) => message.role === 'user')
    .map((message) => (typeof message.content === 'string' ? message.content : ''));
}

async function open(generate: GenerateFunction) {
  const runtime = createManualRuntimeServices({ origin: ORIGIN });
  const bureau = await createBureau<AgentDefinitions>({
    agents: {
      default: createAgent({
        generate,
        toolbox: createToolbox([nextTool]),
        stopWhen: stopWhen.noToolCalls(),
      }),
    },
    runtime,
    storage: { type: 'memory' },
    durableExecution: true,
  });
  return { bureau, runtime };
}

const queued = { principal: 'alice', deliveryMode: 'queue' as const };

describe('a queued input’s expiresAt', () => {
  it('is not delivered at a step boundary after it, while input without one is', async () => {
    const stepZeroStarted = deferred();
    const releaseStepZero = deferred();
    const stepOneStarted = deferred();
    const prompts: string[][] = [];
    const { bureau, runtime } = await open(async (context: GenerateContext) => {
      prompts[context.step] = userTexts(context.conversation);
      if (context.step === 0) {
        stepZeroStarted.resolve();
        await releaseStepZero.promise;
        return { content: 'working', toolCalls: [{ name: 'next', arguments: {} }] };
      }
      stepOneStarted.resolve();
      return { content: 'done', toolCalls: [] };
    });
    try {
      const run = await bureau.createRun({
        agentName: 'default',
        message: 'Start',
        principal: 'alice',
      });
      await stepZeroStarted.promise;
      const expiresAt = new Date(runtime.clock.now() + 1_000).toISOString();
      await bureau.submitSessionInput(run.sessionId, {
        ...queued,
        id: 'input-late',
        payload: 'late',
        expiresAt,
      });
      await bureau.submitSessionInput(run.sessionId, {
        ...queued,
        id: 'input-open',
        payload: 'no deadline',
      });

      runtime.setTime(Date.parse(ORIGIN) + 5_000);
      releaseStepZero.resolve();
      await stepOneStarted.promise;

      expect(prompts[1]).toEqual(['Start', 'no deadline']);
      const replay = await bureau.submitSessionInput(run.sessionId, {
        ...queued,
        id: 'input-late',
        payload: 'late',
        expiresAt,
      });
      expect(replay.outcome).toBe('replayed');
      if (replay.outcome === 'replayed') expect(replay.receipt.state).toBe('expired');
    } finally {
      releaseStepZero.resolve();
      await bureau.dispose();
    }
  });

  it('is never delivered when its instant had passed on admission', async () => {
    const stepZeroStarted = deferred();
    const releaseStepZero = deferred();
    const stepOneStarted = deferred();
    const prompts: string[][] = [];
    const { bureau, runtime } = await open(async (context: GenerateContext) => {
      prompts[context.step] = userTexts(context.conversation);
      if (context.step === 0) {
        stepZeroStarted.resolve();
        await releaseStepZero.promise;
        return { content: 'working', toolCalls: [{ name: 'next', arguments: {} }] };
      }
      stepOneStarted.resolve();
      return { content: 'done', toolCalls: [] };
    });
    try {
      const run = await bureau.createRun({
        agentName: 'default',
        message: 'Start',
        principal: 'alice',
      });
      await stepZeroStarted.promise;
      await bureau.submitSessionInput(run.sessionId, {
        ...queued,
        id: 'input-past',
        payload: 'past',
        expiresAt: '2000-01-01T00:00:00.000Z',
      });

      runtime.setTime(Date.parse(ORIGIN) + 1_000);
      releaseStepZero.resolve();
      await stepOneStarted.promise;

      expect(prompts[1]).toEqual(['Start']);
    } finally {
      releaseStepZero.resolve();
      await bureau.dispose();
    }
  });

  it('is admitted whatever its distance: a year or more out is clamped to the mailbox’s cap, not refused', async () => {
    const stepZeroStarted = deferred();
    const releaseStepZero = deferred();
    const { bureau, runtime } = await open(async () => {
      stepZeroStarted.resolve();
      await releaseStepZero.promise;
      return { content: 'done', toolCalls: [] };
    });
    try {
      const run = await bureau.createRun({
        agentName: 'default',
        message: 'Start',
        principal: 'alice',
      });
      await stepZeroStarted.promise;
      const year = 365 * 86_400_000;

      const outcomes = await Promise.all(
        [
          '2028-12-01T00:00:00.000Z',
          new Date(runtime.clock.now() + year).toISOString(),
          new Date(runtime.clock.now() + year + 1).toISOString(),
          '9999-12-31T23:59:59.999Z',
        ].map((expiresAt, index) =>
          bureau.submitSessionInput(run.sessionId, {
            ...queued,
            id: `input-far-${index}`,
            payload: `far ${index}`,
            expiresAt,
          }),
        ),
      );

      expect(outcomes.map((outcome) => outcome.outcome)).toEqual([
        'admitted',
        'admitted',
        'admitted',
        'admitted',
      ]);
      for (const outcome of outcomes) {
        if (outcome.outcome === 'admitted') expect(outcome.receipt.state).toBe('queued');
      }
    } finally {
      releaseStepZero.resolve();
      await bureau.dispose();
    }
  });

  it('is refused when it is not an ISO 8601 instant', async () => {
    const stepZeroStarted = deferred();
    const releaseStepZero = deferred();
    const { bureau } = await open(async () => {
      stepZeroStarted.resolve();
      await releaseStepZero.promise;
      return { content: 'done', toolCalls: [] };
    });
    try {
      const run = await bureau.createRun({
        agentName: 'default',
        message: 'Start',
        principal: 'alice',
      });
      await stepZeroStarted.promise;

      const refusal = await bureau
        .submitSessionInput(run.sessionId, {
          ...queued,
          id: 'input-bad',
          payload: 'bad',
          expiresAt: 'tomorrow',
        })
        .catch((error: unknown) => error);

      expect(refusal).toMatchObject({ code: 'BAD_REQUEST' });
    } finally {
      releaseStepZero.resolve();
      await bureau.dispose();
    }
  });
});
