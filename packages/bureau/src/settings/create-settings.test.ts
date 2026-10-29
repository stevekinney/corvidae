import { describe, expect, test } from 'bun:test';

import { MemoryStorage, textValueStore } from '@lostgradient/storage';

import {
  createSettings,
  readSettingsRecord,
  SETTINGS_CHANGED_AUDIT_TYPE,
  type SettingsDependencies,
} from './create-settings.ts';
import { SETTING_KEYS, type SettingKey, SETTINGS_RECORD_KEY } from './settings-schema.ts';

type AuditEntry = Parameters<SettingsDependencies['audit']>[0];

async function compose(
  options: {
    readonly storage?: MemoryStorage;
    readonly locked?: readonly SettingKey[];
    readonly defaults?: SettingsDependencies['defaults'];
    readonly persisted?: boolean;
  } = {},
) {
  const diagnostics: string[] = [];
  const audits: AuditEntry[] = [];
  const applied: (readonly SettingKey[])[] = [];
  const store =
    options.storage === undefined
      ? undefined
      : textValueStore(options.storage, { disposeUnderlyingStorage: false });
  const diagnose = (message: string) => {
    diagnostics.push(message);
  };
  const defaults = options.defaults ?? { 'tools.wakeup': true, maintenance: 'automatic' };
  const locked = new Set(options.locked ?? []);
  const boot =
    store === undefined
      ? { record: undefined, storedValues: {}, raw: null }
      : await readSettingsRecord(store, { defaults, locked }, diagnose);
  const composition = createSettings({
    store,
    persisted: options.persisted ?? store !== undefined,
    defaults,
    locked,
    boot,
    nowISO: () => '2026-10-27T00:00:00.000Z',
    diagnose,
    audit: (entry) => {
      audits.push(entry);
      return Promise.resolve();
    },
    applyLive: (_values, keys) => {
      applied.push(keys);
    },
  });
  return { ...composition, diagnostics, audits, applied };
}

