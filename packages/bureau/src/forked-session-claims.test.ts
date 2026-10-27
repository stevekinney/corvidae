/**
 * COR-1581 — a forked session keeps its source's owner, so its rows are claimed as that owner and
 * deleting the original session leaves the fork able to resolve the assets they reference.
 */
import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import {
  createAgent,
  createModelCatalog,
  createSessionHandle,
  SESSION_OWNER_METADATA_KEY,
  stopWhen,
  withBackendDescriptors,
} from '@lostgradient/operative';
import { waitForTaskState } from './test';
import { yieldToPortableEventLoop } from '@lostgradient/weft';
import { afterEach, describe, expect, it } from 'bun:test';

import { createBureau } from './create-bureau';
import { createMemoryAssetStorageFixture } from './test/asset-storage-fixtures';
import { alice, base64Of, pngBytes } from './testing/asset-fixtures.test-support';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
  await yieldToPortableEventLoop();
});

const FLOOR_MILLISECONDS = 1_000;
const PAST_THE_FLOOR = 5_000;
const png = pngBytes(4, 3);

const imageOutputDescriptors = createModelCatalog()
  .descriptors.filter((descriptor) => descriptor.provider === 'anthropic')
  .slice(0, 1)
  .map((descriptor) => ({
    ...descriptor,
    modalities: {
      ...descriptor.modalities,
      image: { ...descriptor.modalities.image, output: true },
    },
  }));

const painter = createAgent({
  generate: withBackendDescriptors(
    async () => ({
      content: '',
      parts: [
        {
          type: 'image' as const,
          mimeType: 'image/png',
          source: { kind: 'inline' as const, data: base64Of(png), encoding: 'base64' as const },
        },
      ],
      toolCalls: [],
    }),
    imageOutputDescriptors,
  ),
  stopWhen: stopWhen.noToolCalls(),
});

async function openBureau() {
  const runtime = createManualRuntimeServices({ origin: '2026-10-18T00:00:00.000Z' });
  const fixture = createMemoryAssetStorageFixture({});
  cleanups.push(() => fixture.dispose());
  const bureau = await createBureau({
    agents: { painter },
    storage: { type: 'memory' },
    durable: false,
    runtime,
    assets: {
      storage: fixture.storage,
      policy: { defaultRetentionMilliseconds: FLOOR_MILLISECONDS },
    },
  });
  cleanups.push(async () => {
    await bureau.dispose();
  });
  return { bureau, runtime };
}

type PaintingBureau = Awaited<ReturnType<typeof openBureau>>['bureau'];

async function paint(bureau: PaintingBureau, sessionId: string) {
  const created = await bureau.createRun({
    message: 'Draw',
    agentName: 'painter',
    principal: alice.id,
    sessionId,
  });
  await waitForTaskState(bureau, created.id);
  for (let turn = 0; turn < 20; turn += 1) await yieldToPortableEventLoop();
}

async function assetsOf(bureau: PaintingBureau, sessionId: string): Promise<string[]> {
  const session = await bureau.contexts.get(sessionId);
  const history = session!.conversationHistory;
  return history.ids.flatMap((id) => {
    const content = history.messages[id]!.content;
    if (typeof content === 'string') return [];
    return content.flatMap((part) =>
      'source' in part && part.source.kind === 'managed-asset' ? [part.source.assetId] : [],
    );
  });
}

describe('a forked session', () => {
  it('keeps the asset its rows reference after the original session is deleted', async () => {
    const { bureau, runtime } = await openBureau();
    await paint(bureau, 'original');
    const [assetId] = await assetsOf(bureau, 'original');
    const source = await bureau.contexts.get('original');
    expect(source!.metadata[SESSION_OWNER_METADATA_KEY]).toBe(alice.id);

    const handle = createSessionHandle('original', {
      store: bureau.internals.sessionStore!,
      agentName: 'painter',
    });
    const forked = await handle.fork();
    for (let turn = 0; turn < 20; turn += 1) await yieldToPortableEventLoop();
    const fork = await bureau.contexts.get(forked.id);
    expect(fork!.metadata).toEqual({ [SESSION_OWNER_METADATA_KEY]: alice.id });
    expect(await assetsOf(bureau, forked.id)).toEqual([assetId!]);

    await bureau.contexts.delete('original');
    await runtime.advance(PAST_THE_FLOOR);
    const collected = await bureau.assets!.collectGarbage().result();

    expect(collected.outcome === 'completed' && collected.value.expired).not.toContain(assetId);
    const resolved = await bureau.assets!.resolve(
      { kind: 'managed-asset', assetId: assetId! },
      alice,
    );
    expect(resolved.descriptor.state).toBe('available');
  });
});
