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
 * `memory` factory), and the providers they contribute reach the `models.catalog` factory, so the rest of construction never needs to know a plugin was involved.
 *
 * @module compose-plugins
 */

import type {
  PluginContributions,
  PluginHostApi,
  PluginSecrets,
  PluginSetupContext,
  PluginSetupResult,
} from '@lostgradient/interborough-plugin';
import { createPluginStorage, isPluginName } from '@lostgradient/interborough-plugin';
import type { GovernedMemory } from '@lostgradient/memory';
import { createModelCatalog } from '@lostgradient/operative';
import { MemoryStorage, type Storage } from '@lostgradient/storage';
import {
  formatToolId,
  fromNamespacedToolName,
  PROVIDER_TOOL_NAME_LIMIT,
  toNamespacedToolName,
  type Tool,
} from 'armorer';

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
import { lateHostApi, type PluginRecord } from './plugin-registry';
import {
  createPluginSecretGate,
  gatedContributions,
  type PluginSecretGate,
} from './plugin-secret-gate';
import { pluginTool } from './plugin-tools';
import type {
  BureauPluginEntry,
  BureauPluginSettings,
  PluginClashParty,
  PluginContributionKind,
  PluginContribution,
  PluginMemoryContributions,
  PluginModelContributions,
  PluginProblem,
  PluginProviderContribution,
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
  /**
   * Starts following the host's `watch` for every running plugin's declared secrets, so a saved or
   * removed secret changes what its contributions do with no restart. Returns the function that
   * stops following. Called once construction can stop it again at shutdown.
   */
  readonly watchSecrets: () => () => void;
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

/** The text that stands in a problem message for a secret value the plugin was handed. */
export const REDACTED_SECRET = '[redacted]';

/**
 * The plugin's view of the secrets, only the keys it declared, and `redact`, which removes from a
 * message every value this view has handed out so far. A plugin that quotes a secret in an error
 * would otherwise put it in `plugins.list()`.
 */
function pluginSecretsOf(
  entry: BureauPluginEntry,
  secrets: BureauOptions['pluginSecrets'],
): { readonly secrets: PluginSecrets; readonly redact: (message: string) => string } {
  const declared = secretKeysOf(entry);
  const handedOut = new Set<string>();
  return {
    secrets: {
      get: async (key) => {
        if (!declared.has(key)) {
          throw new TypeError(
            `Plugin "${entry.descriptor.name}" did not declare the secret "${key}".`,
          );
        }
        const value = secrets === undefined ? undefined : await secrets.get(key);
        if (typeof value === 'string' && value !== '') handedOut.add(value);
        return value;
      },
    },
    redact: (message) => {
      let redacted = message;
      // Longest first, so a secret that contains another is removed whole.
      for (const value of [...handedOut].toSorted((a, b) => b.length - a.length)) {
        redacted = redacted.replaceAll(value, REDACTED_SECRET);
      }
      return redacted;
    },
  };
}

/** The message of `error`, with every secret the plugin was handed removed. */
export function messageOf(error: unknown, redact: (message: string) => string): string {
  return redact(error instanceof Error ? error.message : String(error));
}

/** What the plugin claims and registers, before it is checked against what is held. */
interface PluginContributionPlan {
  readonly claims: readonly Claim[];
  readonly listings: readonly PluginContribution[];
  readonly tools: ReadonlyMap<string, Tool>;
}

/**
 * What `contributions` claims and registers. Throws when a contribution cannot be registered: a
 * name outside the plugin name grammar (which also keeps `plugin__name` injective), a tool that
 * cannot be rebuilt or whose provider name `plugin__name` is longer than the
 * {@link PROVIDER_TOOL_NAME_LIMIT} OpenAI and Gemini accept, or an embedder whose dimension is not
 * a positive integer. The caller turns the
 * throw into the plugin's `setup-failed`, so a malformed plugin is skipped rather than failing
 * `createBureau`.
 */
function planOf(
  plugin: string,
  version: string,
  contributions: PluginContributions,
  gate: PluginSecretGate | undefined,
): PluginContributionPlan {
  const claims: Claim[] = [];
  const listings: PluginContribution[] = [];
  const tools = new Map<string, Tool>();
  const contribute = (kind: PluginContribution['kind'], name: string, id?: string) => {
    if (!isPluginName(name)) {
      throw new TypeError(
        `setup returned a ${kind} named ${JSON.stringify(name)}: a contribution name starts with a lowercase letter and uses only lowercase letters, digits and hyphens, ending in a letter or digit.`,
      );
    }
    const contributionId = id ?? formatToolId({ namespace: plugin, name });
    claims.push({ space: kind, name: formatToolId({ namespace: plugin, name }) });
    listings.push({ kind, id: contributionId });
  };
  for (const tool of contributions.tools ?? []) {
    const rebuilt = pluginTool(tool, plugin, version, gate);
    contribute('tool', rebuilt.name, rebuilt.id);
    const providerName = toNamespacedToolName(rebuilt.identity);
    if (providerName.length > PROVIDER_TOOL_NAME_LIMIT) {
      throw new TypeError(
        `setup returned the tool "${formatToolId({ namespace: plugin, name: rebuilt.name })}", which a provider would call "${providerName}" (${providerName.length} characters); providers accept at most ${PROVIDER_TOOL_NAME_LIMIT}.`,
      );
    }
    tools.set(formatToolId({ namespace: plugin, name: rebuilt.name }), rebuilt);
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
  for (const provider of contributions.providers ?? []) {
    contribute('provider', provider.name);
    for (const row of provider.rows ?? []) {
      // A row names the provider that serves it; a stray one would never find its definition.
      if (row.provider !== provider.name) {
        throw new TypeError(
          `setup returned the provider "${provider.name}" with a catalog row for the provider "${row.provider}": a row's provider is the name of the definition that carries it.`,
        );
      }
    }
  }
  for (const embedder of contributions.embedders ?? []) {
    // Memory's embedder registry refuses this inside the host's `memory` factory, where it would
    // fail construction instead of skipping the plugin.
    if (!Number.isSafeInteger(embedder.dimensions) || embedder.dimensions <= 0) {
      throw new TypeError(
        `setup returned the embedder "${embedder.name}" with dimension ${String(embedder.dimensions)}, which is not a positive integer.`,
      );
    }
    contribute('embedder', embedder.name);
  }
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
  // A plugin tool is keyed `plugin:name` in the agent tool catalog, the name a file uses, and a
  // provider sees it as `plugin__name`. A host tool keyed either way holds the name: one keyed
  // `plugin__name` (as a tool source's tools are) would reach the provider under the same name.
  for (const key of Object.keys(options.agentSource?.tools ?? {})) {
    const providerForm = fromNamespacedToolName(key);
    claims.hold(
      {
        space: 'tool',
        name:
          providerForm === undefined
            ? key
            : formatToolId({ namespace: providerForm.namespace, name: providerForm.name }),
      },
      HOST_PARTY,
    );
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
  for (const judge of options.onlineEvals?.judges ?? []) {
    claims.hold({ space: 'eval-judge', name: judge.name }, HOST_PARTY);
  }
  // Embedders and memory detectors reach memory only through the host's `memory` factory, which
  // holds no names composition can see; a plugin's embedder id is always `plugin:name`, so it never
  // meets memory's built-in `hashing`, and two plugins' ids are kept apart by the claims above.
  // Providers reach the host's `models.catalog` factory, not a held name; MCP apps have no Bureau entry point yet: the host wires them (COR-1880).
  return claims;
}

/**
 * The kinds a host option can already hold a name of, and so that {@link heldByHost} reserves.
 * `compose-plugins.test.ts` checks a host entry of each one refuses a plugin that claims it.
 */
export const HOST_HELD_KINDS: ReadonlySet<PluginContributionKind> = new Set([
  'tool',
  'activity',
  'trigger-kind',
  'validator',
  'guardrail',
  'run-hooks',
  'decision-router',
  'hook-action',
  'event-formatter',
  'code-agent',
  'eval-judge',
]);

/**
 * Whether a contribution of `kind` is registered with these options. A hook action kind needs
 * `hooks`, an eval judge `onlineEvals`, and an embedder or memory detector a `memory` factory;
 * without one the contribution goes nowhere, so the listing leaves it out.
 */
export function registersKind(kind: PluginContributionKind, options: ComposableOptions): boolean {
  switch (kind) {
    case 'hook-action':
      return options.hooks !== undefined;
    case 'eval-judge':
      return options.onlineEvals !== undefined;
    case 'embedder':
    case 'memory-detector':
      return typeof options.memory === 'function';
    default:
      return true;
  }
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
  readonly providers: PluginProviderContribution[] = [];

  add(
    plugin: string,
    version: string,
    result: PluginSetupResult,
    tools: ReadonlyMap<string, Tool>,
    gate: PluginSecretGate | undefined,
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
    for (const kind of result.hookActionKinds ?? []) {
      // A delivery pins the kind's own version, else its plugin's (COR-1879).
      this.actionKinds.push({ plugin, kind, version: kind.version ?? version });
    }
    for (const formatter of result.eventFormatters ?? [])
      this.formatters.push({ plugin, formatter });
    for (const judge of result.evalJudges ?? []) {
      this.judges.push({ ...judge, name: id(judge.name), evaluate: (run) => judge.evaluate(run) });
    }
    for (const { name, agent } of result.codeAgents ?? []) this.agents[id(name)] = agent;
    for (const provider of result.providers ?? []) {
      this.providers.push({
        plugin,
        definition: provider,
        rows:
          provider.rows ??
          createModelCatalog().descriptors.filter((row) => row.provider === provider.name),
      });
    }
    this.memory.detectors.push(...(result.memoryDetectors ?? []));
    for (const embedder of result.embedders ?? []) {
      this.memory.embedders.push({
        id: id(embedder.name),
        embedder: embedder.embed,
        dimension: embedder.dimensions,
        // COR-1898: `memory.embedder` may name it only while its plugin's secrets are set.
        ...(gate === undefined
          ? {}
          : { availability: () => (gate.available() ? 'available' : 'needs-setup') }),
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

/**
 * `options` with a `models.catalog` factory replaced by the rows it built from the contributed
 * providers. Rows given as a list, and no `models` option, come back as they were.
 */
async function withModelCatalog<O extends ComposableOptions>(
  options: O,
  providers: readonly PluginProviderContribution[],
): Promise<O> {
  const models = options.models;
  const factory = models?.catalog;
  if (models === undefined || typeof factory !== 'function') return options;
  const contributions: PluginModelContributions = { providers: [...providers] };
  return { ...options, models: { ...models, catalog: await factory(contributions) } };
}

/** Runs `setup` and plans what it returned, or answers why the plugin does not run. */
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
      readonly plan: PluginContributionPlan;
      readonly redact: (message: string) => string;
      readonly gate: PluginSecretGate | undefined;
      readonly bindHost: (host: PluginHostApi) => void;
    }
> {
  const { descriptor } = entry;
  const settings = settingsOf(options.pluginConfiguration, descriptor.name);
  if (!isEnabled(entry, settings)) return { status: 'disabled', problems: [] };
  const configuration = configurationProblems(entry, settings);
  if ('problems' in configuration) return { status: 'skipped', problems: configuration.problems };
  const { secrets, redact } = pluginSecretsOf(entry, options.pluginSecrets);
  const keys = [...secretKeysOf(entry)];
  // Read before `setup`, so a plugin missing a secret is `needs-setup` from its first listing.
  const gate =
    keys.length === 0
      ? undefined
      : await createPluginSecretGate(descriptor.name, keys, options.pluginSecrets);
  // Everything that reads the plugin runs inside the `try`: a malformed descriptor or contribution
  // skips this plugin and never fails `createBureau`.
  try {
    const host = lateHostApi(descriptor.name);
    const context: PluginSetupContext = {
      configuration: configuration.value,
      secrets,
      storage: createPluginStorage(storage, descriptor.name),
      host: host.api,
    };
    const returned: PluginSetupResult = (await descriptor.setup?.(context as never)) ?? {};
    // Registered now and refused while a declared secret is missing: the options that receive
    // contributions are read once, so one added later would never be seen (COR-1874).
    const result =
      gate === undefined
        ? returned
        : gatedContributions(returned, gate, (name) =>
            formatToolId({ namespace: descriptor.name, name }),
          );
    const plan = planOf(descriptor.name, descriptor.version, result, gate);
    return { status: 'set-up', result, context, plan, redact, gate, bindHost: host.bind };
  } catch (error) {
    return {
      status: 'skipped',
      problems: [{ code: 'setup-failed', message: messageOf(error, redact) }],
    };
  }
}

/** `given` with every caller-owned collection composition reads after an await copied now. */
function snapshotOf<O extends ComposableOptions>(given: O): O {
  const {
    agents,
    validators,
    eventFormatters,
    decisions,
    hooks,
    onlineEvals,
    plugins,
    pluginConfiguration,
  } = given;
  return {
    ...given,
    ...(plugins === undefined ? {} : { plugins: [...plugins] }),
    // Each plugin's settings are read when its turn comes, after earlier plugins' setups awaited.
    ...(pluginConfiguration === undefined
      ? {}
      : {
          pluginConfiguration: Object.fromEntries(
            Object.entries(pluginConfiguration).map(([name, settings]) => [name, { ...settings }]),
          ),
        }),
    ...(agents === undefined ? {} : { agents: { ...agents } }),
    ...(validators === undefined ? {} : { validators: [...validators] }),
    ...(eventFormatters === undefined ? {} : { eventFormatters: [...eventFormatters] }),
    ...(decisions?.models === undefined
      ? {}
      : { decisions: { ...decisions, models: { ...decisions.models } } }),
    ...(hooks?.actionKinds === undefined
      ? {}
      : { hooks: { ...hooks, actionKinds: [...hooks.actionKinds] } }),
    ...(onlineEvals === undefined
      ? {}
      : { onlineEvals: { ...onlineEvals, judges: [...onlineEvals.judges] } }),
  };
}

/**
 * Loads `options.plugins` and folds what they contribute into the options. With no plugins the
 * options come back as given, except that a `memory` factory is called with nothing contributed.
 */
export async function composePlugins<O extends ComposableOptions>(
  given: O,
): Promise<ComposedPlugins<O>> {
  // The caller's objects are read before the first await: a caller that mutates them after
  // calling `createBureau` must not change what this Bureau composes.
  const options = snapshotOf(given);
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
    const { plan } = outcome;
    const clashes = claims.clashesOf(plan.claims, party);
    if (clashes.length > 0) {
      record('skipped', clashes);
      continue;
    }
    for (const claim of plan.claims) claims.hold(claim, party);
    contributed.add(
      entry.descriptor.name,
      entry.descriptor.version,
      outcome.result,
      plan.tools,
      outcome.gate,
    );
    record('running', [], {
      contributions: plan.listings.filter(({ kind }) => registersKind(kind, options)),
      setup: {
        result: outcome.result,
        context: outcome.context,
        redact: outcome.redact,
        bindHost: outcome.bindHost,
      },
      ...(outcome.gate === undefined ? {} : { gate: outcome.gate }),
    });
  }
  const gates = records.flatMap(({ gate }) => (gate === undefined ? [] : [gate]));
  return {
    options: await withModelCatalog(optionsWith(options, contributed), contributed.providers),
    tools: contributed.tools,
    records,
    watchSecrets: () => {
      const stops = gates.map((gate) => gate.watch());
      return () => {
        for (const stop of stops) stop();
      };
    },
  };
}
