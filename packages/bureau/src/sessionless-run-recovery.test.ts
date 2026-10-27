/**
 * COR-1581 correction — a sessionless durable run recovered after a crash. The first Bureau is not
 * disposed (a graceful shutdown cancels a parked run, so the second would have nothing to recover);
 * a second one opens the same store and takes the run over.
 *
 * - The replay seeds the input row again, outside any checkpointed step, so the row must keep its id
 *   or the claim made under it is made twice, once per row id, and nothing releases the first.
 * - The recovered run's own steps claim what they generate under the run, and the claims are released
 *   when the recovered run ends (COR-1630), so the image falls back to the retention floor.
 */
import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import {
  createAgent,
  createModelCatalog,
  type GenerateContext,
  type GenerateFunction,
  stopWhen,
  waitForCondition,
  withBackendDescriptors,
} from '@lostgradient/operative';
import { yieldToPortableEventLoop } from '@lostgradient/weft';
import { createToolbox } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';
import type { MediaContent } from 'conversationalist';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runRowHolderId } from './assets/row-asset-claims';
import { createBureau } from './create-bureau';
import { createMemoryAssetStorageFixture } from './test/asset-storage-fixtures';
import {
  alice,
  aliceAdministrator,
  base64Of,
  pngBytes,
} from './testing/asset-fixtures.test-support';
import type { Bureau } from './types';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
  await yieldToPortableEventLoop();
});

const anthropicDescriptors = createModelCatalog().descriptors.filter(
  (descriptor) => descriptor.provider === 'anthropic',
);
const imageOutputDescriptors = anthropicDescriptors.slice(0, 1).map((descriptor) => ({
  ...descriptor,
  modalities: {
    ...descriptor.modalities,
    image: { ...descriptor.modalities.image, output: true },
  },
}));
const png = pngBytes(4, 3);

async function holdersOf(bureau: Bureau, assetId: string): Promise<string[]> {
  const descriptor = await bureau.assets!.inspect(assetId, aliceAdministrator, {
    projection: 'privileged',
  });
  if (descriptor.projection !== 'privileged') throw new Error('expected the privileged projection');
  return descriptor.retention.references.map((reference) => reference.holderId);
}