describe('bureau.settings update outcomes', () => {
  test('a live key applies at once and is audited with its keys and revision, never its value', async () => {
    const { settings, current, audits, applied } = await compose({ storage: new MemoryStorage() });
    const result = await settings.update({ 'tools.wakeup': false }, { expectedRevision: 0 });
    expect(result).toEqual({ outcome: 'applied', revision: 1, pendingRestart: [] });
    expect(current()['tools.wakeup']).toBe(false);
    expect(applied.at(-1)).toEqual(['tools.wakeup']);
    expect(audits).toEqual([
      {
        runId: 'settings',
        type: SETTINGS_CHANGED_AUDIT_TYPE,
        detail: { keys: 'tools.wakeup', revision: 1 },
      },
    ]);
    expect(JSON.stringify(audits)).not.toContain('false');
  });

  test('a restart key is stored and pending, and the value in force stays the boot value', async () => {
    const storage = new MemoryStorage();
    const { settings, current } = await compose({ storage });
    const result = await settings.update({ maintenance: 'manual' }, { expectedRevision: 0 });
    expect(result).toEqual({ outcome: 'applied', revision: 1, pendingRestart: ['maintenance'] });
    expect(current().maintenance).toBe('automatic');
    const snapshot = await settings.get();
    expect(snapshot.values.maintenance).toBe('manual');
    expect(snapshot.keys.maintenance).toEqual({
      apply: 'restart',
      locked: false,
      pendingRestart: true,
    });
    const next = await compose({ storage });
    expect(next.current().maintenance).toBe('manual');
    const restarted = await next.settings.get();
    expect(restarted.keys.maintenance.pendingRestart).toBe(false);
  });

  test('a stale expected revision is refused with the revision now current', async () => {
    const { settings } = await compose({ storage: new MemoryStorage() });
    await settings.update({ 'tools.wakeup': false }, { expectedRevision: 0 });
    expect(await settings.update({ 'tools.wakeup': true }, { expectedRevision: 0 })).toMatchObject({
      outcome: 'rejected',
      reason: 'stale-revision',
      keys: ['tools.wakeup'],
      currentRevision: 1,
    });
  });

  test('a locked key is refused, reported locked, and its stored value is ignored', async () => {
    const storage = new MemoryStorage();
    const store = textValueStore(storage, { disposeUnderlyingStorage: false });
    await store.set(
      SETTINGS_RECORD_KEY,
      JSON.stringify({
        schemaVersion: 1,
        revision: 3,
        values: { 'tools.humanInput': false },
        updatedAt: '',
      }),
    );
    const { settings, current } = await compose({
      storage,
      locked: ['tools.humanInput'],
      defaults: { 'tools.humanInput': {} },
    });
    expect(current()['tools.humanInput']).toEqual({});
    expect(
      await settings.update({ 'tools.humanInput': false }, { expectedRevision: 3 }),
    ).toMatchObject({
      outcome: 'rejected',
      reason: 'locked',
      keys: ['tools.humanInput'],
      currentRevision: 3,
    });
    const snapshot = await settings.get();
    expect(snapshot.keys['tools.humanInput'].locked).toBe(true);
  });

  test('an unknown key is refused', async () => {
    const { settings } = await compose({ storage: new MemoryStorage() });
    expect(
      await settings.update({ 'tools.teleport': true }, { expectedRevision: 0 }),
    ).toMatchObject({
      outcome: 'rejected',
      reason: 'unknown-key',
      keys: ['tools.teleport'],
      currentRevision: 0,
    });
  });

  test('an invalid value is refused', async () => {
    const { settings } = await compose({ storage: new MemoryStorage() });
    expect(
      await settings.update({ 'decisions.maximumPerTask': 0 }, { expectedRevision: 0 }),
    ).toMatchObject({
      outcome: 'rejected',
      reason: 'invalid-value',
      keys: ['decisions.maximumPerTask'],
    });
  });

  test('an answer schema operative would refuse is an invalid value', async () => {
    const { settings } = await compose({ storage: new MemoryStorage() });
    expect(
      await settings.update(
        { 'tools.humanInput': { inputSchemas: { approve: { type: 'not-a-type' } } } },
        { expectedRevision: 0 },
      ),
    ).toMatchObject({ outcome: 'rejected', reason: 'invalid-value', keys: ['tools.humanInput'] });
  });

  test('a patch with one invalid value writes none of its keys', async () => {
    const storage = new MemoryStorage();
    const { settings, current } = await compose({ storage });
    const result = await settings.update(
      { 'tools.wakeup': false, 'engine.retentionSweepBatchSize': -1 },
      { expectedRevision: 0 },
    );
    expect(result).toMatchObject({
      outcome: 'rejected',
      reason: 'invalid-value',
      keys: ['engine.retentionSweepBatchSize'],
    });
    expect(current()['tools.wakeup']).toBe(true);
    const store = textValueStore(storage, { disposeUnderlyingStorage: false });
    expect(await store.get(SETTINGS_RECORD_KEY)).toBeNull();
  });

  test('two processes updating one store at one revision: one applies, the other is stale', async () => {
    const storage = new MemoryStorage();
    const first = await compose({ storage });
    const second = await compose({ storage });
    const outcomes = await Promise.all([
      first.settings.update({ 'tools.wakeup': false }, { expectedRevision: 0 }),
      second.settings.update({ 'decisions.maximumPerTask': 3 }, { expectedRevision: 0 }),
    ]);
    expect(outcomes.map((outcome) => outcome.outcome).toSorted()).toEqual(['applied', 'rejected']);
    expect(outcomes.find((outcome) => outcome.outcome === 'rejected')).toMatchObject({
      reason: 'stale-revision',
      currentRevision: 1,
    });
  });

  test('an update and a re-read are serialized, so the re-read neither loses nor repeats it', async () => {
    const storage = new MemoryStorage();
    const first = await compose({ storage });
    const second = await compose({ storage });
    await first.settings.update({ 'decisions.maximumPerTask': 4 }, { expectedRevision: 0 });
    const changes: number[] = [];
    second.settings.subscribe((change) => changes.push(change.revision));
    const [, outcome] = await Promise.all([
      second.reload(),
      second.settings.update({ 'tools.wakeup': false }, { expectedRevision: 1 }),
    ]);
    expect(outcome).toMatchObject({ outcome: 'applied', revision: 2 });
    expect(changes).toEqual([1, 2]);
    expect(second.current()).toMatchObject({
      'decisions.maximumPerTask': 4,
      'tools.wakeup': false,
    });
  });
});

