/**
 * The one mirror `retention-window.ts` keeps of the Bureau: which retention windows cannot be kept
 * forever, and the window in force for one the Bureau publishes no default for. A window cannot be
 * kept forever when its schema has no `'forever'` to store and leaving it unset still deletes: its
 * built-in default is a finite window, or, with no default, the owning package prunes by its own
 * window (Memory's episodic retention). The settings schema the Bureau publishes carries no
 * defaults, so these tests derive the list from the schema, the Bureau's defaults and Memory's
 * policy, and fail when any of them moves.
 */
import { builtInSettingDefaults, SETTINGS_WITHOUT_DEFAULT } from '@lostgradient/bureau';
import { DEFAULT_EPISODIC_RETENTION_MILLISECONDS } from '@lostgradient/memory';
import { describe, expect, test } from 'bun:test';

import type { SchemaNode } from '../../../lib/bureau-settings.ts';
import { PUBLISHED_SCHEMA } from '../settings-fixtures.test-support.ts';
import {
  isRetentionWindowNode,
  RETENTION_IN_FORCE_WHILE_UNSET,
  RETENTION_WITHOUT_KEEP_FOREVER,
} from './retention-window.ts';

const windows = Object.entries(PUBLISHED_SCHEMA.properties).filter(
  ([key, node]) => key.startsWith('retention.') && isRetentionWindowNode(node),
);

const takesForever = (node: SchemaNode) =>
  (node.anyOf ?? []).some((option) => option.const === 'forever');

const defaults: Record<string, unknown> = builtInSettingDefaults({ persistentStorage: true });
const withoutDefault = new Set<string>(SETTINGS_WITHOUT_DEFAULT);

/**
 * The windows with no default that the Bureau leaves alone while unset: log lines stay with their
 * run, notifications up to a count, hook deliveries with their hook (`create-bureau.ts`,
 * `pruneWorkflowLogs`, `pruneNotifications`, `pruneHookDeliveries`). A new window with no default
 * fails the derivation below until it is named here or in `RETENTION_IN_FORCE_WHILE_UNSET`.
 */
const KEPT_WHILE_UNSET = ['retention.hookDeliveries', 'retention.logs', 'retention.notifications'];

/** Whether leaving `key` unset still deletes records, and so cannot stand for keeping them. */
function prunesWhileUnset(key: string): boolean {
  if (!withoutDefault.has(key)) {
    const fallback = defaults[key];
    return typeof fallback === 'object' && fallback !== null && 'olderThan' in fallback;
  }
  return RETENTION_IN_FORCE_WHILE_UNSET.has(key);
}

describe('RETENTION_WITHOUT_KEEP_FOREVER', () => {
  test('finds the retention windows the Bureau publishes', () => {
    expect(windows.map(([key]) => key)).toContain('retention.receipts');
    expect(windows.length).toBeGreaterThanOrEqual(9);
  });

  test('names exactly the windows with no forever in the schema whose unset value prunes', () => {
    const derived = windows
      .filter(([key, node]) => !takesForever(node) && prunesWhileUnset(key))
      .map(([key]) => key)
      .toSorted();
    expect(derived).toEqual([...RETENTION_WITHOUT_KEEP_FOREVER].toSorted());
    expect(derived).toEqual(['retention.memory', 'retention.receipts']);
  });

  test('every window with no forever and no default is either kept or pruned while unset, by name', () => {
    const unnamed = windows
      .filter(([key, node]) => !takesForever(node) && withoutDefault.has(key))
      .map(([key]) => key)
      .filter((key) => !RETENTION_IN_FORCE_WHILE_UNSET.has(key) && !KEPT_WHILE_UNSET.includes(key));
    expect(unnamed).toEqual([]);
  });
});

describe('RETENTION_IN_FORCE_WHILE_UNSET', () => {
  test('Memory falls back to the memory policy’s episodic window', () => {
    expect(RETENTION_IN_FORCE_WHILE_UNSET.get('retention.memory')).toEqual({
      olderThan: DEFAULT_EPISODIC_RETENTION_MILLISECONDS,
    });
  });

  test('names only windows the Bureau publishes no default for', () => {
    for (const key of RETENTION_IN_FORCE_WHILE_UNSET.keys())
      expect(withoutDefault.has(key)).toBe(true);
  });
});
