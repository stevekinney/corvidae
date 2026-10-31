/**
 * COR-1879 — `bureau.plugins`: the plugins composition loaded, their `afterStart`, and the listing.
 *
 * The listing is built fresh on every call from the descriptor's declared fields, never from the
 * descriptor itself, so it carries no schema, no function, no configuration value and no secret.
 *
 * @module plugin-registry
 */

import { formatToolId, parseToolId } from 'armorer';

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
import type { AgentListing } from '../agent-file-catalog';
import type { PluginSecretGate } from './plugin-secret-gate';

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
  /** Whether the secrets it declared are set; absent when it declares none or does not run. */
  readonly gate?: PluginSecretGate;
  /**
   * What `setup` returned, the context it ran with, and `redact`, which removes every secret value
   * the plugin was handed from a message; set for a running plugin.
   */
  readonly setup?: {
    readonly result: PluginSetupResult;
    readonly context: PluginSetupContext;
    readonly redact: (message: string) => string;
  };
}

/** The listing of one plugin, safe to serialize. */
export function pluginListingOf(
  record: PluginRecord,
  laterProblems: readonly PluginProblem[] = [],
): PluginListing {
  const { descriptor } = record.entry;
  const { gate } = record;
  const missing = gate?.missing() ?? [];
  const contributions = [...record.contributions];
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
    status: record.status === 'running' && missing.length > 0 ? 'needs-setup' : record.status,
    problems: [
      ...record.problems,
      ...missing.map((key): PluginProblem => ({
        code: 'secret-missing',
        key,
        contributions: contributions.map(({ id }) => id),
      })),
      ...laterProblems,
    ],
    contributions,
  };
}

/** `bureau.plugins`, and the calls that feed it once the Bureau exists. */
export interface PluginRegistry {
  /** The value served as `bureau.plugins`. */
  readonly plugins: BureauPlugins;
  /**
   * Runs `afterStart` once for each running plugin, in load order, each after the one before has
   * settled. A rejection becomes that plugin's `after-start-failed` problem; it never rejects.
   */
  start(host: PluginHostApi): Promise<void>;
  /**
   * Reads the agent listing from now on, so a file a running plugin ships that names a
   * contribution nothing loaded holds is that plugin's `reference-unresolved`.
   */
  observeAgents(list: () => readonly AgentListing[]): void;
  /**
   * Records that run `runId` waited on `pinned` (`plugin:name@version`), a version this Bureau
   * has not loaded, so that the plugin reports `pinned-version-unavailable`. A run is counted
   * once per pinned id however often it is noted; an id without a version is not a pin.
   */
  notePinnedUnavailable(pinned: string, runId: string): void;
}

/** The `reference-unresolved` problems of the files `plugin` ships, from the agent listing. */
function referenceProblemsOf(plugin: string, agents: readonly AgentListing[]): PluginProblem[] {
  const problems: PluginProblem[] = [];
  for (const agent of agents) {
    if (agent.plugin !== plugin || agent.state !== 'invalid') continue;
    const { problem } = agent;
    if (problem?.code !== 'unknown-tool' && problem?.code !== 'reference-unresolved') continue;
    for (const issue of problem.issues ?? []) {
      if (issue.reference === undefined) continue;
      problems.push({ code: 'reference-unresolved', file: agent.id, id: issue.reference });
    }
  }
  return problems;
}

/** The waiting runs of each unavailable pinned version, by plugin, then by `plugin:name@version`. */
type PinnedTally = Map<string, Map<string, { id: string; version: string; runs: Set<string> }>>;

/** The registry over the records composition produced. */
export function createPluginRegistry(records: readonly PluginRecord[]): PluginRegistry {
  const laterProblems = new Map<string, PluginProblem[]>();
  const pinned: PinnedTally = new Map();
  let agents: (() => readonly AgentListing[]) | undefined;
  const started = Promise.withResolvers<void>();
  const problemsOf = (record: PluginRecord): PluginProblem[] => {
    const name = record.entry.descriptor.name;
    return [
      ...(record.status === 'running' && agents !== undefined
        ? referenceProblemsOf(name, agents())
        : []),
      ...[...(pinned.get(name)?.values() ?? [])].map(({ id, version, runs }): PluginProblem => ({
        code: 'pinned-version-unavailable',
        id,
        version,
        waitingRuns: runs.size,
      })),
      ...(laterProblems.get(name) ?? []),
    ];
  };
  return {
    plugins: {
      list: () => records.map((record) => pluginListingOf(record, problemsOf(record))),
      ready: () => started.promise,
    },
    observeAgents(list) {
      agents = list;
    },
    notePinnedUnavailable(pinnedId, runId) {
      let identity: ReturnType<typeof parseToolId>;
      try {
        identity = parseToolId(pinnedId);
      } catch {
        return;
      }
      if (identity.version === undefined) return;
      const id = formatToolId({ namespace: identity.namespace, name: identity.name });
      const byId = pinned.get(identity.namespace) ?? new Map();
      pinned.set(identity.namespace, byId);
      const key = formatToolId(identity);
      const entry = byId.get(key) ?? { id, version: identity.version, runs: new Set<string>() };
      byId.set(key, entry);
      entry.runs.add(runId);
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
              message: setup.redact(error instanceof Error ? error.message : String(error)),
            },
          ]);
        }
      }
      started.resolve();
    },
  };
}
