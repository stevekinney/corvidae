/**
 * COR-1879 — plugin composition: what `createBureau` does with `plugins` before anything else.
 *
 * Plugins load in the P-COR-96 order: package plugins in the order the host gives them, then folder
 * plugins by folder name. Each enabled plugin's configuration is parsed, its `setup` runs once with
 * storage confined to `plugin:<name>:`, and what it returns is checked against every name already
 * held (Bureau's own, the host's, and earlier plugins'). The first holder of a name keeps it: a
 * later plugin that claims a held name is `skipped` whole with `name-clash`, so none of its
 * contributions is registered. A plugin that passes registers every contribution through the
 * option it belongs to (`contributionCatalog`, `agentContributions`, `validators`, `hooks`,
 * `eventFormatters`, `decisions`, `onlineEvals`, the agent catalog, the agent tool catalog and the
 * `memory` factory), so the rest of construction never needs to know a plugin was involved.
 *
 * @module compose-plugins
 */

import type {
  PluginContributions,
  PluginSecrets,
  PluginSetupContext,
  PluginSetupResult,
} from '@lostgradient/interborough-plugin';
import { createPluginStorage } from '@lostgradient/interborough-plugin';
import type { GovernedMemory } from '@lostgradient/memory';
import { MemoryStorage, type Storage } from '@lostgradient/storage';
import { formatToolId, type Tool } from 'armorer';

import type { AgentDefinitions } from '../agent-catalog';
import type { AgentContributions } from '../agent-contributions';
import type { AgentSource } from '../sources/definition-source';
import { createAgentContributions } from '../agent-contributions';
import type { BureauOptions } from '../types';
import {
  createVersionedCatalog,
  VERSIONED_CATALOG_KINDS,
  type VersionedCatalog,
} from '../versioned-catalog';
import { createClaims, type Claim, type Claims } from './plugin-claims';
import type { PluginRecord } from './plugin-registry';
import { pluginTool } from './plugin-tools';
import type {
  BureauPluginEntry,
  BureauPluginSettings,
  PluginClashParty,
  PluginContributionListing,
  PluginMemoryContributions,
  PluginProblem,
} from './plugin-types';

/** The options composition reads: `BureauOptions` once its definition sources are layered into one. */
export type ComposableOptions = Omit<BureauOptions, 'agentSource' | 'agents'> & {
  readonly agentSource?: AgentSource | undefined;
  readonly agents?: AgentDefinitions | undefined;
};

/** What composition hands the rest of construction. */
export interface ComposedPlugins<O extends ComposableOptions> {
  /** The options with every running plugin's contributions folded in, and `memory` built. */
  readonly options: O;
  /** The contributed tools, by the `plugin:name` an agent file names them with. */
  readonly tools: Readonly<Record<string, Tool>>;
  /** Every plugin, in load order, with what composition found. */
  readonly records: readonly PluginRecord[];
}

const HOST_PARTY: PluginClashParty = Object.freeze({ source: 'built-in', location: 'host' });

function folderName(location: string): string {
  const segments = location.split(/[/\\]/u).filter((segment) => segment !== '');
  return segments.at(-1) ?? location;
}

/** Package plugins in the order given, then folder plugins by folder name. */
export function pluginLoadOrder(entries: readonly BureauPluginEntry[]): BureauPluginEntry[] {
  const packages = entries.filter((entry) => entry.source === 'package');
  const folders = entries
    .filter((entry) => entry.source === 'folder')
    .toSorted((a, b) => {
      const left = folderName(a.location);
      const right = folderName(b.location);
      return left < right ? -1 : left > right ? 1 : 0;
    });
  return [...packages, ...folders];
}

function settingsOf(
  settings: Readonly<Record<string, BureauPluginSettings>> | undefined,
  name: string,
): BureauPluginSettings {
  return settings !== undefined && Object.hasOwn(settings, name) ? (settings[name] ?? {}) : {};
}

function isEnabled(entry: BureauPluginEntry, settings: BureauPluginSettings): boolean {
  if (entry.descriptor.required === true) return true;
  return settings.enabled ?? entry.descriptor.enabledByDefault ?? true;
}

