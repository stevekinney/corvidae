/**
 * COR-1581 correction — a durable task recovered after a crash. The first Bureau is not disposed
 * (a graceful shutdown cancels a parked run, so the second would have nothing to recover); a second
 * one opens the same store and takes the run over.
 *
 * The replay seeds the input row again, outside any checkpointed step, so the row must keep its id
 * or the claim made under it is made twice, once per row id, and nothing releases the first.
 */
import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import {
  createAgent,
  createModelCatalog,
  type GenerateContext,
  stopWhen,
  waitForCondition,
  withBackendDescriptors,
} from '@lostgradient/operative';
import { yieldToPortableEventLoop } from '@lostgradient/weft';
import { afterEach, describe, expect, it } from 'bun:test';
import type { MediaContent } from 'conversationalist';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createBureau } from './create-bureau';
import { createMemoryAssetStorageFixture } from './test/asset-storage-fixtures';
import { alice, aliceAdministrator, pngBytes } from './testing/asset-fixtures.test-support';
import type { Bureau } from './types';
import { createSqliteStorageFixture } from './test/storage-fixtures';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
  // load-proof: the work this lets finish runs on in-memory storage and doubles and settles through promise continuations only, so a microtask drain completes it (checked by replacing the turn with one); no timer or I/O is pending
  await yieldToPortableEventLoop();
});

const anthropicDescriptors = createModelCatalog().descriptors.filter(
  (descriptor) => descriptor.provider === 'anthropic',
);
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
  // Each Bureau on this store opens its own handle; the fixture closes them after the Bureaus.
  const database = createSqliteStorageFixture({ path: join(directory, 'bureau') });
  cleanups.push(() => database.dispose());
  return {
    database,
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
    storage: store.database.open(),
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

describe('a durable task recovered after a crash', () => {
  it('holds its input asset under one context-row holder, not one per replay', async () => {
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
    const run = await first.tasks.start('viewer', [image], { principal: alice.id });
    await waitForCondition(() => seenFirst.length > 0, 'the run never reached its first step');
    const before = await holdersOf(first, assetId);

    const seenSecond: GenerateContext[] = [];
    const resume = Promise.withResolvers<void>();
    const second = await openBureau(store, { viewer: viewer(seenSecond, resume.promise) });
    await waitForCondition(() => seenSecond.length > 0, 'the recovered run never took a step');
    // load-proof: the work these turns let finish runs on in-memory storage and doubles and settles through promise continuations only, so a microtask drain completes it (checked by replacing the turns with one); no timer or I/O is pending
    for (let turn = 0; turn < 20; turn += 1) await yieldToPortableEventLoop();
    const during = await holdersOf(second, assetId);

    resume.resolve();
    await waitForCondition(async () => {
      const state = await second.tasks.detail(run.id);
      return state?.status !== 'running';
    }, 'the recovered run never finished');
    const after = await holdersOf(second, assetId);

    // The replay re-seeded the input row under its own id: one holder, held by the task's
    // context, throughout and after the replay.
    expect(before).toEqual([expect.stringContaining(`session-row:${run.contextId}:`)]);
    expect(during).toEqual(before);
    expect(after).toEqual(before);
  });
});
