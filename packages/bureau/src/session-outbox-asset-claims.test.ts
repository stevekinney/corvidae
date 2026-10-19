/**
 * COR-1581 — the session outbox drain claims a committed row's assets before it acknowledges the
 * entry, so a claim that can never succeed must not hold back every session's events. A corrupt
 * asset record is that claim: it is reported, remembered and skipped; every other failure leaves the
 * entry pending for a retry. A Bureau without an asset service does none of this work, and a claim
 * missed before a restart is replayed at boot.
 */
import { createManualRuntimeServices, type ManualRuntimeServices } from '@lostgradient/lifecycle';
import {
  createAgent,
  createAgentSession,
  createModelCatalog,
  SESSION_OWNER_METADATA_KEY,
  stopWhen,
  waitForCondition,
  waitForRunState,
  withBackendDescriptors,
} from '@lostgradient/operative';
import { MemoryStorage, textValueStore, yieldToPortableEventLoop } from '@lostgradient/weft';
import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import {
  appendMessages,
  createConversationHistory,
  type Message,
  type MessageInput,
} from 'conversationalist';

import { KEYS } from './assets/records';
import type { AssetStorage } from './assets/storage';
import { createBureau } from './create-bureau';
import { createMemoryAssetStorageFixture } from './test/asset-storage-fixtures';
import { alice, bob, pngBytes } from './testing/asset-fixtures.test-support';
import type { Bureau, BureauDiagnostic } from './types';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
  await yieldToPortableEventLoop();
});

const FLOOR_MILLISECONDS = 1_000;
const PAST_THE_FLOOR = 5_000;
/** The longer of the outbox claim lease (30 s) a dead process can still hold. */
const LEASE_MILLISECONDS = 31_000;
const png = pngBytes(4, 3);

const echo = createAgent({
  generate: withBackendDescriptors(
    async () => ({ content: 'ok', toolCalls: [] }),
    createModelCatalog().descriptors.filter((descriptor) => descriptor.provider === 'anthropic'),
  ),
  stopWhen: stopWhen.noToolCalls(),
});

interface Environment {
  readonly runtime: ManualRuntimeServices;
  readonly fixture: ReturnType<typeof createMemoryAssetStorageFixture>;
  /** The session store's backing storage, shared by every Bureau opened over it. */
  readonly persistence: MemoryStorage;
  readonly diagnostics: BureauDiagnostic[];
}

function createEnvironment(): Environment {
  const fixture = createMemoryAssetStorageFixture({});
  cleanups.push(() => fixture.dispose());
  return {
    runtime: createManualRuntimeServices({ origin: '2026-10-18T00:00:00.000Z' }),
    fixture,
    persistence: new MemoryStorage(),
    diagnostics: [],
  };
}

async function openBureau(
  environment: Environment,
  options: {
    assets?: AssetStorage | false;
    extra?: Partial<Parameters<typeof createBureau>[0]>;
  } = {},
): Promise<Bureau> {
  const bureau = await createBureau({
    agents: { echo },
    persistence: textValueStore(environment.persistence, { disposeUnderlyingStorage: false }),
    runtime: environment.runtime,
    onDiagnostic: (diagnostic) => environment.diagnostics.push(diagnostic),
    ...(options.assets === false
      ? {}
      : {
          assets: {
            storage: options.assets ?? environment.fixture.storage,
            policy: { defaultRetentionMilliseconds: FLOOR_MILLISECONDS },
          },
        }),
    ...options.extra,
  });
  cleanups.push(async () => {
    await bureau.dispose();
  });
  return bureau;
}

async function suppliedAsset(bureau: Bureau): Promise<string> {
  const admission = await bureau.assets!.admit(
    { source: { kind: 'inline', bytes: png }, declaredMediaType: 'image/png' },
    alice,
  );
  await admission.work.result();
  return admission.assetId;
}

/** A user row, with its own id, that references each asset. */
function rowReferencing(id: string, ...assetIds: string[]): MessageInput & { id: string } {
  return {
    id,
    role: 'user',
    content: assetIds.map((assetId) => ({
      type: 'image' as const,
      mimeType: 'image/png',
      source: { kind: 'managed-asset' as const, assetId },
    })),
  };
}