describe('bureau.settings storage', () => {
  test('a second process sees a change once it re-reads, and its listeners hear of it', async () => {
    const storage = new MemoryStorage();
    const first = await compose({ storage });
    const second = await compose({ storage });
    const heard: unknown[] = [];
    second.settings.subscribe((change) => heard.push(change));
    await first.settings.update({ 'tools.wakeup': false }, { expectedRevision: 0 });
    expect(second.current()['tools.wakeup']).toBe(true);
    await second.reload();
    expect(second.current()['tools.wakeup']).toBe(false);
    expect(heard).toEqual([{ revision: 1, keys: ['tools.wakeup'] }]);
    expect(second.applied.at(-1)).toEqual(['tools.wakeup']);
  });

  test('a stored key the schema does not have, or with an invalid value, is dropped with a diagnostic', async () => {
    const storage = new MemoryStorage();
    const store = textValueStore(storage, { disposeUnderlyingStorage: false });
    await store.set(
      SETTINGS_RECORD_KEY,
      JSON.stringify({
        schemaVersion: 1,
        revision: 2,
        values: { 'tools.teleport': true, 'decisions.maximumPerTask': -5, 'tools.wakeup': false },
        updatedAt: '',
      }),
    );
    const { current, diagnostics, settings } = await compose({ storage });
    expect(current()).toMatchObject({ 'tools.wakeup': false });
    expect(current()['decisions.maximumPerTask']).toBeUndefined();
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics[0]).toContain('tools.teleport');
    expect(diagnostics[1]).toContain('decisions.maximumPerTask');
    const stored = await settings.get();
    expect(stored.revision).toBe(2);
  });

  test('a record that is not JSON leaves every default in force', async () => {
    const storage = new MemoryStorage();
    await textValueStore(storage, { disposeUnderlyingStorage: false }).set(
      SETTINGS_RECORD_KEY,
      '{',
    );
    const { current, diagnostics } = await compose({ storage });
    expect(current()['tools.wakeup']).toBe(true);
    expect(diagnostics).toHaveLength(1);
  });

  test('without a store the record lives in memory, reports persisted false, and still applies', async () => {
    const { settings, current } = await compose();
    const ephemeral = await settings.get();
    expect(ephemeral.persisted).toBe(false);
    await settings.update({ 'tools.wakeup': false }, { expectedRevision: 0 });
    expect(current()['tools.wakeup']).toBe(false);
  });

  test('the schema is JSON Schema naming every key', async () => {
    const { settings } = await compose();
    const schema = settings.schema();
    expect(Object.keys(schema['properties'] as object).toSorted()).toEqual(
      [...SETTING_KEYS].toSorted(),
    );
  });
});

/** Writes a settings record holding `values` straight into `storage`, as another build might. */
async function seed(storage: MemoryStorage, values: Record<string, unknown>): Promise<void> {
  await textValueStore(storage, { disposeUnderlyingStorage: false }).set(
    SETTINGS_RECORD_KEY,
    JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      values,
      updatedAt: '2026-10-27T00:00:00.000Z',
    }),
  );
}

async function storedValues(storage: MemoryStorage): Promise<Record<string, unknown>> {
  const raw = await textValueStore(storage, { disposeUnderlyingStorage: false }).get(
    SETTINGS_RECORD_KEY,
  );
  return (JSON.parse(raw ?? '{}') as { values: Record<string, unknown> }).values;
}

