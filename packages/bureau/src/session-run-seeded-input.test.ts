/**
 * COR-1581 correction — a run with a session does not claim its input row at seed time. The
 * session's own commit queues an outbox entry that claims the same row under the same holder, and
 * the drain retries a transient failure without touching the run. A claim made at seed time would
 * end a chat turn with an uploaded image before its first step, where the drain would have retried.
 */
import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import {
  createAgent,
  createModelCatalog,
  stopWhen,
  withBackendDescriptors,
} from '@lostgradient/operative';
import { waitForTaskState } from './test';
import { yieldToPortableEventLoop } from '@lostgradient/weft';
import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { appendMessages, createConversationHistory, type Message } from 'conversationalist';

import { createBureau } from './create-bureau';
import { createMemoryAssetStorageFixture } from './test/asset-storage-fixtures';
import { alice, aliceAdministrator, pngBytes } from './testing/asset-fixtures.test-support';
import { MemoryStorage } from '@lostgradient/storage';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
  // load-proof: the work this lets finish runs on in-memory storage and doubles and settles through promise continuations only, so a microtask drain completes it (checked by replacing the turn with one); no timer or I/O is pending
  await yieldToPortableEventLoop();
});

const echo = createAgent({
  generate: withBackendDescriptors(
    async () => ({ content: 'ok', toolCalls: [] }),
    createModelCatalog().descriptors.filter((descriptor) => descriptor.provider === 'anthropic'),
  ),
  stopWhen: stopWhen.noToolCalls(),
});

function rowReferencing(assetId: string): Message[] {
  const history = appendMessages(createConversationHistory({ id: 'scratch' }), {
    id: 'input-row',
    role: 'user',
    content: [
      { type: 'text', text: 'Look' },
      { type: 'image', mimeType: 'image/png', source: { kind: 'managed-asset', assetId } },
    ],
  });
  return history.ids.map((id) => history.messages[id]!);
}

describe.each([
  ['in-process', {}],
  ['durable', { storage: new MemoryStorage(), durable: true }],
] as const)('a session run with a managed-asset input (%s)', (_name, extra) => {
  it('completes when a retention claim fails transiently, and the drain claims the row later', async () => {
    const runtime = createManualRuntimeServices({ origin: '2026-10-18T00:00:00.000Z' });
    const fixture = createMemoryAssetStorageFixture({});
    cleanups.push(() => fixture.dispose());
    const bureau = await createBureau({
      agents: { echo },
      ...(Object.keys(extra).length === 0 ? { storage: new MemoryStorage(), durable: false } : {}),
      runtime,
      assets: { storage: fixture.storage, policy: { defaultRetentionMilliseconds: 1_000 } },
      ...extra,
    });
    cleanups.push(async () => {
      await bureau.dispose();
    });
    const admission = await bureau.assets!.admit(
      { source: { kind: 'inline', bytes: pngBytes(4, 3) }, declaredMediaType: 'image/png' },
      alice,
    );
    await admission.work.result();
    const retain = bureau.assets!.retain.bind(bureau.assets);
    let failing = true;
    spyOn(bureau.assets!, 'retain').mockImplementation(async (...args) => {
      if (failing && args[0] === admission.assetId)
        throw new Error('retention briefly unavailable');
      return retain(...args);
    });

    const created = await bureau.tasks.start(
      'echo',
      { append: rowReferencing(admission.assetId) },
      { contextId: 'chat', principal: alice.id },
    );
    const state = await waitForTaskState(bureau, created.id);
    // load-proof: the work these turns let finish runs on in-memory storage and doubles and settles through promise continuations only, so a microtask drain completes it (checked by replacing the turns with one); no timer or I/O is pending
    for (let turn = 0; turn < 20; turn += 1) await yieldToPortableEventLoop();

    // The run took its step; only the drain's claim failed, and it left its entry pending.
    expect(state.status).toBe('completed');
    expect(state.steps).toBe(1);
    const entries = await bureau.internals.sessionStore!.outbox.pending();
    expect(entries.some((entry) => entry.sessionId === 'chat')).toBe(true);

    failing = false;
    const other = await bureau.tasks.start('echo', 'Hello', {
      contextId: 'other',
      principal: alice.id,
    });
    await waitForTaskState(bureau, other.id);
    // load-proof: the work these turns let finish runs on in-memory storage and doubles and settles through promise continuations only, so a microtask drain completes it (checked by replacing the turns with one); no timer or I/O is pending
    for (let turn = 0; turn < 20; turn += 1) await yieldToPortableEventLoop();

    const descriptor = await bureau.assets!.inspect(admission.assetId, aliceAdministrator, {
      projection: 'privileged',
    });
    if (descriptor.projection !== 'privileged')
      throw new Error('expected the privileged projection');
    expect(descriptor.retention.references.map((reference) => reference.holderId)).toEqual([
      expect.stringContaining('session-row:chat:'),
    ]);
  });
});
