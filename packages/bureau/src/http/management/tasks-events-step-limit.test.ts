/**
 * COR-1627: the `bureau.tasks.events` stream of a task whose run stopped at its step limit ends
 * on a failed status that still reads `maximum-steps`. The stream ends on the run's `run.error`,
 * which carries the finish reason the run ends with, because a `run.error` alone also ends it.
 */
import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { stopWhen, createAgent } from '@lostgradient/operative';
import { createTool, createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createMemoryAssetStorage } from '../../assets/storage';
import { createBureau } from '../../create-bureau.ts';
import { waitForCondition } from '../../test';
import { createSqliteStorageFixture } from '../../test/storage-fixtures';
import { createBureauHandler } from '../create-bureau-handler.ts';
import {
  authentication,
  OWNER,
  readFrames,
  subscribeRequest,
} from './management-fixtures.test-support.ts';
import type { AgentDefinitions } from '../../agent-catalog';

const nextTool = createTool({
  name: 'next',
  description: 'Asks for one more step',
  input: z.object({}),
  execute: async () => 'ok',
});

describe.each([
  ['without an answer', undefined],
  ['with an onMaximumSteps answer', async () => 'Out of steps.'],
] as const)('bureau.tasks.events of a run that hits its step limit, %s', (_name, answer) => {
  it('ends on a failed status that reads maximum-steps', async () => {
    const runtime = createManualRuntimeServices({ origin: '2026-10-18T00:00:00.000Z' });
    const fixture = createSqliteStorageFixture({ runtime });
    const bureau = await createBureau<AgentDefinitions>({
      assets: { storage: createMemoryAssetStorage() },
      id: 'step-limit-events-bureau',
      agents: {
        default: createAgent({
          generate: async () => ({
            content: 'still going',
            toolCalls: [{ name: 'next', arguments: {} }],
          }),
          stopWhen: stopWhen.noToolCalls(),
          toolbox: createToolbox([nextTool]),
          maximumSteps: 2,
        }),
      },
      ...(answer === undefined ? {} : { onMaximumSteps: answer }),
      runtime,
      storage: fixture.configuration,
      durable: true,
      durableOwnership: { ownership: 'none' },
      maintenance: 'manual',
    });
    try {
      const handler = createBureauHandler(bureau, { authentication });
      const run = await bureau.tasks.start('default', 'Never settles', { principal: OWNER.alice });
      await waitForCondition(
        () => bureau.tasks.detail(run.id)?.status === 'error',
        'the run never failed',
      );
      await runtime.deferred.drain();

      const frames = await readFrames(
        await handler(subscribeRequest('bureau.tasks.events', { taskId: run.id }, 'alice-key')),
      );

      expect(frames.map((frame) => frame.event)).toEqual(['task.snapshot', 'task.status']);
      expect(frames.at(-1)?.data).toMatchObject({
        taskId: run.id,
        status: 'failed',
        finishReason: 'maximum-steps',
        message: expect.stringContaining('exceeded maximumSteps (2)') as unknown,
      });
    } finally {
      await bureau.dispose();
      await fixture.dispose();
    }
  });
});
