/**
 * COR-713 — a generated asset a persisted row references is kept for as long as the row exists. The
 * asset policy's retention floor would otherwise expire it while the session's rows still point at
 * it, and a later replay would fail to resolve it.
 */
import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { createAgent, createModelCatalog, withBackendDescriptors } from '@lostgradient/operative';
import { MemoryStorage, textValueStore, yieldToPortableEventLoop } from '@lostgradient/weft';
import { afterEach, describe, expect, it } from 'bun:test';

import { createBureau } from './create-bureau';
import { createMemoryAssetStorageFixture } from './test/asset-storage-fixtures';
import { alice, base64Of, pngBytes } from './testing/asset-fixtures.test-support';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
  await yieldToPortableEventLoop();
});

const descriptors = createModelCatalog()
  .descriptors.filter((descriptor) => descriptor.provider === 'anthropic')
  .slice(0, 1)
  .map((descriptor) => ({
    ...descriptor,
    modalities: {
      ...descriptor.modalities,
      image: { ...descriptor.modalities.image, output: true },
    },
  }));

const png = pngBytes(4, 3);
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
    descriptors,
  ),
});

async function openBureau() {
  const runtime = createManualRuntimeServices({ origin: '2026-10-18T00:00:00.000Z' });
  const fixture = createMemoryAssetStorageFixture({});
  cleanups.push(() => fixture.dispose());
  const bureau = await createBureau({
    agents: { painter },
    persistence: textValueStore(new MemoryStorage()),
    runtime,
    assets: { storage: fixture.storage, policy: { defaultRetentionMilliseconds: 1_000 } },
  });
  cleanups.push(async () => {
    await bureau.dispose();
  });
  return { bureau, runtime };
}

async function collect(bureau: Awaited<ReturnType<typeof openBureau>>['bureau']) {
  const result = await bureau.assets!.collectGarbage().result();
  if (result.outcome !== 'completed') throw new Error(`collection failed: ${result.outcome}`);
  return result.value;
}

describe('a generated image a session row references', () => {
  it('survives collection past the retention floor, and is released when the session is deleted', async () => {
    const { bureau, runtime } = await openBureau();
    const created = await bureau.createRun({
      message: 'Draw',
      agentName: 'painter',
      principal: alice.id,
    });
    for (let turn = 0; turn < 200 && bureau.getRun(created.id)?.status === 'running'; turn += 1) {
      await yieldToPortableEventLoop();
    }
    const session = await bureau.getSession(created.sessionId);
    const row = Object.values(session!.conversationHistory.messages).find(
      (message) => message.role === 'assistant',
    );
    const image = (
      row!.content as unknown as Array<{ type: string; source: { assetId: string } }>
    ).find((part) => part.type === 'image')!;
    const { assetId } = image.source;
    const source = { kind: 'managed-asset' as const, assetId };

    await runtime.advance(5_000);
    const report = await collect(bureau);

    expect(report.expired).not.toContain(assetId);
    const resolved = await bureau.assets!.resolve(source, alice);
    expect(resolved.content).toEqual({ kind: 'bytes', bytes: png });

    await bureau.deleteSession(created.sessionId);
    const afterDelete = await collect(bureau);

    expect(afterDelete.expired).toContain(assetId);
  });

  it('is still expired by the floor when no row ever referenced it', async () => {
    const { bureau, runtime } = await openBureau();
    const admission = await bureau.assets!.admit({ source: { kind: 'inline', bytes: png } }, alice);
    await admission.work.result();

    await runtime.advance(5_000);
    const report = await collect(bureau);

    expect(report.expired).toContain(admission.assetId);
  });
});
