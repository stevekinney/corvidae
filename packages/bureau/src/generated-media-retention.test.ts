/**
 * COR-713 — an asset a persisted row references is kept for as long as the session that holds the
 * row exists. The asset policy's retention floor would otherwise expire it while the session's
 * rows still point at it, and a later replay would fail to resolve it. The claim is keyed by
 * session and row, so a row copied into another session is claimed there too.
 */
import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import {
  createAgent,
  createAgentSession,
  createModelCatalog,
  SESSION_OWNER_METADATA_KEY,
  waitForRunState,
  withBackendDescriptors,
} from '@lostgradient/operative';
import { yieldToPortableEventLoop } from '@lostgradient/weft';
import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import {
  appendMessages,
  createConversationHistory,
  type Message,
  type MessageInput,
} from 'conversationalist';

import { sessionRowHolderId } from './assets/row-asset-claims';
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
    storage: { type: 'memory' },
    durable: false,
    runtime,
    assets: { storage: fixture.storage, policy: { defaultRetentionMilliseconds: 1_000 } },
  });
  cleanups.push(async () => {
    await bureau.dispose();
  });
  return { bureau, runtime };
}

type Opened = Awaited<ReturnType<typeof openBureau>>;

async function collect({ bureau }: Opened) {
  const result = await bureau.assets!.collectGarbage().result();
  if (result.outcome !== 'completed') throw new Error(`collection failed: ${result.outcome}`);
  return result.value;
}

/** Runs the painter on a session and waits until the run and its session commit have settled. */
async function paint(
  { bureau }: Opened,
  sessionId: string,
  extra: { appendMessages?: ReadonlyArray<Message>; message?: string } = {},
) {
  const created = await bureau.createRun({
    ...(extra.appendMessages === undefined ? { message: 'Draw' } : {}),
    ...extra,
    agentName: 'painter',
    principal: alice.id,
    sessionId,
  });
  await waitForRunState(bureau, created.id);
  for (let turn = 0; turn < 20; turn += 1) await yieldToPortableEventLoop();
  return created;
}

/** Rows as a client would hand them over: their own ids and content, ready to append. */
function builtRows(...inputs: Array<MessageInput & { id: string }>): Message[] {
  const history = appendMessages(createConversationHistory({ id: 'scratch' }), ...inputs);
  return history.ids.map((id) => history.messages[id]!);
}

async function rowsOf({ bureau }: Opened, sessionId: string): Promise<Message[]> {
  const session = await bureau.getSession(sessionId);
  const history = session!.conversationHistory;
  return history.ids.map((id) => history.messages[id]!);
}

function assetsOf(row: Message): string[] {
  if (typeof row.content === 'string') return [];
  return row.content.flatMap((part) =>
    'source' in part && part.source.kind === 'managed-asset' ? [part.source.assetId] : [],
  );
}

async function assetIdsOf(opened: Opened, sessionId: string): Promise<string[]> {
  const rows = await rowsOf(opened, sessionId);
  return rows.flatMap(assetsOf);
}

async function resolves({ bureau }: Opened, assetId: string): Promise<boolean> {
  try {
    await bureau.assets!.resolve({ kind: 'managed-asset', assetId }, alice);
    return true;
  } catch {
    return false;
  }
}

describe('a generated image a session row references', () => {
  it('survives collection past the retention floor, and is released when the session is deleted', async () => {
    const opened = await openBureau();
    const { bureau, runtime } = opened;
    const created = await paint(opened, 'trunk');
    const [assetId] = await assetIdsOf(opened, 'trunk');

    await runtime.advance(5_000);
    const report = await collect(opened);

    expect(report.expired).not.toContain(assetId!);
    expect(await resolves(opened, assetId!)).toBe(true);

    await bureau.deleteSession(created.sessionId);
    const afterDelete = await collect(opened);

    expect(afterDelete.expired).toContain(assetId!);
  });

  it('is still expired by the floor when no row ever referenced it', async () => {
    const opened = await openBureau();
    const admission = await opened.bureau.assets!.admit(
      { source: { kind: 'inline', bytes: png } },
      alice,
    );
    await admission.work.result();

    await opened.runtime.advance(5_000);
    const report = await collect(opened);

    expect(report.expired).toContain(admission.assetId);
  });
});

