/**
 * COR-2009 (sweep W69) — the value each setting applies by when nothing sets it: every key either
 * has one or is named as having none, every value is one the key accepts, and a durable engine is
 * on by default only over persistent storage.
 */
import { describe, expect, test } from 'bun:test';

import { builtInSettingDefaults, SETTINGS_WITHOUT_DEFAULT } from './setting-defaults.ts';
import { SETTING_KEYS, settingsSchema } from './settings-schema.ts';

describe('builtInSettingDefaults', () => {
  test('gives every key a default or names it as having none, never both', () => {
    const defaults = builtInSettingDefaults({ persistentStorage: false });
    const without = new Set<string>(SETTINGS_WITHOUT_DEFAULT);
    for (const key of SETTING_KEYS) {
      expect({ key, covered: Object.hasOwn(defaults, key) !== without.has(key) }).toEqual({
        key,
        covered: true,
      });
    }
    expect(Object.keys(defaults).length + without.size).toBe(SETTING_KEYS.length);
  });

  test('gives each key a value its schema accepts', () => {
    const defaults = builtInSettingDefaults({ persistentStorage: true });
    expect(settingsSchema.safeParse(defaults).success).toBe(true);
  });

  test('turns the durable engine on by default only over persistent storage', () => {
    expect(builtInSettingDefaults({ persistentStorage: true }).durable).toBe(true);
    expect(builtInSettingDefaults({ persistentStorage: false }).durable).toBe(false);
  });

  test('reads windows and limits in milliseconds and counts, as the settings take them', () => {
    const defaults = builtInSettingDefaults({ persistentStorage: true });
    expect(defaults['retention.events']).toEqual({ olderThan: 604_800_000 });
    expect(defaults['retention.tasks']).toEqual({ olderThan: 2_592_000_000 });
    expect(defaults['retention.receipts']).toEqual({ olderThan: 86_400_000 });
    expect(defaults['children.delegation.defaultTimeToLiveMilliseconds']).toBe(3_600_000);
    expect(defaults['engine.retentionSweepInterval']).toBe(300_000);
    expect(defaults['engine.checkpointHistory']).toBe(10);
    expect(defaults['logs.maximumLinesPerRun']).toBe(500);
  });
});