async function createStore() {
  const directory = await mkdtemp(join(tmpdir(), 'bureau-sessionless-recovery-'));
  cleanups.push(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const fixture = createMemoryAssetStorageFixture({});
  cleanups.push(() => fixture.dispose());
  return {
    storage: { type: 'sqlite' as const, path: join(directory, 'bureau') },
    fixture,
    runtime: createManualRuntimeServices({ origin: '2026-10-18T00:00:00.000Z' }),
  };
}

type Store = Awaited<ReturnType<typeof createStore>>;

async function openBureau(
  store: Store,
  agents: NonNullable<Parameters<typeof createBureau>[0]['agents']>,
  extra: Partial<Parameters<typeof createBureau>[0]> = {},
): Promise<Bureau> {
  const bureau = await createBureau({
    agents,
    runtime: store.runtime,
    assets: { storage: store.fixture.storage, policy: { defaultRetentionMilliseconds: 1_000 } },
    storage: store.storage,
    durable: true,
    // A second Bureau may take over the run the first one never released.
    durableOwnership: { ownership: 'none' },
    ...extra,
  });
  cleanups.push(async () => {
    await bureau.dispose();
  });
  return bureau;
}

describe('a sessionless durable run recovered after a crash', () => {
  it('holds its input asset under one run-row holder, not one per replay', async () => {
    const store = await createStore();
    const viewer = (seen: GenerateContext[], hold?: Promise<void>) =>
      createAgent({
        generate: withBackendDescriptors(async (context: GenerateContext) => {
          seen.push(context);
          if (hold !== undefined && context.step === 0) await hold;
          return { content: 'seen', toolCalls: [] };
        }, anthropicDescriptors),
        stopWhen: stopWhen.noToolCalls(),
      });

    const seenFirst: GenerateContext[] = [];
    const first = await openBureau(store, {
      viewer: viewer(seenFirst, new Promise<void>(() => {})),
    });
    const admission = await first.assets!.admit(
      { source: { kind: 'inline', bytes: png }, declaredMediaType: 'image/png' },
      alice,
    );
    await admission.work.result();
    const image: MediaContent = { type: 'image', source: admission.source };
    const assetId = admission.assetId;
    const run = first.run('viewer', [image], { principal: alice.id });
    await waitForCondition(() => seenFirst.length > 0, 'the run never reached its first step');
    const before = await holdersOf(first, assetId);

    const seenSecond: GenerateContext[] = [];
    const resume = Promise.withResolvers<void>();
    const second = await openBureau(store, { viewer: viewer(seenSecond, resume.promise) });
    await waitForCondition(() => seenSecond.length > 0, 'the recovered run never took a step');
    for (let turn = 0; turn < 20; turn += 1) await yieldToPortableEventLoop();
    const during = await holdersOf(second, assetId);

    resume.resolve();
    await waitForCondition(async () => {
      const state = await second.getRun(run.id);
      return state?.status !== 'running';
    }, 'the recovered run never finished');
    await waitForCondition(async () => {
      const holders = await holdersOf(second, assetId);
      return holders.length === 0;
    }, 'the recovered run never released its claim');

    // The replay re-seeded the input row under its own id: one holder, then none once it ends.
    expect(before).toEqual([runRowHolderId(run.id, `${run.id}:input`)]);
    expect(during).toEqual(before);
  });

  it('claims the image its recovered steps generate, and releases it when the recovered run ends', async () => {
    const store = await createStore();
    const generate: GenerateFunction = async (context: GenerateContext) => {
      if (context.step === 0) {
        return {
          content: '',
          toolCalls: [
            {
              id: 'call-1',
              name: 'requestHumanInput',
              arguments: { signalName: 'answer', prompt: 'Which one?' },
            },
          ],
        };
      }
      return {
        content: '',
        parts: [
          {
            type: 'image' as const,
            mimeType: 'image/png',
            source: {
              kind: 'inline' as const,
              data: base64Of(png),
              encoding: 'base64' as const,
            },
          },
        ],
        toolCalls: [],
      };
    };
    const painter = createAgent({
      generate: withBackendDescriptors(generate, imageOutputDescriptors),
      toolbox: createToolbox([]),
      stopWhen: stopWhen.some(stopWhen.toolCalled('requestHumanInput'), stopWhen.noToolCalls()),
    });
    const reviewOf = async (bureau: Bureau, runId: string) => {
      await waitForCondition(
        () => bureau.listPendingReviews().some((review) => review.runId === runId),
        'the run never asked for input',
      );
      return bureau.listPendingReviews().find((candidate) => candidate.runId === runId)!;
    };

    const first = await openBureau(store, { painter });
    const run = first.run('painter', 'Draw', { principal: alice.id });
    await reviewOf(first, run.id);

    const second = await openBureau(store, { painter });
    const claims: Array<{
      type: 'asset.retained' | 'asset.released';
      assetId: string;
      holderId: string;
    }> = [];
    const unsubscribe = second.assets!.subscribe((event) => {
      const { assetId, holderId } = event;
      if (
        (event.type === 'asset.retained' || event.type === 'asset.released') &&
        assetId !== undefined &&
        holderId?.startsWith('run-row:') === true
      ) {
        claims.push({ type: event.type, assetId, holderId });
      }
    });
    cleanups.push(async () => unsubscribe());
    const restored = await reviewOf(second, run.id);
    await second.resolveReview({ id: restored.id, decision: 'approve', principal: 'operator' });
    const finished = await second.waitForDurableRun(run.id);
    expect(finished?.status).toBe('completed');
    const parts = (finished?.result as { parts?: MediaContent[] } | undefined)?.parts ?? [];
    const image = parts.find((part) => part.type === 'image');
    if (image === undefined || image.source.kind !== 'managed-asset') {
      throw new Error('the recovered run generated no managed image');
    }
    const assetId = image.source.assetId;

    await waitForCondition(async () => {
      const holders = await holdersOf(second, assetId);
      return holders.length === 0;
    }, 'the recovered run never released its claim');
    // The commit claimed the image under the run, and the run's end released that same claim.
    const holder = expect.stringContaining(`run-row:${encodeURIComponent(run.id)}:`);
    expect(claims.filter((event) => event.assetId === assetId)).toEqual([
      { type: 'asset.retained', assetId, holderId: holder },
      { type: 'asset.released', assetId, holderId: holder },
    ]);

    await store.runtime.advance(5_000);
    const collected = await second.assets!.collectGarbage().result();
    if (collected.outcome !== 'completed') throw new Error(`collection ${collected.outcome}`);
    expect(collected.value.expired).toContain(assetId);
  });
});
