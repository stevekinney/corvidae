/**
 * COR-1879 — `bureau.plugins`: the plugins composition loaded, their `afterStart`, and the listing.
 *
 * The listing is built fresh on every call from the descriptor's declared fields, never from the
 * descriptor itself, so it carries no schema, no function, no configuration value and no secret.
 *
 * @module plugin-registry
 */

import { formatToolId, fromNamespacedToolName, parseToolId } from 'armorer';

import type {
  PluginHostApi,
  PluginSetupContext,
  PluginSetupResult,
} from '@lostgradient/interborough-plugin';

import type {
  BureauPluginEntry,
  BureauPlugins,
  PluginContribution,
  PluginContributionListing,
  PluginContributionReferences,
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
  readonly contributions: readonly PluginContribution[];
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

const NO_REFERENCES: PluginContributionReferences = { agents: 0, schedules: 0, waitingRuns: 0 };

/**
 * The listing of one plugin, safe to serialize. `referencesOf` counts what names each
 * contribution; without it every count is zero.
 */
export function pluginListingOf(
  record: PluginRecord,
  laterProblems: readonly PluginProblem[] = [],
  referencesOf: (contribution: PluginContribution) => PluginContributionReferences = () =>
    NO_REFERENCES,
): PluginListing {
  const { descriptor } = record.entry;
  const { gate } = record;
  const missing = gate?.missing() ?? [];
  const contributions = record.contributions.map((contribution): PluginContributionListing => ({
    ...contribution,
    references: referencesOf(contribution),
  }));
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
      ...(record.entry.developmentPath === undefined
        ? []
        : [{ code: 'development-source', path: record.entry.developmentPath } as const]),
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
   * Reads the Bureau from now on: the agent listing, so a file a running plugin ships that names a
   * contribution nothing loaded holds is that plugin's `reference-unresolved`, and what names each
   * contribution, counted on every `list()`.
   */
  observe(reads: PluginReferenceReads): void;
  /**
   * Records that run `runId` waited on `pinned` (`plugin:name@version`), a version this Bureau
   * has not loaded, so that the plugin reports `pinned-version-unavailable`. A run is counted
   * once per pinned id however often it is noted; an id without a version is not a pin.
   */
  notePinnedUnavailable(pinned: string, runId: string): void;
}

/** What one ready agent's definition names. */
export interface PluginAgentReferences {
  /** The agent's identifier, as a schedule or a run names it. */
  readonly id: string;
  /** The tools it names. */
  readonly tools: readonly string[];
  /** The guardrails it names (a file's `guardrails`). */
  readonly guardrails: readonly string[];
  /** The run hook sets it names (a file's `hooks`). */
  readonly hooks: readonly string[];
}

/** A run waiting on a person, as one pending review shows it. */
export interface PluginWaitingRun {
  /** The run. */
  readonly runId: string;
  /** The agent the run is of, when the review names it. */
  readonly agentName: string | undefined;
  /** The tool a tool approval asks for, by the name the run called it. */
  readonly toolName: string | undefined;
}

/** The reads the registry counts references from, wired once the Bureau exists. */
export interface PluginReferenceReads {
  /** The agent listing. */
  readonly agents: () => readonly AgentListing[];
  /** What each ready agent's definition names. */
  readonly agentReferences: () => Promise<readonly PluginAgentReferences[]>;
  /** The agent of each schedule not cancelled; empty without a durable engine. */
  readonly scheduleAgents: () => Promise<readonly string[]>;
  /** The runs with a pending review. */
  readonly waitingRuns: () => readonly PluginWaitingRun[];
}

/**
 * `name` as `plugin:name`, whether it is written `plugin:name`, `plugin:name@version` or as a
 * provider's `plugin__name`; any other name as it is.
 */
function referenceKey(name: string): string {
  const namespaced = fromNamespacedToolName(name);
  if (namespaced !== undefined) return formatToolId(namespaced);
  try {
    const { namespace, name: bare } = parseToolId(name);
    return formatToolId({ namespace, name: bare });
  } catch {
    return name;
  }
}

/** Counts what names each contribution, from one read of each source. */
async function countReferences(
  reads: PluginReferenceReads | undefined,
): Promise<(contribution: PluginContribution) => PluginContributionReferences> {
  if (reads === undefined) return () => NO_REFERENCES;
  const [agents, scheduleAgents] = await Promise.all([
    reads.agentReferences(),
    reads.scheduleAgents(),
  ]);
  const waitingRuns = reads.waitingRuns();
  const namedBy = (agent: PluginAgentReferences, contribution: PluginContribution): boolean => {
    const names =
      contribution.kind === 'tool'
        ? agent.tools
        : contribution.kind === 'guardrail'
          ? agent.guardrails
          : contribution.kind === 'run-hooks'
            ? agent.hooks
            : [];
    const key = referenceKey(contribution.id);
    return names.some((name) => referenceKey(name) === key);
  };
  return (contribution) => {
    const users = new Set(
      agents.filter((agent) => namedBy(agent, contribution)).map((agent) => agent.id),
    );
    // A schedule or a run of the contribution itself, when it is a code agent.
    const runsIt = (agentName: string | undefined): boolean =>
      agentName !== undefined &&
      (users.has(agentName) ||
        (contribution.kind === 'code-agent' && agentName === contribution.id));
    const key = referenceKey(contribution.id);
    const waiting = new Set(
      waitingRuns
        .filter(
          (run) =>
            runsIt(run.agentName) ||
            (contribution.kind === 'tool' &&
              run.toolName !== undefined &&
              referenceKey(run.toolName) === key),
        )
        .map(({ runId }) => runId),
    );
    return {
      agents: users.size,
      schedules: scheduleAgents.filter((agentName) => runsIt(agentName)).length,
      waitingRuns: waiting.size,
    };
  };
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
  let reads: PluginReferenceReads | undefined;
  const started = Promise.withResolvers<void>();
  const problemsOf = (record: PluginRecord): PluginProblem[] => {
    const name = record.entry.descriptor.name;
    return [
      ...(record.status === 'running' && reads !== undefined
        ? referenceProblemsOf(name, reads.agents())
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
      list: async () => {
        const referencesOf = await countReferences(reads);
        return records.map((record) => pluginListingOf(record, problemsOf(record), referencesOf));
      },
      registered: () =>
        records
          .filter((record) => record.status === 'running')
          .map((record) => record.entry.descriptor.name),
      mcpApps: () =>
        records.flatMap((record) =>
          record.status === 'running'
            ? (record.setup?.result.mcpApps ?? []).map((app) => ({
                plugin: record.entry.descriptor.name,
                version: record.entry.descriptor.version,
                app,
              }))
            : [],
        ),
      ready: () => started.promise,
    },
    observe(given) {
      reads = given;
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
