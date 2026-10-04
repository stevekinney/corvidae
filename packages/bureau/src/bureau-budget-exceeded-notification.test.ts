/**
 * COR-1419 — a live run-frame subscriber hears when a run ends because it
 * exceeded a budget.
 *
 * The notification is derived from Operative's terminal result, and Bureau
 * decides when a run's frame forwarder stops listening. A test that hands
 * `createRunFrameForwarder` a bare `ActiveRun` cannot see that decision, so
 * these tests drive the whole Bureau lifecycle and read the frames a
 * `subscribeLiveFrames` listener receives, for both run drivers.
 */
import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { BudgetExceededError, type GenerateFunction, type RunFrame } from '@lostgradient/operative';
import { createTool, createToolbox, type Tool } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createBureau } from './create-bureau';
import { waitForRunState } from './test';
import type { BureauOptions } from './types';

const ORIGIN = '2026-10-03T00:00:00.000Z';

type NotificationFrame = Extract<RunFrame, { type: 'notification' }>;

const noopTool = createTool({
  name: 'noop',
  description: 'does nothing',
  input: z.object({}),
  execute: async () => ({}),
});

/** Step 0 calls a tool, so the failing step is 1 and the frame's step is not a default of 0. */
function generateThenFail(failure: unknown): GenerateFunction {
  return async ({ step }) =>
    step === 0
      ? { content: '', toolCalls: [{ name: 'noop', arguments: {} }] }
      : Promise.reject(failure);
}

const generateDone: GenerateFunction = async () => ({ content: 'Done.', toolCalls: [] });

const drivers: Array<{
  name: string;
  options: Pick<BureauOptions, 'storage' | 'durableExecution'>;
}> = [
  { name: 'in-memory driver', options: {} },
  { name: 'durable driver', options: { storage: { type: 'memory' }, durableExecution: true } },
];

async function collectRunFrames(
  generate: GenerateFunction,
  driverOptions: Pick<BureauOptions, 'storage' | 'durableExecution'>,
): Promise<{ frames: RunFrame[]; finishReason: string | undefined }> {
  const bureau = await createBureau({
    agents: {},
    generate,
    toolbox: createToolbox<readonly Tool[]>([noopTool]),
    runtime: createManualRuntimeServices({ origin: ORIGIN }),
    ...driverOptions,
  });
  try {
    const frames: RunFrame[] = [];
    const unsubscribe = bureau.subscribeLiveFrames((frame) => {
      if (frame.type === 'run-envelope') frames.push(frame.frame);
    });
    const summary = await bureau.createRun({ message: 'Go.' });
    const settled = await waitForRunState(bureau, summary.id);
    unsubscribe();
    return { frames, finishReason: settled.finishReason };
  } finally {
    await bureau.dispose();
  }
}

function budgetNotifications(frames: readonly RunFrame[]): NotificationFrame[] {
  return frames.filter(
    (frame): frame is NotificationFrame =>
      frame.type === 'notification' && frame.code === 'budget.exceeded',
  );
}

describe.each(drivers)('a Bureau run on the $name', ({ options }) => {
  it('announces one budget-exceeded notification immediately before run-finished', async () => {
    const { frames, finishReason } = await collectRunFrames(
      generateThenFail(new BudgetExceededError('token limit reached')),
      options,
    );

    expect(finishReason).toBe('budget-exceeded');
    const notifications = budgetNotifications(frames);
    expect(notifications).toHaveLength(1);
    const notification = notifications[0]!;
    expect(notification.level).toBe('error');
    expect(notification.code).toBe('budget.exceeded');
    expect(notification.message).toBe('Budget exceeded');
    expect(notification.step).toBe(1);
    expect(notification.timestamp).toBe(Date.parse(ORIGIN));
    expect(frames[frames.indexOf(notification) + 1]?.type).toBe('run-finished');
    expect(frames.filter((frame) => frame.type === 'run-finished')).toHaveLength(1);
  });

  it('announces no budget notification for a run that finishes within budget', async () => {
    const { frames, finishReason } = await collectRunFrames(generateDone, options);

    expect(finishReason).not.toBe('budget-exceeded');
    expect(budgetNotifications(frames)).toEqual([]);
    expect(frames.at(-1)?.type).toBe('run-finished');
  });

  it('announces no budget notification for a run that fails for another reason', async () => {
    const { frames, finishReason } = await collectRunFrames(
      generateThenFail(new Error('provider unavailable')),
      options,
    );

    expect(finishReason).toBe('error');
    expect(budgetNotifications(frames)).toEqual([]);
    expect(frames.at(-1)?.type).toBe('run-finished');
  });
});