function builtRows(...inputs: Array<MessageInput & { id: string }>): Message[] {
  const history = appendMessages(createConversationHistory({ id: 'scratch' }), ...inputs);
  return history.ids.map((id) => history.messages[id]!);
}

/** Runs the echo agent on a session whose history starts with the given rows, and lets its commits drain. */
async function converse(bureau: Bureau, sessionId: string, rows: Message[] = []) {
  const created = await bureau.createRun({
    ...(rows.length === 0 ? { message: 'Hello' } : { appendMessages: rows }),
    agentName: 'echo',
    principal: alice.id,
    sessionId,
  });
  await waitForRunState(bureau, created.id);
  for (let turn = 0; turn < 20; turn += 1) await yieldToPortableEventLoop();
}

/** Saves a session holding the rows straight to the store: one commit, so exactly one outbox entry. */
async function saveDirectly(
  bureau: Bureau,
  sessionId: string,
  rows: Message[],
  metadata: Record<string, string>,
) {
  const history = appendMessages(
    createConversationHistory({ id: sessionId }),
    ...rows.map((row) => ({
      id: row.id,
      role: row.role,
      content: row.content as MessageInput['content'],
    })),
  );
  await bureau.sessionStore!.save(
    createAgentSession({
      id: sessionId,
      agentName: 'echo',
      conversationHistory: history,
      metadata,
      runs: [],
    }),
  );
  for (let turn = 0; turn < 20; turn += 1) await yieldToPortableEventLoop();
}

async function pending(bureau: Bureau): Promise<number> {
  const entries = await bureau.sessionStore!.outbox.pending();
  return entries.length;
}

async function drained(bureau: Bureau): Promise<void> {
  await waitForCondition(
    async () => (await pending(bureau)) === 0,
    'the outbox never emptied',
    200,
  );
}

async function pastTheFloor(environment: Environment, bureau: Bureau) {
  await environment.runtime.advance(PAST_THE_FLOOR);
  const collected = await bureau.assets!.collectGarbage().result();
  if (collected.outcome !== 'completed') throw new Error(`collection ${collected.outcome}`);
  return collected.value;
}

async function resolves(bureau: Bureau, assetId: string): Promise<boolean> {
  try {
    await bureau.assets!.resolve({ kind: 'managed-asset', assetId }, alice);
    return true;
  } catch {
    return false;
  }
}

function claimDiagnostics(environment: Environment, assetId: string): BureauDiagnostic[] {
  return environment.diagnostics.filter(
    (diagnostic) => diagnostic.scope === 'assets' && diagnostic.message.includes(assetId),
  );
}

/** The sessions whose commits reached the Bureau's listeners, as `session.created` or `session.saved`. */
function savedSessions(bureau: Bureau): string[] {
  const saved: string[] = [];
  for (const type of ['session.created', 'session.saved'] as const) {
    bureau.addEventListener(type, (event) => {
      saved.push(event.sessionId);
    });
  }
  return saved;
}

/** Storage whose reads of the keys `shouldFail` names reject, as an unavailable backend does. */
function flaky(storage: AssetStorage, shouldFail: (key: string) => boolean): AssetStorage {
  return {
    durability: storage.durability,
    async get(key) {
      if (shouldFail(key)) throw new Error('the backend is unavailable');
      return storage.get(key);
    },
    set: (key, value) => storage.set(key, value),
    delete: (key) => storage.delete(key),
    list: (prefix) => storage.list(prefix),
    conditionalBatch: (conditions, operations) => storage.conditionalBatch(conditions, operations),
  };
}

function withMember(member: string, value: unknown): (raw: string) => string {
  return (raw) =>
    JSON.stringify({ ...(JSON.parse(raw) as Record<string, unknown>), [member]: value });
}

const corruptions: ReadonlyArray<readonly [string, (raw: string) => string]> = [
  ['JSON that does not parse', () => '{not json'],
  // Shapes that pass the top-level checks but throw once the claim is projected (COR-1581).
  [
    'a reference whose until is not a date',
    withMember('references', [{ holderId: 'h', until: 'not-a-date' }]),
  ],
  ['a retainUntil that is not a date', withMember('retainUntil', 'not-a-date')],
  ['a numeric mediaType', withMember('mediaType', 5)],
  [
    'a record missing a field the service reads',
    (raw) => {
      const { references: _references, ...rest } = JSON.parse(raw) as Record<string, unknown>;
      return JSON.stringify(rest);
    },
  ],
];

