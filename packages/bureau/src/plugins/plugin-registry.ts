/**
 * COR-1879 — `bureau.plugins`: the plugins composition loaded, their `afterStart`, and the listing.
 *
 * The listing is built fresh on every call from the descriptor's declared fields, never from the
 * descriptor itself, so it carries no schema, no function, no configuration value and no secret.
 *
 * @module plugin-registry
 */

import { formatToolId, fromNamespacedToolName, parseToolId } from 'armorer';
import { z } from 'zod';

import {
  isGuardrailFactory,
  type PluginGuardrails,
  type PluginHostApi,
  type PluginSetupContext,
  type PluginSetupResult,
} from '@lostgradient/interborough-plugin';
import { guardrailOf } from '@lostgradient/operative';

import type { AgentContributions } from '../agent-contributions';
import type {
  BureauPluginEntry,
  BureauPlugins,
  GuardrailListing,
  PluginContribution,
  PluginContributionListing,
  PluginContributionReferences,
  PluginReactionListing,
  PluginProviderListing,
  PluginListing,
  PluginProblem,
  PluginStatus,
  PluginTriggerListing,
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
      title: descriptor.title ?? descriptor.name,
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
  /** The interceptors it names (a file's `interceptors`). */
  readonly interceptors: readonly string[];
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
          : contribution.kind === 'interceptor'
            ? agent.interceptors
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
      (users.has(agentName) || (contribution.kind === 'agent' && agentName === contribution.id));
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

/**
 * A configuration schema as JSON Schema for a client that draws its fields, or `null` when Zod
 * cannot write it as one (a transform, say). It describes what a person types, so the input side.
 */
function jsonSchemaOf(schema: z.ZodType): Readonly<Record<string, unknown>> | null {
  try {
    return z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
  } catch {
    return null;
  }
}

/** One guardrail's row: its description, and its configuration schema when it is a factory. */
function guardrailRow(
  plugin: string,
  family: GuardrailListing['family'],
  guardrail: unknown,
  source: GuardrailListing['source'],
): GuardrailListing {
  const { name, description } = guardrail as {
    readonly name: string;
    readonly description?: string;
  };
  const configurable = isGuardrailFactory(guardrail);
  return {
    id: formatToolId({ namespace: plugin, name }),
    family,
    description: description ?? '',
    configurable,
    configuration: configurable ? jsonSchemaOf(guardrail.configuration) : null,
    source,
    plugin,
  };
}

/** The guardrails a plugin's setup returned, family by family. */
function pluginGuardrailRows(
  plugin: string,
  guardrails: PluginGuardrails | undefined,
  keep: (family: GuardrailListing['family'], name: string) => boolean,
): GuardrailListing[] {
  const rows = (family: GuardrailListing['family'], items: readonly unknown[] | undefined) =>
    (items ?? [])
      .map((entry) => guardrailOf(entry) as { name: string })
      .filter((guardrail) => keep(family, guardrail.name))
      .map((guardrail) => guardrailRow(plugin, family, guardrail, 'plugin'));
  return [
    ...rows('input', guardrails?.input),
    ...rows('output', guardrails?.output),
    ...rows('tools', guardrails?.tools),
    ...rows('memory', guardrails?.memory),
  ];
}

/**
 * The guardrails the host gave the Bureau (`BureauOptions.agentContributions`), family by family,
 * as `bureau.plugins.guardrails()` lists them. Read when the Bureau is built, before it awaits
 * anything, so a caller that changes its own map afterwards does not change the listing.
 */
export function hostGuardrailRows(host: AgentContributions | undefined): GuardrailListing[] {
  return [...(host?.guardrails.values() ?? [])].flatMap(
    ({ plugin, inputDetector, outputValidator, toolValidator }) => [
      ...(inputDetector === undefined
        ? []
        : [guardrailRow(plugin, 'input', guardrailOf(inputDetector), 'host')]),
      ...(outputValidator === undefined
        ? []
        : [guardrailRow(plugin, 'output', guardrailOf(outputValidator), 'host')]),
      ...(toolValidator === undefined
        ? []
        : [guardrailRow(plugin, 'tools', toolValidator, 'host')]),
    ],
  );
}

/** Whether `record` registered the contribution `kind` named `plugin:name`. */
function registered(record: PluginRecord, kind: PluginContribution['kind'], name: string): boolean {
  const id = `${record.entry.descriptor.name}:${name}`;
  return record.contributions.some(
    (contribution) => contribution.kind === kind && contribution.id === id,
  );
}

/** The registry over the records composition produced. */
export function createPluginRegistry(
  records: readonly PluginRecord[],
  hostListing: {
    /** The rows of the guardrails the host gave the Bureau ({@link hostGuardrailRows}), listed first. */
    readonly guardrails?: readonly GuardrailListing[] | undefined;
  } = {},
): PluginRegistry {
  const hostGuardrails = [...(hostListing.guardrails ?? [])];
  const laterProblems = new Map<string, PluginProblem[]>();
  // The panels the host could not build, by plugin name, then app name, with the message.
  const failedApps = new Map<string, Map<string, string>>();
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
      ...[...(failedApps.get(name) ?? [])].map(([app, message]): PluginProblem => ({
        code: 'panel-failed',
        app,
        message,
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
      panels: () =>
        records.flatMap((record) =>
          record.status === 'running'
            ? (record.setup?.result.panels ?? [])
                .filter((app) => !failedApps.get(record.entry.descriptor.name)?.has(app.name))
                .map((app) => ({
                  plugin: record.entry.descriptor.name,
                  version: record.entry.descriptor.version,
                  app,
                }))
            : [],
        ),
      triggers: () =>
        records.flatMap((record): PluginTriggerListing[] =>
          record.status === 'running'
            ? (record.setup?.result.triggers ?? [])
                .filter((kind) => registered(record, 'trigger', kind.name))
                .map((kind) => ({
                  plugin: record.entry.descriptor.name,
                  id: `${record.entry.descriptor.name}:${kind.name}`,
                  description: kind.description,
                  version: kind.version ?? record.entry.descriptor.version,
                  configuration: jsonSchemaOf(kind.configuration),
                }))
            : [],
        ),
      reactions: () =>
        records.flatMap((record): PluginReactionListing[] =>
          record.status === 'running'
            ? (record.setup?.result.reactions ?? [])
                .filter((kind) => registered(record, 'reaction', kind.name))
                .map((kind) => ({
                  plugin: record.entry.descriptor.name,
                  kind: kind.name,
                  description: kind.description,
                  version: kind.version ?? record.entry.descriptor.version,
                  configuration: jsonSchemaOf(kind.configuration),
                }))
            : [],
        ),
      providers: () =>
        records.flatMap((record): PluginProviderListing[] =>
          record.status === 'running'
            ? (record.setup?.result.providers ?? [])
                .filter((provider) => registered(record, 'provider', provider.name))
                .map((provider) => ({
                  plugin: record.entry.descriptor.name,
                  name: provider.name,
                  configuration: jsonSchemaOf(
                    record.entry.descriptor.configuration ?? z.object({}),
                  ),
                }))
            : [],
        ),
      guardrails: () => [
        ...hostGuardrails,
        ...records.flatMap((record): GuardrailListing[] =>
          record.status === 'running'
            ? pluginGuardrailRows(
                record.entry.descriptor.name,
                record.setup?.result.guardrails,
                (family, name) =>
                  registered(record, family === 'memory' ? 'memory-detector' : 'guardrail', name),
              )
            : [],
        ),
      ],
      reportPanelFailure: (plugin, app, message) => {
        const record = records.find(
          (candidate) =>
            candidate.status === 'running' && candidate.entry.descriptor.name === plugin,
        );
        const declared = record?.setup?.result.panels?.some((each) => each.name === app);
        if (record?.setup === undefined || declared !== true) return;
        const byApp = failedApps.get(plugin) ?? new Map<string, string>();
        failedApps.set(plugin, byApp);
        if (!byApp.has(app)) byApp.set(app, record.setup.redact(message));
      },
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