function configurationProblems(
  entry: BureauPluginEntry,
  settings: BureauPluginSettings,
): { readonly value: unknown } | { readonly problems: PluginProblem[] } {
  const schema = entry.descriptor.configuration;
  const given = settings.configuration ?? {};
  if (schema === undefined) return { value: given };
  const parsed = schema.safeParse(given);
  if (parsed.success) return { value: parsed.data };
  return {
    problems: parsed.error.issues.map((issue) => ({
      code: 'configuration-invalid',
      field: issue.path.map(String).join('.'),
      message: issue.message,
    })),
  };
}

function secretKeysOf(entry: BureauPluginEntry): ReadonlySet<string> {
  return new Set(
    (entry.descriptor.secrets ?? []).map((declaration) =>
      typeof declaration === 'string' ? declaration : declaration.key,
    ),
  );
}

/** The plugin's view of the secrets: only the keys it declared. */
function pluginSecretsOf(
  entry: BureauPluginEntry,
  secrets: BureauOptions['pluginSecrets'],
): PluginSecrets {
  const declared = secretKeysOf(entry);
  return {
    get: async (key) => {
      if (!declared.has(key)) {
        throw new TypeError(
          `Plugin "${entry.descriptor.name}" did not declare the secret "${key}".`,
        );
      }
      return secrets === undefined ? undefined : await secrets.get(key);
    },
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What the plugin claims and registers, before it is checked against what is held. */
interface PluginContributionPlan {
  readonly claims: readonly Claim[];
  readonly listings: readonly PluginContributionListing[];
  readonly tools: ReadonlyMap<string, Tool>;
}

function planOf(
  plugin: string,
  version: string,
  contributions: PluginContributions,
): PluginContributionPlan {
  const claims: Claim[] = [];
  const listings: PluginContributionListing[] = [];
  const tools = new Map<string, Tool>();
  const contribute = (kind: PluginContributionListing['kind'], name: string, id?: string) => {
    const contributionId = id ?? formatToolId({ namespace: plugin, name });
    claims.push({ space: kind, name: formatToolId({ namespace: plugin, name }) });
    listings.push({ kind, id: contributionId });
  };
  for (const tool of contributions.tools ?? []) {
    const rebuilt = pluginTool(tool, plugin, version);
    tools.set(formatToolId({ namespace: plugin, name: rebuilt.name }), rebuilt);
    contribute('tool', rebuilt.name, rebuilt.id);
  }
  for (const activity of contributions.activities ?? []) contribute('activity', activity.name);
  for (const kind of contributions.triggerKinds ?? []) contribute('trigger-kind', kind.name);
  for (const validator of contributions.validators ?? []) {
    contribute('validator', validator.identity.name);
  }
  for (const detector of contributions.guardrails?.inputDetectors ?? []) {
    contribute('guardrail', detector.name);
  }
  for (const validator of contributions.guardrails?.outputValidators ?? []) {
    contribute('guardrail', validator.name);
  }
  for (const hooks of contributions.runHooks ?? []) contribute('run-hooks', hooks.name);
  for (const model of contributions.decisionRouters ?? [])
    contribute('decision-router', model.name);
  for (const kind of contributions.hookActionKinds ?? []) contribute('hook-action', kind.name);
  for (const provider of contributions.providers ?? []) contribute('provider', provider.name);
  for (const embedder of contributions.embedders ?? []) contribute('embedder', embedder.name);
  for (const detector of contributions.memoryDetectors ?? []) {
    contribute('memory-detector', detector.name);
  }
  for (const judge of contributions.evalJudges ?? []) contribute('eval-judge', judge.name);
  for (const app of contributions.mcpApps ?? []) contribute('mcp-app', app.name);
  for (const formatter of contributions.eventFormatters ?? []) {
    contribute('event-formatter', formatter.name);
    for (const kind of formatter.eventKinds) claims.push({ space: 'event-kind', name: kind });
  }
  for (const agent of contributions.codeAgents ?? []) contribute('code-agent', agent.name);
  return { claims, listings, tools };
}

/** Everything the host already holds, which no plugin may take. */
function heldByHost(options: ComposableOptions): Claims {
  const claims = createClaims();
  // A plugin tool is keyed `plugin:name` in the agent tool catalog, the name a file and the model
  // use, so only a host tool keyed the same way can take its name.
  for (const key of Object.keys(options.agentSource?.tools ?? {})) {
    claims.hold({ space: 'tool', name: key }, HOST_PARTY);
  }
  for (const entry of options.contributionCatalog?.entries('activity') ?? []) {
    claims.hold({ space: 'activity', name: entry.name }, HOST_PARTY);
  }
  for (const entry of options.contributionCatalog?.entries('trigger-kind') ?? []) {
    claims.hold({ space: 'trigger-kind', name: entry.name }, HOST_PARTY);
  }
  for (const validator of options.validators ?? []) {
    claims.hold({ space: 'validator', name: validator.identity.name }, HOST_PARTY);
  }
  for (const id of options.agentContributions?.guardrails.keys() ?? []) {
    claims.hold({ space: 'guardrail', name: id }, HOST_PARTY);
  }
  for (const id of options.agentContributions?.runHooks.keys() ?? []) {
    claims.hold({ space: 'run-hooks', name: id }, HOST_PARTY);
  }
  for (const name of Object.keys(options.decisions?.models ?? {})) {
    claims.hold({ space: 'decision-router', name }, HOST_PARTY);
  }
  for (const { plugin, kind } of options.hooks?.actionKinds ?? []) {
    claims.hold(
      { space: 'hook-action', name: formatToolId({ namespace: plugin, name: kind.name }) },
      HOST_PARTY,
    );
  }
  for (const { plugin, formatter } of options.eventFormatters ?? []) {
    claims.hold(
      { space: 'event-formatter', name: formatToolId({ namespace: plugin, name: formatter.name }) },
      HOST_PARTY,
    );
    for (const kind of formatter.eventKinds)
      claims.hold({ space: 'event-kind', name: kind }, HOST_PARTY);
  }
  for (const name of Object.keys(options.agents ?? {})) {
    claims.hold({ space: 'code-agent', name }, HOST_PARTY);
  }
  return claims;
}

/** The accumulated contributions of every running plugin. */
class Contributed {
  readonly tools: Record<string, Tool> = {};
  readonly activities: { plugin: string; version: string; result: PluginSetupResult }[] = [];
  readonly agentSources: { plugin: string; result: PluginSetupResult }[] = [];
  readonly validators: NonNullable<BureauOptions['validators']>[number][] = [];
  readonly decisionModels: Record<
    string,
    NonNullable<PluginContributions['decisionRouters']>[number]
  > = {};
  readonly actionKinds: NonNullable<NonNullable<BureauOptions['hooks']>['actionKinds']>[number][] =
    [];
  readonly formatters: NonNullable<BureauOptions['eventFormatters']>[number][] = [];
  readonly judges: NonNullable<PluginContributions['evalJudges']>[number][] = [];
  readonly agents: Record<string, unknown> = {};
  readonly memory: {
    detectors: PluginMemoryContributions['detectors'][number][];
    embedders: PluginMemoryContributions['embedders'][number][];
  } = { detectors: [], embedders: [] };

  add(
    plugin: string,
    version: string,
    result: PluginSetupResult,
    tools: ReadonlyMap<string, Tool>,
  ): void {
    const id = (name: string) => formatToolId({ namespace: plugin, name });
    for (const [key, tool] of tools) this.tools[key] = tool;
    if ((result.activities?.length ?? 0) + (result.triggerKinds?.length ?? 0) > 0) {
      this.activities.push({ plugin, version, result });
    }
    if (result.guardrails !== undefined || result.runHooks !== undefined) {
      this.agentSources.push({ plugin, result });
    }
    for (const validator of result.validators ?? []) {
      this.validators.push({
        ...validator,
        identity: { ...validator.identity, name: id(validator.identity.name) },
        validate: (input, signal) => validator.validate(input, signal),
      });
    }
    for (const model of result.decisionRouters ?? []) this.decisionModels[id(model.name)] = model;
    for (const kind of result.hookActionKinds ?? []) this.actionKinds.push({ plugin, kind });
    for (const formatter of result.eventFormatters ?? [])
      this.formatters.push({ plugin, formatter });
    for (const judge of result.evalJudges ?? []) {
      this.judges.push({ ...judge, name: id(judge.name), evaluate: (run) => judge.evaluate(run) });
    }
    for (const { name, agent } of result.codeAgents ?? []) this.agents[id(name)] = agent;
    this.memory.detectors.push(...(result.memoryDetectors ?? []));
    for (const embedder of result.embedders ?? []) {
      this.memory.embedders.push({
        id: id(embedder.name),
        embedder: embedder.embed,
        dimension: embedder.dimensions,
      });
    }
  }
}

function catalogWith(
  host: VersionedCatalog | undefined,
  contributed: Contributed['activities'],
): VersionedCatalog | undefined {
  if (contributed.length === 0) return host;
  const catalog = createVersionedCatalog();
  for (const kind of VERSIONED_CATALOG_KINDS) {
    for (const entry of host?.entries(kind) ?? []) catalog.register(entry);
  }
  for (const { plugin, version, result } of contributed) {
    const source = { name: plugin, version };
    for (const activity of result.activities ?? []) {
      catalog.register({
        kind: 'activity',
        name: formatToolId({ namespace: plugin, name: activity.name }),
        version: activity.version,
        value: activity,
        source,
      });
    }
    for (const kind of result.triggerKinds ?? []) {
      catalog.register({
        kind: 'trigger-kind',
        name: formatToolId({ namespace: plugin, name: kind.name }),
        version: kind.version,
        value: kind,
        source,
      });
    }
  }
  return catalog;
}

function agentContributionsWith(
  host: AgentContributions | undefined,
  contributed: Contributed['agentSources'],
): AgentContributions | undefined {
  if (contributed.length === 0) return host;
  const plugins = createAgentContributions(
    contributed.map(({ plugin, result }) => ({
      plugin,
      guardrails: result.guardrails,
      runHooks: result.runHooks,
    })),
  );
  return {
    guardrails: new Map([...(host?.guardrails ?? []), ...plugins.guardrails]),
    runHooks: new Map([...(host?.runHooks ?? []), ...plugins.runHooks]),
  };
}

function memoryOf(
  memory: BureauOptions['memory'],
  contributions: PluginMemoryContributions,
): GovernedMemory | undefined {
  return typeof memory === 'function' ? memory(contributions) : memory;
}

/** Folds what the running plugins contributed into the options construction reads. */
function optionsWith<O extends ComposableOptions>(options: O, contributed: Contributed): O {
  const contributionCatalog = catalogWith(options.contributionCatalog, contributed.activities);
  const agentContributions = agentContributionsWith(
    options.agentContributions,
    contributed.agentSources,
  );
  const memory = memoryOf(options.memory, contributed.memory);
  // A factory never reaches the rest of construction: it is replaced by what it built.
  const { memory: _given, ...rest } = options;
  // `rest` is `O` without `memory`, which comes back below as what the factory built.
  return {
    ...(rest as O),
    ...(Object.keys(contributed.agents).length === 0
      ? {}
      : { agents: { ...options.agents, ...contributed.agents } }),
    ...(contributionCatalog === undefined ? {} : { contributionCatalog }),
    ...(agentContributions === undefined ? {} : { agentContributions }),
    ...(contributed.validators.length === 0
      ? {}
      : { validators: [...(options.validators ?? []), ...contributed.validators] }),
    ...(Object.keys(contributed.decisionModels).length === 0
      ? {}
      : {
          decisions: {
            ...options.decisions,
            models: { ...options.decisions?.models, ...contributed.decisionModels },
          },
        }),
    ...(options.hooks === undefined || contributed.actionKinds.length === 0
      ? {}
      : {
          hooks: {
            ...options.hooks,
            actionKinds: [...(options.hooks.actionKinds ?? []), ...contributed.actionKinds],
          },
        }),
    ...(contributed.formatters.length === 0
      ? {}
      : { eventFormatters: [...(options.eventFormatters ?? []), ...contributed.formatters] }),
    ...(options.onlineEvals === undefined || contributed.judges.length === 0
      ? {}
      : {
          onlineEvals: {
            ...options.onlineEvals,
            judges: [...options.onlineEvals.judges, ...contributed.judges],
          },
        }),
    ...(memory === undefined ? {} : { memory }),
  };
}

/** Runs `setup`, or answers why the plugin does not run. */
async function setUp(
  entry: BureauPluginEntry,
  options: ComposableOptions,
  storage: Storage,
): Promise<
  | { readonly status: 'disabled' | 'skipped'; readonly problems: PluginProblem[] }
  | {
      readonly status: 'set-up';
      readonly result: PluginSetupResult;
      readonly context: PluginSetupContext;
    }
> {
  const { descriptor } = entry;
  const settings = settingsOf(options.pluginConfiguration, descriptor.name);
  if (!isEnabled(entry, settings)) return { status: 'disabled', problems: [] };
  const configuration = configurationProblems(entry, settings);
  if ('problems' in configuration) return { status: 'skipped', problems: configuration.problems };
  const context: PluginSetupContext = {
    configuration: configuration.value,
    secrets: pluginSecretsOf(entry, options.pluginSecrets),
    storage: createPluginStorage(storage, descriptor.name),
  };
  try {
    const result = (await descriptor.setup?.(context as never)) ?? {};
    return { status: 'set-up', result, context };
  } catch (error) {
    return { status: 'skipped', problems: [{ code: 'setup-failed', message: messageOf(error) }] };
  }
}

/**
 * Loads `options.plugins` and folds what they contribute into the options. With no plugins the
 * options come back as given, except that a `memory` factory is called with nothing contributed.
 */
export async function composePlugins<O extends ComposableOptions>(
  given: O,
): Promise<ComposedPlugins<O>> {
  // The agent catalog is the caller's object, read before the first await: a caller that mutates
  // it after calling `createBureau` must not change what this Bureau runs.
  const options: O = given.agents === undefined ? given : { ...given, agents: { ...given.agents } };
  const contributed = new Contributed();
  const records: PluginRecord[] = [];
  const claims = heldByHost(options);
  const storage = options.storage ?? new MemoryStorage();
  for (const entry of pluginLoadOrder(options.plugins ?? [])) {
    const party: PluginClashParty = { source: entry.source, location: entry.location };
    const record = (
      status: PluginRecord['status'],
      problems: readonly PluginProblem[],
      extra: Partial<PluginRecord> = {},
    ) => records.push({ entry, status, problems, contributions: [], ...extra });
    const nameHolder = claims.holder({ space: 'plugin', name: entry.descriptor.name });
    if (nameHolder !== undefined) {
      record('skipped', [
        { code: 'name-clash', name: entry.descriptor.name, first: nameHolder, second: party },
      ]);
      continue;
    }
    claims.hold({ space: 'plugin', name: entry.descriptor.name }, party);
    const outcome = await setUp(entry, options, storage);
    if (outcome.status !== 'set-up') {
      record(outcome.status, outcome.problems);
      continue;
    }
    const plan = planOf(entry.descriptor.name, entry.descriptor.version, outcome.result);
    const clashes = claims.clashesOf(plan.claims, party);
    if (clashes.length > 0) {
      record('skipped', clashes);
      continue;
    }
    for (const claim of plan.claims) claims.hold(claim, party);
    contributed.add(entry.descriptor.name, entry.descriptor.version, outcome.result, plan.tools);
    record('running', [], {
      contributions: plan.listings,
      setup: { result: outcome.result, context: outcome.context },
    });
  }
  return { options: optionsWith(options, contributed), tools: contributed.tools, records };
}
