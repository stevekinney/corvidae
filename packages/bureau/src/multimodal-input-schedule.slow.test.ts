/**
 * COR-716 — a scheduled fire carries a media input end to end. The schedule's tick
 * runs on the engine's real clock, so this sits in the slow lane.
 */
import {
  createModelCatalog,
  type GenerateContext,
  stopWhen,
  withBackendDescriptors,
  createAgent,
} from '@lostgradient/operative';
import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';

import { createBureau } from './create-bureau';
import { createMemoryAssetStorageFixture } from './test/asset-storage-fixtures';
import { alice, base64Of, pngBytes } from './testing/asset-fixtures.test-support';
import type { AgentDefinitions } from './agent-catalog';

// The poll ends inside Bun's default per-test limit, which this file leaves as it is: a
// 1 s schedule fires well within it, and a fire that does not is a failure, not a slow test.
const FIRE_WAIT_MS = 4_000;

async function waitForReal(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return condition();
}

describe('a scheduled fire with a media input (COR-716)', () => {
  it('seeds the fire with the parts as one user message and resolves its managed asset as the schedule owner', async () => {
    const seen: GenerateContext[] = [];
    const fixture = createMemoryAssetStorageFixture({});
    const bureau = await createBureau<AgentDefinitions>({
      agents: {
        default: createAgent({
          generate: withBackendDescriptors(
            async (context: GenerateContext) => {
              seen.push(context);
              return { content: 'ok', toolCalls: [] };
            },
            createModelCatalog().descriptors.filter(
              (descriptor) => descriptor.provider === 'anthropic',
            ),
          ),
          toolbox: createToolbox([]),
          stopWhen: stopWhen.noToolCalls(),
        }),
      },
      storage: { type: 'memory' },
      durableExecution: true,
      assets: { storage: fixture.storage },
    });
    try {
      const bytes = pngBytes(4, 3);
      const admission = await bureau.assets!.admit(
        { source: { kind: 'inline', bytes }, declaredMediaType: 'image/png' },
        alice,
      );
      await admission.work.result();
      const input = [
        { type: 'text', text: 'what changed overnight?' },
        { type: 'image', source: admission.source },
      ] as const;

      const summary = await bureau.createSchedule({
        agentName: 'default',
        input,
        spec: '1s',
        principal: alice.id,
      });
      expect(summary).toBeDefined();

      const fired = await waitForReal(() => seen.length >= 1, FIRE_WAIT_MS);
      await bureau.cancelSchedule(summary!.id);

      expect(fired).toBe(true);
      const context = seen[0]!;
      const user = context.conversation.getMessages().find((message) => message.role === 'user');
      expect(user?.content).toEqual(input);
      expect([...(context.resolvedSources ?? [])]).toEqual([
        [
          `${user!.id}:1`,
          expect.objectContaining({
            outcome: 'resolved',
            source: { kind: 'inline', data: base64Of(bytes), encoding: 'base64' },
          }),
        ],
      ]);
    } finally {
      await bureau.dispose();
      await fixture.dispose();
    }
  });

  it('refuses a schedule whose input no fire could read, at registration', async () => {
    const bureau = await createBureau<AgentDefinitions>({
      agents: {
        default: createAgent({
          generate: async () => ({ content: 'ok', toolCalls: [] }),
          toolbox: createToolbox([]),
        }),
      },
      storage: { type: 'memory' },
      durableExecution: true,
    });
    try {
      let thrown: unknown;
      try {
        await bureau.createSchedule({
          agentName: 'default',
          input: [] as never,
          spec: '1s',
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({ code: 'BAD_REQUEST' });
    } finally {
      await bureau.dispose();
    }
  });
});
