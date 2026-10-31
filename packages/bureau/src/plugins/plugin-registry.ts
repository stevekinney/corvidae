/**
 * COR-1879 — `bureau.plugins`: the plugins composition loaded, their `afterStart`, and the listing.
 *
 * The listing is built fresh on every call from the descriptor's declared fields, never from the
 * descriptor itself, so it carries no schema, no function, no configuration value and no secret.
 *
 * @module plugin-registry
 */

import type {
  PluginHostApi,
  PluginSetupContext,
  PluginSetupResult,
} from '@lostgradient/interborough-plugin';

import type {
  BureauPluginEntry,
  BureauPlugins,
  PluginContributionListing,
  PluginListing,
  PluginProblem,
  PluginStatus,
} from './plugin-types';

/** What composition found for one plugin. */
export interface PluginRecord {
  /** The plugin as the host gave it. */
  readonly entry: BureauPluginEntry;
  /** Its status once composition finished. */
  readonly status: PluginStatus;
  /** What composition found wrong. */
  readonly problems: readonly PluginProblem[];
  /** What it registered. */
  readonly contributions: readonly PluginContributionListing[];
  /** What `setup` returned and the context it ran with; set for a running plugin. */
  readonly setup?: {
    readonly result: PluginSetupResult;
    readonly context: PluginSetupContext;
  };
}

/** The listing of one plugin, safe to serialize. */
export function pluginListingOf(
  record: PluginRecord,
  laterProblems: readonly PluginProblem[] = [],
): PluginListing {
  const { descriptor } = record.entry;
  return {
    descriptor: {
      name: descriptor.name,
      version: descriptor.version,
      description: descriptor.description,
      required: descriptor.required === true,
      enabledByDefault: descriptor.enabledByDefault ?? true,
      secrets: (descriptor.secrets ?? []).map((declaration) =>
        typeof declaration === 'string'
          ? { key: declaration, generated: false }
          : { key: declaration.key, generated: declaration.generated === true },
      ),
    },
    source: record.entry.source,
    location: record.entry.location,
    status: record.status,
    problems: [...record.problems, ...laterProblems],
    contributions: [...record.contributions],
  };
}

/** `bureau.plugins`, and the call that starts the running plugins once the Bureau exists. */
export interface PluginRegistry {
  /** The value served as `bureau.plugins`. */
  readonly plugins: BureauPlugins;
  /**
   * Runs `afterStart` once for each running plugin, in load order, each after the one before has
   * settled. A rejection becomes that plugin's `after-start-failed` problem; it never rejects.
   */
  start(host: PluginHostApi): Promise<void>;
}

/** The registry over the records composition produced. */
export function createPluginRegistry(records: readonly PluginRecord[]): PluginRegistry {
  const laterProblems = new Map<string, PluginProblem[]>();
  const started = Promise.withResolvers<void>();
  return {
    plugins: {
      list: () =>
        records.map((record) =>
          pluginListingOf(record, laterProblems.get(record.entry.descriptor.name)),
        ),
      ready: () => started.promise,
    },
    async start(host) {
      for (const record of records) {
        const { setup } = record;
        if (setup?.result.afterStart === undefined) continue;
        try {
          await setup.result.afterStart(host, setup.context);
        } catch (error) {
          laterProblems.set(record.entry.descriptor.name, [
            {
              code: 'after-start-failed',
              message: error instanceof Error ? error.message : String(error),
            },
          ]);
        }
      }
      started.resolve();
    },
  };
}