async function corrupt(environment: Environment, assetId: string, how: (raw: string) => string) {
  const key = KEYS.record(assetId);
  await environment.fixture.storage.set(key, how((await environment.fixture.storage.get(key))!));
}

describe.each(corruptions)(
  'a session that references an asset with %s in its record',
  (_name, how) => {
    it('does not hold back a later session’s events, and the diagnostic names the session, the row and the asset', async () => {
      const environment = createEnvironment();
      const bureau = await openBureau(environment);
      const assetId = await suppliedAsset(bureau);
      await corrupt(environment, assetId, how);
      const saved = savedSessions(bureau);

      await converse(bureau, 'broken', builtRows(rowReferencing('broken-row', assetId)));
      await converse(bureau, 'healthy');

      expect(await pending(bureau)).toBe(0);
      expect(saved).toContain('broken');
      expect(saved).toContain('healthy');
      const [diagnostic, ...others] = claimDiagnostics(environment, assetId);
      expect(others).toEqual([]);
      expect(diagnostic).toMatchObject({ level: 'error', scope: 'assets' });
      expect(diagnostic!.message).toContain('"broken"');
      expect(diagnostic!.message).toContain('"broken-row"');
      expect(diagnostic!.message).toContain(assetId);
    });
  },
);

describe('a claim that fails for a reason a retry could fix', () => {
  it('leaves the entry pending when the backend cannot read the record, and a later drain claims it', async () => {
    const environment = createEnvironment();
    const first = await openBureau(environment);
    const assetId = await suppliedAsset(first);
    await first.dispose();
    let failing = true;
    const bureau = await openBureau(environment, {
      assets: flaky(environment.fixture.storage, (key) => failing && key === KEYS.record(assetId)),
    });

    await converse(bureau, 'supplied', builtRows(rowReferencing('supplied-row', assetId)));
    expect(await pending(bureau)).toBeGreaterThan(0);

    failing = false;
    await converse(bureau, 'other');
    expect(await pending(bureau)).toBe(0);
    await environment.runtime.advance(PAST_THE_FLOOR);
    const collected = await bureau.assets!.collectGarbage().result();
    expect(collected.outcome === 'completed' && collected.value.expired).not.toContain(assetId);
    expect(await resolves(bureau, assetId)).toBe(true);
  });

  it('keeps the entry pending when one claim is permanent and another is transient, and claims the transient one later', async () => {
    const environment = createEnvironment();
    const bureau = await openBureau(environment);
    const brokenAsset = await suppliedAsset(bureau);
    const transientAsset = await suppliedAsset(bureau);
    const repaired = (await environment.fixture.storage.get(KEYS.record(brokenAsset)))!;
    await corrupt(environment, brokenAsset, () => '{not json');
    const retain = bureau.assets!.retain.bind(bureau.assets);
    let failing = true;
    spyOn(bureau.assets!, 'retain').mockImplementation(async (...args) => {
      if (failing && args[0] === transientAsset) throw new Error('retention unavailable');
      return retain(...args);
    });

    await saveDirectly(
      bureau,
      'mixed',
      builtRows(
        rowReferencing('broken-row', brokenAsset),
        rowReferencing('transient-row', transientAsset),
      ),
      { [SESSION_OWNER_METADATA_KEY]: alice.id },
    );

    // The permanent failure alone would have let the entry go; the transient one keeps it, and it
    // is the only commit, so the one entry is the one that is still pending.
    expect(await pending(bureau)).toBe(1);

    failing = false;
    await converse(bureau, 'other');
    await drained(bureau);
    // Collection reads every record, so the corrupt one is repaired before it runs.
    await environment.fixture.storage.set(KEYS.record(brokenAsset), repaired);
    const report = await pastTheFloor(environment, bureau);
    expect(report.expired).not.toContain(transientAsset);
    expect(await resolves(bureau, transientAsset)).toBe(true);
    // The corrupt claim was reported when it was found, and not again on the retry.
    expect(
      claimDiagnostics(environment, brokenAsset).filter((d) => d.level === 'error'),
    ).toHaveLength(1);
  });
});

