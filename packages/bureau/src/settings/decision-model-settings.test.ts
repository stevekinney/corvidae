/**
 * COR-2154 — a stored `decisions.model` is read as a catalog row: `typesafe:jev` (the name of the
 * decision router the typesafe plugin used to register) becomes `typesafe/jev`, and the retired
 * `catalog` is dropped to the default with a problem on the key. Rendering that problem on the
 * Settings row belongs to COR-2160.
 */
import { MemoryStorage, textValueStore } from '@lostgradient/storage';
import { describe, expect, test } from 'bun:test';

import { createSettings, readSettingsRecord } from './create-settings.ts';
import { SETTINGS_RECORD_KEY } from './settings-schema.ts';

async function settingsStoring(
  model: string,
  registered: ReadonlySet<string> = new Set(),
  defaultModel?: string,
) {
  const storage = new MemoryStorage();
  const store = textValueStore(storage, { disposeUnderlyingStorage: false });
  await store.set(
    SETTINGS_RECORD_KEY,
    JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      values: { 'decisions.model': model },
      updatedAt: '2026-11-12T00:00:00.000Z',
    }),
  );
  const diagnostics: string[] = [];
  const defaults = defaultModel === undefined ? {} : { 'decisions.model': defaultModel };
  const context = { defaults, locked: new Map(), decisionModels: registered };
  const boot = await readSettingsRecord(store, context, (message) => diagnostics.push(message));
  const { settings } = createSettings({
    store,
    persisted: true,
    defaults,
    builtInDefaults: {},
    locked: new Map(),
    decisionModels: registered,
    boot,
    nowISO: () => '2026-11-12T00:00:00.000Z',
    diagnose: (message) => diagnostics.push(message),
    audit: () => Promise.resolve(),
    applyLive: () => undefined,
  });
  return { settings, diagnostics };
}

describe('a stored decisions.model', () => {
  test('typesafe:jev is read as typesafe/jev', async () => {
    const { settings, diagnostics } = await settingsStoring('typesafe:jev');

    const snapshot = await settings.get();

    expect(snapshot.values['decisions.model']).toBe('typesafe/jev');
    expect(snapshot.keys['decisions.model']).not.toHaveProperty('problem');
    expect(diagnostics).toEqual([]);
  });

  test('typesafe:jev is rewritten even when a host registers a model of that name', async () => {
    const { settings } = await settingsStoring('typesafe:jev', new Set(['typesafe:jev']));

    const snapshot = await settings.get();

    expect(snapshot.values['decisions.model']).toBe('typesafe/jev');
  });

  test('another <plugin>:<model> is not rewritten: only the router that shipped had a name', async () => {
    const { settings } = await settingsStoring('kit:router', new Set(['kit:router']));

    const snapshot = await settings.get();

    expect(snapshot.values['decisions.model']).toBe('kit:router');
  });

  test('catalog is dropped to the default, and the key carries the problem', async () => {
    const { settings, diagnostics } = await settingsStoring('catalog', new Set(), 'typesafe/jev');

    const snapshot = await settings.get();

    // The host's code default, `typesafe/jev`, is what applies in its place.
    expect(snapshot.values['decisions.model']).toBe('typesafe/jev');
    expect(snapshot.keys['decisions.model'].problem).toContain(
      '"catalog" decision model no longer exists',
    );
    expect(diagnostics.join('\n')).toContain('Dropped the stored setting "decisions.model"');
  });
});
