/**
 * COR-2387 — a live durable session run (one that has not restarted) hands its taint sink to the
 * durable child wait, so a non-guardrail `validateToolResult` handler that throws on the child's
 * answer still taints the session.
 */
import { HookRegistry } from '@lostgradient/lifecycle';
import {
  createAgent,
  readSessionTaint,
  stopWhen,
  type OperativeHookMap,
} from '@lostgradient/operative';
import { MemoryStorage } from '@lostgradient/storage';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { createTool, createToolbox } from 'armorer';
import { expect, it } from 'bun:test';
import { z } from 'zod';

import { createBureau } from './create-bureau';

it('taints the session when a handler throws on a durable child wait’s answer', async () => {
  const childRelease = Promise.withResolvers<void>();
  const parentReady = Promise.withResolvers<void>();
  const allowParentTool = Promise.withResolvers<void>();
  const waitForChild = createTool({
    name: 'wait-for-child',
    description: 'Wait for the named child run to settle.',
    input: z.object({ childRunId: z.string() }),
    metadata: { durableChildWait: true },
    execute: async ({ childRunId }, context) => {
      const durableChildWait = context.executionContext?.['durableChildWait'];
      if (typeof durableChildWait !== 'function') throw new Error('not injected');
      return durableChildWait({
        childRunId,
        toolCallId: context.meta?.callId ?? context.toolCall.id,
      });
    },
  });
  const hooks = new HookRegistry<OperativeHookMap>();
  hooks.on('validateToolResult', async () => {
    throw new Error('handler crashed');
  });
  const bureau = await createBureau({
    agents: {
      planner: createAgent({
        name: 'planner',
        toolbox: createToolbox([waitForChild]),
        hooks,
        generate: async ({ step }) => {
          if (step === 0) {
            parentReady.resolve();
            await allowParentTool.promise;
            return {
              content: 'waiting',
              toolCalls: [{ name: 'wait-for-child', arguments: { childRunId: 'child-1' } }],
            };
          }
          return { content: 'done', toolCalls: [] };
        },
        stopWhen: stopWhen.noToolCalls(),
      }),
      worker: createAgent({
        name: 'worker',
        generate: async () => {
          await childRelease.promise;
          return { content: 'child answer', toolCalls: [] };
        },
        stopWhen: stopWhen.noToolCalls(),
      }),
    },
    storage: new MemoryStorage(),
    durable: true,
    durableOwnership: { ownership: 'workflow-lease' },
  });
  try {
    const parent = await bureau.tasks.start('planner', 'wait for work');
    await parentReady.promise;
    await bureau.children.dispatch({
      parentRunId: parent.id,
      childRunId: 'child-1',
      agentName: 'worker',
      input: 'work',
    });
    allowParentTool.resolve();
    await waitUntil(async () => (await bureau.tasks.workflow(parent.id))?.status === 'running', {
      message: 'parent parks',
    });
    childRelease.resolve();
    await parent.result();
    const session = await bureau.internals.sessionStore?.load(parent.contextId);
    expect(readSessionTaint(session?.metadata)).toMatchObject({ category: 'detector-failure' });
  } finally {
    await bureau.dispose();
  }
});
