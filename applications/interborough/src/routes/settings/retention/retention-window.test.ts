/**
 * The one mirror `retention-window.ts` keeps of the Bureau: which retention windows cannot be kept
 * for ever. The settings schema the Bureau publishes carries no defaults, so the list is held here
 * and these tests fail when the Bureau's schema or defaults move away from it.
 */
import { builtInSettingDefaults, SETTINGS_WITHOUT_DEFAULT } from '@lostgradient/bureau';
import { describe, expect, test } from 'bun:test';

import type { SchemaNode } from '../../../lib/bureau-settings.ts';
import { PUBLISHED_SCHEMA } from '../settings-fixtures.test-support.ts';
import { isRetentionWindowNode, RETENTION_WITHOUT_KEEP_FOREVER } from './retention-window.ts';

const windows = Object.entries(PUBLISHED_SCHEMA.properties).filter(
  ([key, node]) => key.startsWith('retention.') && isRetentionWindowNode(node),
);

const takesForever = (node: SchemaNode) =>
  (node.anyOf ?? []).some((option) => option.const === 'forever');

describe('RETENTION_WITHOUT_KEEP_FOREVER', () => {
  test('finds the retention windows the Bureau publishes', () => {
    expect(windows.map(([key]) => key)).toContain('retention.receipts');
    expect(windows.length).toBeGreaterThanOrEqual(9);
  });

  test('names exactly the windows with no forever to store and a finite built-in default', () => {
    const without = new Set<string>(SETTINGS_WITHOUT_DEFAULT);
    const derived = windows
      .filter(([key, node]) => !takesForever(node) && !without.has(key))
      .map(([key]) => key)
      .toSorted();
    expect(derived).toEqual([...RETENTION_WITHOUT_KEEP_FOREVER].toSorted());
  });

  test('each of them has a finite window as its built-in default', () => {
    const defaults: Record<string, unknown> = builtInSettingDefaults({ persistentStorage: true });
    for (const key of RETENTION_WITHOUT_KEEP_FOREVER) {
      expect(defaults[key]).toEqual({ olderThan: expect.any(Number) });
    }
  });
});
