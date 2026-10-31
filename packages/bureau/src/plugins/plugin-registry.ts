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
    /** Points the context's `host` at the plugin's own host API once the Bureau exists. */
    readonly bindHost: (host: PluginHostApi) => void;
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
   * Binds each running plugin's `host` to the API `hostFor` builds for it, then runs `afterStart`
   * once for each, in load order, each after the one before has settled, with that same API. A
   * rejection becomes that plugin's `after-start-failed` problem; it never rejects.
   */
  start(hostFor: (plugin: string) => PluginHostApi): Promise<void>;
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
    async start(hostFor) {
      const hosts = new Map<string, PluginHostApi>();
      for (const record of records) {
        if (record.setup === undefined) continue;
        const host = hostFor(record.entry.descriptor.name);
        hosts.set(record.entry.descriptor.name, host);
        record.setup.bindHost(host);
      }
      for (const record of records) {
        const { setup } = record;
        const host = hosts.get(record.entry.descriptor.name);
        if (setup?.result.afterStart === undefined || host === undefined) continue;
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

/**
 * A host API for `plugin`'s setup context that forwards to the one {@link PluginRegistry.start}
 * binds, so a contribution built in `setup` can hold it before the Bureau exists. A call before
 * the bind rejects.
 */
export function lateHostApi(plugin: string): {
  readonly api: PluginHostApi;
  readonly bind: (host: PluginHostApi) => void;
} {
  let bound: PluginHostApi | undefined;
  const host = (): PluginHostApi => {
    if (bound === undefined) {
      throw new Error(`The host of plugin "${plugin}" has not started yet.`);
    }
    return bound;
  };
  return {
    api: {
      agents: { list: () => host().agents.list() },
      schedules: {
        create: async (definition) => host().schedules.create(definition),
        list: async (filter) => host().schedules.list(filter),
      },
      goals: { create: async (request) => host().goals.create(request) },
    },
    bind: (given) => {
      bound = given;
    },
  };
}
