/**
 * Which module reads each live setting (COR-1710).
 *
 * A `live` key only does something if a module reads it through the settings at its point of use,
 * and a key nobody reads is a setting that silently does nothing. `setting-owners.test.ts` holds
 * this registry to the schema: every key is owned by one module that reads it through the
 * settings, or is declared `restart`, so adding a key to {@link settingsSchema} without wiring it
 * fails there.
 *
 * @module setting-owners
 */

import { ENGINE_PATCH_FIELDS } from './settings-schema.ts';
import type { SettingKey } from './settings-schema.ts';

/** One module and the live keys it reads through the settings. */
export interface SettingOwner {
  /** A name for the reader, for the failure message. */
  readonly name: string;
  /** The module that reads the keys, as a path from `packages/bureau/src`. */
  readonly module: string;
  /** The keys it reads. */
  readonly keys: readonly SettingKey[];
  /**
   * How it reads them: `literal` reads each key by name through the settings; `patch-table` hands
   * every key of {@link ENGINE_PATCH_FIELDS} to `engine.reconfigure`, so its keys are that table's.
   */
  readonly reads: 'literal' | 'patch-table';
}

/** The owner of every live key. */
export const SETTING_OWNERS: readonly SettingOwner[] = [
  {
    name: 'tool grants',
    module: 'settings/settings-options.ts',
    keys: ['tools.humanInput', 'tools.wakeup', 'tools.decide'],
    reads: 'literal',
  },
  {
    name: 'model policy',
    module: 'settings/settings-options.ts',
    keys: ['modelPolicy'],
    reads: 'literal',
  },
  {
    name: 'decisions',
    module: 'decisions/create-decisions.ts',
    keys: ['decisions.model', 'decisions.fallbackModel', 'decisions.maximumPerTask'],
    reads: 'literal',
  },
  {
    name: 'compaction summarizer',
    module: 'models/create-models.ts',
    keys: ['context.summarizerModel'],
    reads: 'literal',
  },
  {
    name: 'retention',
    module: 'create-bureau.ts',
    keys: [
      'retention.audit',
      'retention.events',
      'retention.tasks',
      'retention.receipts',
      'retention.memory',
      'retention.logs',
      'retention.checkpoints',
    ],
    reads: 'literal',
  },
  {
    name: 'workflow log lines per run',
    module: 'create-bureau.ts',
    keys: ['logs.maximumLinesPerRun'],
    reads: 'literal',
  },
  {
    name: 'session input, live at the next admission',
    module: 'create-bureau.ts',
    keys: ['sessionInput.principalBacklogLimit'],
    reads: 'literal',
  },
  {
    // Owner decision (COR-1710 revision 2026-10-27): read when a session's mailbox is built, so a
    // running session keeps its limit and Weft's cross-process backlog check stays atomic.
    name: 'session input, live from the next session',
    module: 'create-bureau.ts',
    keys: ['sessionInput.sessionBacklogLimit'],
    reads: 'literal',
  },
  {
    name: 'child delegation',
    module: 'create-bureau.ts',
    keys: ['children.delegation.defaultTimeToLiveMilliseconds'],
    reads: 'literal',
  },
  {
    name: 'engine reconfigure',
    module: 'settings/settings-options.ts',
    keys: Object.keys(ENGINE_PATCH_FIELDS) as SettingKey[],
    reads: 'patch-table',
  },
];