describe('a row copied into another session (appendMessages)', () => {
  /** The trunk paints; the copy session is created from the trunk's rows, with the same ids. */
  async function trunkAndCopy() {
    const opened = await openBureau();
    await paint(opened, 'trunk');
    const trunkRows = await rowsOf(opened, 'trunk');
    const [assetId] = trunkRows.flatMap(assetsOf);
    const copied = builtRows(
      ...trunkRows.map((row) => ({
        id: row.id,
        role: row.role,
        content: row.content as MessageInput['content'],
      })),
      { id: 'again', role: 'user', content: 'Again.' },
    );
    await paint(opened, 'copy', { appendMessages: copied });
    expect(await assetIdsOf(opened, 'copy')).toContain(assetId!);
    return { opened, assetId: assetId! };
  }

  it.each([
    ['trunk', 'copy'],
    ['copy', 'trunk'],
  ] as const)(
    'deleting the %s session leaves the %s session able to resolve the shared asset',
    async (deleted, survivor) => {
      const { opened, assetId } = await trunkAndCopy();

      await opened.bureau.deleteSession(deleted);
      await opened.runtime.advance(5_000);
      await collect(opened);

      expect(await opened.bureau.getSession(survivor)).toBeDefined();
      expect(await resolves(opened, assetId)).toBe(true);
    },
  );

  it('expires the shared asset once both sessions are gone', async () => {
    const { opened, assetId } = await trunkAndCopy();

    await opened.bureau.deleteSession('trunk');
    await opened.bureau.deleteSession('copy');
    await opened.runtime.advance(5_000);
    const report = await collect(opened);

    expect(report.expired).toContain(assetId);
  });
});

describe('a supplied image a user row references', () => {
  async function sessionWithSuppliedImage(opened: Opened) {
    const admission = await opened.bureau.assets!.admit(
      { source: { kind: 'inline', bytes: png } },
      alice,
    );
    await admission.work.result();
    const rows = builtRows({
      id: 'supplied-row',
      role: 'user',
      content: [
        {
          type: 'image',
          mimeType: 'image/png',
          source: { kind: 'managed-asset', assetId: admission.assetId },
        },
      ],
    });
    const created = await paint(opened, 'supplied', { appendMessages: rows });
    return { assetId: admission.assetId, created };
  }

  it('survives collection past the floor and replays, and expires after the session is deleted', async () => {
    const opened = await openBureau();
    const { assetId, created } = await sessionWithSuppliedImage(opened);

    await opened.runtime.advance(5_000);
    const report = await collect(opened);

    expect(report.expired).not.toContain(assetId);
    expect(await resolves(opened, assetId)).toBe(true);

    await opened.bureau.deleteSession(created.sessionId);
    const afterDelete = await collect(opened);

    expect(afterDelete.expired).toContain(assetId);
  });
});

describe('an expiring session', () => {
  it('releases its claims once the store has removed it, so its assets fall back to the floor', async () => {
    const opened = await openBureau();
    await paint(opened, 'old');
    const [assetId] = await assetIdsOf(opened, 'old');

    await opened.runtime.advance(5_000);
    expect(await opened.bureau.sessionStore!.cleanup({ olderThan: -60_000 })).toBe(1);
    for (let turn = 0; turn < 20; turn += 1) await yieldToPortableEventLoop();
    const report = await collect(opened);

    expect(report.expired).toContain(assetId!);
  });
});