describe('a skipped claim', () => {
  it('is remembered for the life of the process: two saves of the session produce one diagnostic', async () => {
    const environment = createEnvironment();
    const bureau = await openBureau(environment);
    const assetId = await suppliedAsset(bureau);
    await corrupt(environment, assetId, () => '{not json');

    await converse(bureau, 'broken', builtRows(rowReferencing('broken-row', assetId)));
    expect(claimDiagnostics(environment, assetId)).toHaveLength(1);

    // A second save of the same session replays the row it still holds.
    await converse(bureau, 'broken');
    expect(await pending(bureau)).toBe(0);
    expect(claimDiagnostics(environment, assetId)).toHaveLength(1);
  });
});

describe('a Bureau without an asset service', () => {
  async function savedWithAFailingLoad(assets: boolean) {
    const environment = createEnvironment();
    const bureau = await openBureau(environment, assets ? {} : { assets: false });
    const saved = savedSessions(bureau);
    const load = spyOn(bureau.sessionStore!, 'load').mockRejectedValue(
      new Error('the session store cannot be read'),
    );

    // A direct save never reads through `load`, so every call the spy sees is the drain's.
    await saveDirectly(bureau, 'direct', [], { [SESSION_OWNER_METADATA_KEY]: alice.id });
    return { bureau, saved, load };
  }

  it('does not read the session for any entry, and a failing load cannot stop its drain', async () => {
    const { bureau, saved, load } = await savedWithAFailingLoad(false);

    expect(load).not.toHaveBeenCalled();
    expect(await pending(bureau)).toBe(0);
    expect(saved).toContain('direct');
  });

  it('is the only kind that skips it: with an asset service the drain reads, and a failing load leaves the entry pending', async () => {
    const { bureau, load } = await savedWithAFailingLoad(true);

    expect(load).toHaveBeenCalled();
    expect(await pending(bureau)).toBeGreaterThan(0);
  });
});

describe('a claim missed before a restart', () => {
  it('is replayed at boot, before the entry is acknowledged', async () => {
    const environment = createEnvironment();
    const first = await openBureau(environment);
    const assetId = await suppliedAsset(first);
    const retain = first.assets!.retain.bind(first.assets);
    spyOn(first.assets!, 'retain').mockImplementation(async (...args) => {
      if (args[0] === assetId) throw new Error('retention unavailable');
      return retain(...args);
    });

    await converse(first, 'supplied', builtRows(rowReferencing('supplied-row', assetId)));
    expect(await pending(first)).toBeGreaterThan(0);
    await first.dispose();
    // The first process still holds its lease on the entry; a restart is later than that.
    await environment.runtime.advance(LEASE_MILLISECONDS);

    const second = await openBureau(environment);
    await drained(second);

    const report = await pastTheFloor(environment, second);
    expect(report.expired).not.toContain(assetId);
    expect(await resolves(second, assetId)).toBe(true);
  });
});

describe('the claim pass of a session that records no owner', () => {
  async function savedSessionHolding(
    environment: Environment,
    bureau: Bureau,
    assetId: string,
    metadata: Record<string, string>,
  ) {
    await saveDirectly(
      bureau,
      'direct',
      builtRows(rowReferencing('supplied-row', assetId)),
      metadata,
    );
    return environment.diagnostics.filter((diagnostic) => diagnostic.level === 'warn');
  }

  it('warns when it skips a claim because the session has no owner', async () => {
    const environment = createEnvironment();
    const bureau = await openBureau(environment);
    const assetId = await suppliedAsset(bureau);

    const warnings = await savedSessionHolding(environment, bureau, assetId, {});

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ level: 'warn', scope: 'assets' });
    expect(warnings[0]!.message).toContain('"direct"');
    expect(warnings[0]!.message).toContain('records no owner');
    expect(warnings[0]!.message).toContain(assetId);
  });

  it('stays silent about a reference an owned session’s owner may not read', async () => {
    const environment = createEnvironment();
    const bureau = await openBureau(environment);
    const assetId = await suppliedAsset(bureau);

    const warnings = await savedSessionHolding(environment, bureau, assetId, {
      [SESSION_OWNER_METADATA_KEY]: bob.id,
    });

    expect(warnings).toEqual([]);
    expect(claimDiagnostics(environment, assetId)).toEqual([]);
  });
});
