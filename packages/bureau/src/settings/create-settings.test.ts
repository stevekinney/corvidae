import { describe, expect, test } from 'bun:test';

import { MemoryStorage, textValueStore } from '@lostgradient/weft';

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
  const boot =
    store === undefined
      ? { record: undefined, raw: null }
      : await readSettingsRecord(store, diagnose);
  const composition = createSettings({
    store,
    persisted: options.persisted ?? store !== undefined,
    defaults: options.defaults ?? { 'tools.wakeup': true, maintenance: 'automatic' },
    locked: new Set(options.locked ?? []),
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