describe('a session saved with a copied history (a goal retry, a session fork)', () => {
  it('claims the copied rows itself, so deleting the trunk leaves the copy able to resolve them', async () => {
    const opened = await openBureau();
    await paint(opened, 'trunk');
    const loaded = await opened.bureau.getSession('trunk');
    const trunk = loaded!;
    const [assetId] = await assetIdsOf(opened, 'trunk');

    await opened.bureau.sessionStore!.save(
      createAgentSession({
        id: 'retry',
        agentName: trunk.agentName,
        conversationHistory: trunk.conversationHistory,
        metadata: { [SESSION_OWNER_METADATA_KEY]: alice.id },
        runs: [],
      }),
    );
    for (let turn = 0; turn < 20; turn += 1) await yieldToPortableEventLoop();

    await opened.bureau.deleteSession('trunk');
    await opened.runtime.advance(5_000);
    await collect(opened);

    expect(await resolves(opened, assetId!)).toBe(true);
  });
});

describe('a claim that fails when its commit is replayed', () => {
  async function suppliedImageRows(opened: Opened) {
    const admission = await opened.bureau.assets!.admit(
      { source: { kind: 'inline', bytes: png } },
      alice,
    );
    await admission.work.result();
    const rows = builtRows({
      id: 'supplied-row',
      role: 'user',
      content: [
        {
          type: 'image',
          mimeType: 'image/png',
          source: { kind: 'managed-asset', assetId: admission.assetId },
        },
      ],
    });
    return { assetId: admission.assetId, rows };
  }

  it('leaves the outbox entry unacknowledged, and a later drain claims it', async () => {
    const opened = await openBureau();
    const { assetId, rows } = await suppliedImageRows(opened);
    const retain = opened.bureau.assets!.retain.bind(opened.bureau.assets);
    let failing = true;
    spyOn(opened.bureau.assets!, 'retain').mockImplementation(async (...args) => {
      if (failing && args[0] === assetId) {
        throw new Error('retention unavailable');
      }
      return retain(...args);
    });

    await paint(opened, 'supplied', { appendMessages: rows });

    // The claim failed, so the commit's entry is still there for a later drain to retry.
    const pending = await opened.bureau.sessionStore!.outbox.pending();
    expect(pending.some((entry) => entry.sessionId === 'supplied')).toBe(true);

    // The service recovers, and a later commit wakes the drain, which now claims the first commit's rows.
    failing = false;
    await paint(opened, 'other');
    expect(await opened.bureau.sessionStore!.outbox.pending()).toEqual([]);
    await opened.runtime.advance(5_000);
    const report = await collect(opened);
    expect(report.expired).not.toContain(assetId);
    expect(await resolves(opened, assetId)).toBe(true);
  });
});

describe('a session recreated under the id of a deleted one', () => {
  it('is not affected when the old incarnation releases its claims after the new one claimed', async () => {
    const opened = await openBureau();
    const admission = await opened.bureau.assets!.admit(
      { source: { kind: 'inline', bytes: png } },
      alice,
    );
    await admission.work.result();
    const rows = builtRows({
      id: 'supplied-row',
      role: 'user',
      content: [
        {
          type: 'image',
          mimeType: 'image/png',
          source: { kind: 'managed-asset', assetId: admission.assetId },
        },
      ],
    });
    await paint(opened, 'same-id', { appendMessages: rows });
    const oldSession = await opened.bureau.getSession('same-id');
    const oldIncarnation = oldSession!.incarnation;
    // The old incarnation is deleted, and a new session takes the id with the same row id and asset.
    await opened.bureau.deleteSession('same-id');
    await paint(opened, 'same-id', { appendMessages: rows });

    // The old incarnation's release lands late, after the new session claimed.
    await opened.bureau.assets!.release(
      admission.assetId,
      alice,
      sessionRowHolderId('same-id', oldIncarnation, 'supplied-row'),
    );
    await opened.runtime.advance(5_000);
    await collect(opened);

    expect(await resolves(opened, admission.assetId)).toBe(true);
  });
});