describe('a value its consumer refuses is never accepted or applied', () => {
  test('a workflow-claim time-to-live Weft refuses under the default ownership is invalid-value', async () => {
    const { settings } = await compose({ storage: new MemoryStorage() });
    const result = await settings.update(
      { 'engine.workflowClaimTtl': 1_000 },
      { expectedRevision: 0 },
    );
    expect(result).toMatchObject({
      outcome: 'rejected',
      reason: 'invalid-value',
      keys: ['engine.workflowClaimTtl'],
    });
    const snapshot = await settings.get();
    expect(snapshot.revision).toBe(0);
  });

  test('the same time-to-live is accepted where Weft does not check it: ownership none', async () => {
    const { settings } = await compose({
      storage: new MemoryStorage(),
      defaults: { 'durableOwnership.ownership': 'none' },
    });
    expect(
      await settings.update({ 'engine.workflowClaimTtl': 1_000 }, { expectedRevision: 0 }),
    ).toMatchObject({ outcome: 'applied' });
  });

  test('a fractional scheduler poll interval is invalid-value', async () => {
    const { settings, applied } = await compose({ storage: new MemoryStorage() });
    const before = applied.length;
    expect(
      await settings.update({ 'engine.schedulerPollIntervalMs': 1.5 }, { expectedRevision: 0 }),
    ).toMatchObject({
      outcome: 'rejected',
      reason: 'invalid-value',
      keys: ['engine.schedulerPollIntervalMs'],
    });
    expect(applied.length).toBe(before);
  });

  test('a model-policy user configuration with a malformed field is invalid-value', async () => {
    const { settings } = await compose({ storage: new MemoryStorage() });
    expect(
      await settings.update(
        { modelPolicy: { policyRevision: 1, users: { alice: { allowedProviders: null } } } },
        { expectedRevision: 0 },
      ),
    ).toMatchObject({ outcome: 'rejected', reason: 'invalid-value', keys: ['modelPolicy'] });
    expect(
      await settings.update(
        { modelPolicy: { policyRevision: 1, users: { alice: { allowedProviders: ['openai'] } } } },
        { expectedRevision: 0 },
      ),
    ).toMatchObject({ outcome: 'applied' });
  });

  test('a stored record holding an incoherent claim pair loads without it, and keeps the rest', async () => {
    const storage = new MemoryStorage();
    await seed(storage, {
      'engine.workflowClaimTtl': 1_000,
      'engine.schedulerPollIntervalMs': 1.5,
      'engine.retentionSweepBatchSize': 25,
      'tools.wakeup': false,
    });
    const { settings, current, diagnostics } = await compose({ storage });
    const { values } = await settings.get();
    expect(values['engine.workflowClaimTtl']).toBeUndefined();
    expect(values['engine.schedulerPollIntervalMs']).toBeUndefined();
    expect(values['engine.retentionSweepBatchSize']).toBe(25);
    expect(current()['tools.wakeup']).toBe(false);
    expect(diagnostics.join('\n')).toContain('"engine.workflowClaimTtl"');
    expect(diagnostics.join('\n')).toContain('"engine.schedulerPollIntervalMs"');
  });
});

describe('an update keeps what this build cannot read', () => {
  test('an unknown key and a refused value survive an unrelated update, verbatim', async () => {
    const storage = new MemoryStorage();
    await seed(storage, {
      'future.key': { nested: [1, 2] },
      'decisions.maximumPerTask': 0,
      'tools.decide': false,
    });
    const { settings, current } = await compose({ storage });
    expect(current()['decisions.maximumPerTask']).toBeUndefined();
    expect(await settings.update({ 'tools.wakeup': false }, { expectedRevision: 1 })).toMatchObject(
      { outcome: 'applied', revision: 2 },
    );
    expect(await storedValues(storage)).toEqual({
      'future.key': { nested: [1, 2] },
      'decisions.maximumPerTask': 0,
      'tools.decide': false,
      'tools.wakeup': false,
    });
    expect(current()['decisions.maximumPerTask']).toBeUndefined();
  });
});
