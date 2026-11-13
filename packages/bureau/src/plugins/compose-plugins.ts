/**
 * COR-1879 — plugin composition: what `createBureau` does with `plugins` before anything else.
 *
 * Plugins load in the P-COR-96 order: the built-in `bureau` plugin (COR-1890), then package plugins in
 * the order the host gives them, then folder plugins by folder name. Each enabled plugin's configuration is parsed, its `setup` runs once with
 * storage confined to `plugin:<name>:`, and what it returns is checked against every name already
 * held (Bureau's own, the host's, and earlier plugins'). The first holder of a name keeps it: a
 * later plugin that claims a held name is `skipped` whole with `name-clash`, so none of its
 * contributions is registered. A plugin that passes registers every contribution through the
 * option it belongs to (`contributionCatalog`, `agentContributions`, `validators`, `hooks`,
 * `formatters`, `decisions`, `scorers`, the agent catalog, the agent tool catalog and the
 * `memory` factory), and the providers they contribute reach the `models.catalog` factory, so the rest of construction never needs to know a plugin was involved.
 *
 * A disabled plugin registers nothing. Its `setup` still runs once, isolated, only to read the code
 * agents the agent catalog lists as `unavailable` (COR-2009); see `agentsOfDisabledPlugin`.
 *
 * @module compose-plugins
 */

import type {
  GuardrailFamily,
  PluginContributions,
  PluginHost,
  PluginMemoryGate,
  PluginSecrets,
  PluginSetupContext,
  PluginSetupResult,
} from '@lostgradient/interborough-plugin';
import {
  createPluginStorage,
  guardrailId,
  isGuardrailFactory,
  isPluginName,
} from '@lostgradient/interborough-plugin';
import type { GovernedMemory } from '@lostgradient/memory';
import {
  createModelCatalog,
  type GuardrailEntry,
  guardrailActionOf,
  guardrailOf,
} from '@lostgradient/operative';
import { MemoryStorage, type Storage } from '@lostgradient/storage';
import {
  formatToolId,
  fromNamespacedToolName,
  parseToolId,
  PROVIDER_TOOL_NAME_LIMIT,
  readToolTitle,
  toNamespacedToolName,
  type Tool,
} from 'armorer';

import type { AgentDefinitions, UnavailableCodeAgent } from '../agent-catalog';
import type { AgentContributions } from '../agent-contributions';
import { BUREAU_EVENT_CATALOG } from '../bureau-event-catalog';
import type { AgentSource } from '../sources/definition-source';
import {
  assertInterceptorHooks,
  createAgentContributions,
  guardrailContractFault,
} from '../agent-contributions';
import { createToolApprovalHooks } from '../tool-approval';
import type { BureauOptions } from '../bureau-types/options';
import { WORKFLOW_TOOL_NAMES } from '../workflow-tools';
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
   * The content of the running plugins that ship some (COR-1897), in load order. A plugin that is
   * disabled, skipped or failed ships none. The `content` URL is the plugin's own; reading it is
   * the host's, through {@link BureauOptions.pluginAgentSource} and
   * {@link BureauOptions.pluginWorkflowSource}.
   */
  readonly shippedContent: readonly { readonly plugin: string; readonly content: URL }[];
  /**
   * COR-2009 — the code agents of the disabled plugins, in load order, which the agent catalog
   * lists `unavailable` (`Plugin Demo is disabled`) so they can be read and duplicated, never run.
   * See {@link agentsOfDisabledPlugin} for how they are read without the plugin running.
   */
  readonly unavailableAgents: readonly UnavailableCodeAgent[];
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

/** Built-in plugins first, then package plugins in the order given, then folder plugins by folder name. */
export function pluginLoadOrder(entries: readonly BureauPluginEntry[]): BureauPluginEntry[] {
  const builtIn = entries.filter((entry) => entry.source === 'built-in');
  const packages = entries.filter((entry) => entry.source === 'package');
  const folders = entries
    .filter((entry) => entry.source === 'folder')
    .toSorted((a, b) => {
      const left = folderName(a.location);
      const right = folderName(b.location);
      return left < right ? -1 : left > right ? 1 : 0;
    });
  return [...builtIn, ...packages, ...folders];
}

function settingsOf(
  settings: Readonly<Record<string, BureauPluginSettings>> | undefined,
  name: string,
): BureauPluginSettings {
  return settings !== undefined && Object.hasOwn(settings, name) ? (settings[name] ?? {}) : {};
}

function isEnabled(entry: BureauPluginEntry, settings: BureauPluginSettings): boolean {
  if (entry.descriptor.required === true) return true;
  return settings.enabled ?? entry.descriptor.enabled ?? true;
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

/** The points at which a memory guardrail that declares no `gates` runs. */
const MEMORY_GATES: readonly PluginMemoryGate[] = ['admission', 'recall'];

/** The actions an input, output and tool-call guardrail may carry (COR-2104). */
const GUARDRAIL_ACTIONS: Readonly<Record<'input' | 'output' | 'tools', readonly string[]>> = {
  input: ['block', 'warn', 'sanitize', 'tripwire'],
  output: ['block', 'warn', 'redact', 'tripwire'],
  tools: ['block', 'warn', 'tripwire'],
};

/**
 * Checks what every guardrail says about itself (COR-2118): a non-empty `description`, and for a
 * factory a Zod schema to parse an agent's configuration with, so a plugin that returns neither is
 * skipped at setup instead of listing a guardrail nobody can tell apart or failing the agents that
 * choose it.
 */
function checkGuardrailContract(family: GuardrailFamily, guardrail: unknown): void {
  const { name } = guardrail as { readonly name?: unknown };
  const fault = guardrailContractFault(guardrail);
  if (fault === 'description') {
    throw new TypeError(
      `setup returned the ${family} guardrail "${String(name)}" without a description: every guardrail says what it guards.`,
    );
  }
  if (fault === 'factory') {
    throw new TypeError(
      `setup returned the ${family} guardrail factory "${String(name)}" without a configuration schema and a create function.`,
    );
  }
}

/**
 * The name of a guardrail entry, after checking the action it carries is one its family has, so a
 * plugin that returns another is skipped at setup instead of failing the runs that use it, and the
 * guardrail's own contract ({@link checkGuardrailContract}).
 */
function checkedGuardrailName(
  family: 'input' | 'output' | 'tools',
  entry: GuardrailEntry<{ readonly name: string }, string>,
): string {
  const guardrail = guardrailOf(entry);
  const { name } = guardrail;
  const action = guardrailActionOf(entry, GUARDRAIL_ACTIONS[family][0]!);
  if (!GUARDRAIL_ACTIONS[family].includes(action)) {
    throw new TypeError(
      `setup returned the ${family} guardrail "${name}" with the action ${JSON.stringify(action)}: it is one of ${GUARDRAIL_ACTIONS[family].join(', ')}.`,
    );
  }
  checkGuardrailContract(family, guardrail);
  return name;
}

/** A `ui://` resource URI: the scheme, then a host and path with no whitespace. */
const PANEL_URI_PATTERN = /^ui:\/\/\S+$/;

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
  agentTools: AgentSource['tools'] | undefined,
): PluginContributionPlan {
  const claims: Claim[] = [];
  const listings: PluginContribution[] = [];
  const tools = new Map<string, Tool>();
  const contribute = (
    kind: PluginContribution['kind'],
    name: string,
    id?: string,
    title?: string,
    claimName?: string,
  ) => {
    if (!isPluginName(name)) {
      throw new TypeError(
        `setup returned ${/^[aeiou]/.test(kind) ? 'an' : 'a'} ${kind} named ${JSON.stringify(name)}: a contribution name starts with a lowercase letter and uses only lowercase letters, digits and hyphens, ending in a letter or digit.`,
      );
    }
    const contributionId = id ?? formatToolId({ namespace: plugin, name });
    claims.push({ space: kind, name: claimName ?? formatToolId({ namespace: plugin, name }) });
    listings.push({ kind, id: contributionId, ...(title === undefined ? {} : { title }) });
  };
  for (const tool of contributions.tools ?? []) {
    const rebuilt = pluginTool(tool, plugin, version, gate);
    contribute('tool', rebuilt.name, rebuilt.id, readToolTitle(rebuilt.metadata));
    const providerName = toNamespacedToolName(rebuilt.identity);
    if (providerName.length > PROVIDER_TOOL_NAME_LIMIT) {
      throw new TypeError(
        `setup returned the tool "${formatToolId({ namespace: plugin, name: rebuilt.name })}", which a provider would call "${providerName}" (${providerName.length} characters); providers accept at most ${PROVIDER_TOOL_NAME_LIMIT}.`,
      );
    }
    tools.set(formatToolId({ namespace: plugin, name: rebuilt.name }), rebuilt);
  }
  for (const activity of contributions.activities ?? []) contribute('activity', activity.name);
  for (const kind of contributions.triggers ?? []) contribute('trigger', kind.name);
  for (const validator of contributions.validators ?? []) {
    contribute('validator', validator.identity.name);
  }
  // A guardrail's name is claimed within its family, so one name may serve more than one.
  const guardrail = (
    kind: 'guardrail' | 'memory-detector',
    family: GuardrailFamily,
    name: string,
  ) => contribute(kind, name, undefined, undefined, guardrailId(plugin, family, name));
  for (const detector of contributions.guardrails?.input ?? []) {
    guardrail('guardrail', 'input', checkedGuardrailName('input', detector));
  }
  for (const validator of contributions.guardrails?.output ?? []) {
    guardrail('guardrail', 'output', checkedGuardrailName('output', validator));
  }
  for (const validator of contributions.guardrails?.tools ?? []) {
    // A factory carries no action: the validator it builds carries its own.
    const action = isGuardrailFactory(validator) ? 'block' : (validator.action ?? 'block');
    if (!GUARDRAIL_ACTIONS.tools.includes(action)) {
      throw new TypeError(
        `setup returned the tools guardrail "${validator.name}" with the action ${JSON.stringify(action)}: it is one of ${GUARDRAIL_ACTIONS.tools.join(', ')}.`,
      );
    }
    checkGuardrailContract('tools', validator);
    guardrail('guardrail', 'tools', validator.name);
  }
  for (const interceptor of contributions.interceptors ?? []) {
    contribute('interceptor', interceptor.name);
  }
  for (const kind of contributions.reactions ?? []) contribute('reaction', kind.name);
  for (const provider of contributions.providers ?? []) {
    contribute('provider', provider.name);
    // The host resolves a generate by the bare provider name, so the name is held across plugins.
    claims.push({ space: 'provider-name', name: provider.name });
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
  for (const detector of contributions.guardrails?.memory ?? []) {
    const { gates } = detector;
    if (
      gates !== undefined &&
      (gates.length === 0 || gates.some((at) => !MEMORY_GATES.includes(at)))
    ) {
      throw new TypeError(
        `setup returned the memory guardrail "${detector.name}" with gates ${JSON.stringify(gates)}: gates list "admission", "recall" or both, and are left out to run at both.`,
      );
    }
    checkGuardrailContract('memory', detector);
    guardrail('memory-detector', 'memory', detector.name);
  }
  for (const judge of contributions.scorers ?? []) contribute('scorer', judge.name);
  for (const app of contributions.panels ?? []) {
    // A host serves the page by this URI alone, so it must be a `ui://` resource and unique.
    if (!PANEL_URI_PATTERN.test(app.uri)) {
      throw new TypeError(
        `setup returned the panel "${app.name}" with the URI "${app.uri}", which is not a ui:// resource URI.`,
      );
    }
    if (!app.allowedTools.includes(app.opensFromTool)) {
      throw new TypeError(
        `setup returned the panel "${app.name}" opened from "${app.opensFromTool}", which is not one of its allowedTools.`,
      );
    }
    for (const tool of app.hostOnlyTools ?? []) {
      if (!app.allowedTools.includes(tool) || !tool.startsWith('bureau.')) {
        throw new TypeError(
          `setup returned the panel "${app.name}" with host-only tool "${tool}" outside its Bureau allowlist.`,
        );
      }
    }
    if (
      app.opensFromAgentTool !== undefined &&
      agentTools !== undefined &&
      !Object.hasOwn(agentTools ?? {}, app.opensFromAgentTool) &&
      !(
        app.opensFromAgentTool.startsWith('bureau:') &&
        WORKFLOW_TOOL_NAMES.some((name) => app.opensFromAgentTool === `bureau:${name}`)
      )
    ) {
      throw new TypeError(
        `setup returned the panel "${app.name}" opened from unknown agent tool "${app.opensFromAgentTool}".`,
      );
    }
    contribute('panel', app.name);
    claims.push({ space: 'panel-uri', name: app.uri });
    // A tool links to one page, so the host cannot serve two apps opened from the same tool.
    claims.push({ space: 'panel-tool', name: app.opensFromTool });
  }
  for (const formatter of contributions.formatters ?? []) {
    contribute('formatter', formatter.name);
    for (const kind of formatter.eventKinds) claims.push({ space: 'event-kind', name: kind });
  }
  for (const agent of contributions.agents ?? []) contribute('agent', agent.name);
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
  for (const entry of options.contributionCatalog?.entries('trigger') ?? []) {
    claims.hold({ space: 'trigger', name: entry.name }, HOST_PARTY);
  }
  for (const validator of options.validators ?? []) {
    claims.hold({ space: 'validator', name: validator.identity.name }, HOST_PARTY);
  }
  for (const [id, held] of options.agentContributions?.guardrails ?? []) {
    const { namespace, name } = parseToolId(id);
    if (held.inputDetector !== undefined) {
      claims.hold({ space: 'guardrail', name: guardrailId(namespace, 'input', name) }, HOST_PARTY);
    }
    if (held.outputValidator !== undefined) {
      claims.hold({ space: 'guardrail', name: guardrailId(namespace, 'output', name) }, HOST_PARTY);
    }
    if (held.toolValidator !== undefined) {
      claims.hold({ space: 'guardrail', name: guardrailId(namespace, 'tools', name) }, HOST_PARTY);
    }
  }
  for (const id of options.agentContributions?.interceptors.keys() ?? []) {
    claims.hold({ space: 'interceptor', name: id }, HOST_PARTY);
  }
  for (const { plugin, kind } of options.hooks?.actionKinds ?? []) {
    claims.hold(
      { space: 'reaction', name: formatToolId({ namespace: plugin, name: kind.name }) },
      HOST_PARTY,
    );
  }
  for (const { plugin, formatter } of options.formatters ?? []) {
    claims.hold(
      { space: 'formatter', name: formatToolId({ namespace: plugin, name: formatter.name }) },
      HOST_PARTY,
    );
    for (const kind of formatter.eventKinds)
      claims.hold({ space: 'event-kind', name: kind }, HOST_PARTY);
  }
  for (const name of Object.keys(options.agents ?? {})) {
    claims.hold({ space: 'agent', name }, HOST_PARTY);
  }
  for (const judge of options.scorers?.list ?? []) {
    claims.hold({ space: 'scorer', name: judge.name }, HOST_PARTY);
  }
  // Embedders and memory guardrails reach memory only through the host's `memory` factory, which
  // holds no names composition can see; a plugin's embedder id is always `plugin:name`, so it never
  // meets memory's built-in `hashing`, and two plugins' ids are kept apart by the claims above.
  // Providers reach the host's `models.catalog` factory, not a held name; panels have no Bureau option, so no host entry holds a URI: the host reads them from `bureau.plugins.panels()`.
  return claims;
}

/**
 * The kinds a host option can already hold a name of, and so that {@link heldByHost} reserves.
 * `compose-plugins.test.ts` checks a host entry of each one refuses a plugin that claims it.
 */
export const HOST_HELD_KINDS: ReadonlySet<PluginContributionKind> = new Set([
  'tool',
  'activity',
  'trigger',
  'validator',
  'guardrail',
  'interceptor',
  'reaction',
  'formatter',
  'agent',
  'scorer',
]);

/**
 * Whether a contribution of `kind` is registered with these options. A hook action kind needs
 * `hooks`, a scorer `scorers`, and an embedder or memory guardrail a `memory` factory;
 * without one the contribution goes nowhere, so the listing leaves it out.
 */
export function registersKind(kind: PluginContributionKind, options: ComposableOptions): boolean {
  switch (kind) {
    case 'reaction':
      return options.hooks !== undefined;
    case 'scorer':
      return options.scorers !== undefined;
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
  readonly actionKinds: NonNullable<NonNullable<BureauOptions['hooks']>['actionKinds']>[number][] =
    [];
  readonly formatters: NonNullable<BureauOptions['formatters']>[number][] = [];
  readonly scorers: NonNullable<PluginContributions['scorers']>[number][] = [];
  readonly agents: Record<string, unknown> = {};
  readonly memory: {
    admission: PluginMemoryContributions['guardrails']['admission'][number][];
    recall: PluginMemoryContributions['guardrails']['recall'][number][];
    embedders: PluginMemoryContributions['embedders'][number][];
  } = { admission: [], recall: [], embedders: [] };
  readonly providers: PluginProviderContribution[] = [];

  add(
    plugin: string,
    version: string,
    result: PluginSetupResult,
    providers: readonly PluginProviderContribution[],
    tools: ReadonlyMap<string, Tool>,
    gate: PluginSecretGate | undefined,
  ): void {
    const id = (name: string) => formatToolId({ namespace: plugin, name });
    for (const [key, tool] of tools) this.tools[key] = tool;
    if ((result.activities?.length ?? 0) + (result.triggers?.length ?? 0) > 0) {
      this.activities.push({ plugin, version, result });
    }
    if (result.guardrails !== undefined || result.interceptors !== undefined) {
      this.agentSources.push({ plugin, result });
    }
    for (const validator of result.validators ?? []) {
      this.validators.push({
        ...validator,
        identity: { ...validator.identity, name: id(validator.identity.name) },
        validate: (input, signal) => validator.validate(input, signal),
      });
    }
    for (const kind of result.reactions ?? []) {
      // A delivery pins the kind's own version, else its plugin's (COR-1879).
      this.actionKinds.push({ plugin, kind, version: kind.version ?? version });
    }
    for (const formatter of result.formatters ?? []) this.formatters.push({ plugin, formatter });
    for (const judge of result.scorers ?? []) {
      this.scorers.push({ ...judge, name: id(judge.name), evaluate: (run) => judge.evaluate(run) });
    }
    for (const { name, agent } of result.agents ?? []) this.agents[id(name)] = agent;
    this.providers.push(...providers);
    for (const detector of result.guardrails?.memory ?? []) {
      // The detector itself, not a copy of its fields: it may be an instance whose methods live on
      // its prototype.
      const gates = detector.gates ?? MEMORY_GATES;
      if (gates.includes('admission')) this.memory.admission.push(detector);
      if (gates.includes('recall')) this.memory.recall.push(detector);
    }
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

/** The providers a plugin's setup returned, each with the rows it carries or Operative's static ones. */
function providersOf(
  entry: BureauPluginEntry,
  configuration: unknown,
  result: PluginSetupResult,
): PluginProviderContribution[] {
  const declared = [...secretKeysOf(entry)];
  return (result.providers ?? []).map((provider) => ({
    plugin: entry.descriptor.name,
    definition: provider,
    configuration,
    // `providerSecretProblems` has refused every other case: one declared secret is the key.
    secretKey: provider.secretKey ?? declared[0],
    rows:
      provider.rows ??
      createModelCatalog().descriptors.filter((row) => row.provider === provider.name),
  }));
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
    for (const kind of result.triggers ?? []) {
      catalog.register({
        kind: 'trigger',
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
      interceptors: result.interceptors,
    })),
  );
  // A name is claimed per family, so a host entry and a plugin's may share an id (`plugin:name`)
  // and carry different families; the claims keep one family from being held twice.
  const guardrails = new Map(host?.guardrails);
  for (const [id, entry] of plugins.guardrails)
    guardrails.set(id, { ...guardrails.get(id), ...entry });
  return {
    guardrails,
    interceptors: new Map([...(host?.interceptors ?? []), ...plugins.interceptors]),
  };
}

function memoryOf(
  memory: BureauOptions['memory'],
  contributions: PluginMemoryContributions,
): GovernedMemory | undefined {
  return typeof memory === 'function' ? memory(contributions) : memory;
}

/** The `content` of each running plugin that declares one, in load order. */
function shippedContentOf(
  records: readonly PluginRecord[],
): { readonly plugin: string; readonly content: URL }[] {
  return records.flatMap(({ entry, status }) => {
    const content = entry.descriptor.content;
    return status === 'running' && content !== undefined
      ? [{ plugin: entry.descriptor.name, content }]
      : [];
  });
}

/** Folds what the running plugins contributed into the options construction reads. */
function optionsWith<O extends ComposableOptions>(options: O, contributed: Contributed): O {
  const contributionCatalog = catalogWith(options.contributionCatalog, contributed.activities);
  const agentContributions = agentContributionsWith(
    options.agentContributions,
    contributed.agentSources,
  );
  const memory = memoryOf(options.memory, {
    guardrails: { admission: contributed.memory.admission, recall: contributed.memory.recall },
    embedders: contributed.memory.embedders,
  });
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
      : { formatters: [...(options.formatters ?? []), ...contributed.formatters] }),
    ...(options.scorers === undefined || contributed.scorers.length === 0
      ? {}
      : {
          scorers: {
            ...options.scorers,
            list: [...options.scorers.list, ...contributed.scorers],
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
      readonly bindHost: (host: PluginHost) => void;
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
      approvals: (tools) => createToolApprovalHooks(undefined, { tools }),
    };
    const returned: PluginSetupResult = (await descriptor.setup?.(context as never)) ?? {};
    // A malformed hook skips this plugin here, where every other malformed contribution does:
    // `createAgentContributions` reads them after every plugin's setup, outside this `try`, and
    // would fail the whole composition. It runs before the gate below wraps each hook.
    for (const interceptor of returned.interceptors ?? []) {
      assertInterceptorHooks(
        formatToolId({ namespace: descriptor.name, name: interceptor.name }),
        interceptor,
      );
    }
    // Registered now and refused while a declared secret is missing: the options that receive
    // contributions are read once, so one added later would never be seen (COR-1874).
    const result =
      gate === undefined
        ? returned
        : gatedContributions(returned, gate, (name) =>
            formatToolId({ namespace: descriptor.name, name }),
          );
    const plan = planOf(
      descriptor.name,
      descriptor.version,
      result,
      gate,
      options.agentSource?.tools,
    );
    return { status: 'set-up', result, context, plan, redact, gate, bindHost: host.bind };
  } catch (error) {
    return {
      status: 'skipped',
      problems: [{ code: 'setup-failed', message: messageOf(error, redact) }],
    };
  }
}

/**
 * COR-2009 — the code agents a disabled plugin ships, read so the agent catalog can list them
 * `unavailable` and `duplicate` can copy one. Only `setup` can say what they are, so it runs once,
 * with nothing it could change or reveal: storage confined to `plugin:<name>:` of a scratch
 * `MemoryStorage` that is dropped after, no secret (every `get` answers `undefined`), and a host
 * API that is never bound, so a call to it rejects. Only `agents` is kept; no other
 * contribution is registered, `start` never runs, and none of the agents can start a run. A
 * plugin whose configuration does not parse, or whose `setup` throws, lists none: it is disabled
 * either way, and enabling it reports the failure where a running plugin's would be.
 */
async function agentsOfDisabledPlugin(
  entry: BureauPluginEntry,
  options: Pick<ComposableOptions, 'pluginConfiguration'>,
): Promise<UnavailableCodeAgent[]> {
  const { descriptor } = entry;
  if (descriptor.setup === undefined) return [];
  const configuration = configurationProblems(
    entry,
    settingsOf(options.pluginConfiguration, descriptor.name),
  );
  if ('problems' in configuration) return [];
  try {
    const context: PluginSetupContext = {
      configuration: configuration.value,
      secrets: { get: () => Promise.resolve(undefined) },
      storage: createPluginStorage(new MemoryStorage(), descriptor.name),
      host: lateHostApi(descriptor.name).api,
      approvals: (tools) => createToolApprovalHooks(undefined, { tools }),
    };
    const returned: PluginSetupResult = (await descriptor.setup(context as never)) ?? {};
    const message = `Plugin ${descriptor.title ?? descriptor.name} is disabled`;
    return (returned.agents ?? []).map(({ name, agent }) => ({
      id: formatToolId({ namespace: descriptor.name, name }),
      plugin: descriptor.name,
      agent,
      unavailable: { code: 'plugin-disabled', message },
    }));
  } catch {
    return [];
  }
}

/**
 * The problems of a plugin whose provider names a `secretKey` the plugin did not declare, or names
 * none while the plugin declares several secrets. Which secret holds the key is never read from
 * the order of the declarations (COR-2142).
 */
function providerSecretProblems(
  entry: BureauPluginEntry,
  contributions: PluginContributions,
): PluginProblem[] {
  const declared = [...secretKeysOf(entry)];
  const problems: PluginProblem[] = [];
  for (const provider of contributions.providers ?? []) {
    if (provider.secretKey !== undefined) {
      if (!declared.includes(provider.secretKey)) {
        problems.push({
          code: 'provider-secret-unknown',
          provider: provider.name,
          key: provider.secretKey,
        });
      }
    } else if (declared.length > 1) {
      problems.push({
        code: 'provider-secret-ambiguous',
        provider: provider.name,
        secrets: declared,
      });
    }
  }
  return problems;
}

/**
 * The `formatter-unknown-kind` problems of a plugin whose formatters list an event kind Bureau
 * never publishes, so a formatter cannot wait on an event that never fires (COR-2101).
 */
function formatterUnknownKinds(contributions: PluginContributions): PluginProblem[] {
  const problems: PluginProblem[] = [];
  for (const formatter of contributions.formatters ?? []) {
    for (const kind of formatter.eventKinds) {
      if (!Object.hasOwn(BUREAU_EVENT_CATALOG, kind)) {
        problems.push({ code: 'formatter-unknown-kind', formatter: formatter.name, kind });
      }
    }
  }
  return problems;
}

/** `given` with every caller-owned collection composition reads after an await copied now. */
function snapshotOf<O extends ComposableOptions>(given: O): O {
  const {
    agents,
    validators,
    formatters,
    decisions,
    hooks,
    scorers,
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
    ...(formatters === undefined ? {} : { formatters: [...formatters] }),
    ...(decisions?.models === undefined
      ? {}
      : { decisions: { ...decisions, models: { ...decisions.models } } }),
    ...(hooks?.actionKinds === undefined
      ? {}
      : { hooks: { ...hooks, actionKinds: [...hooks.actionKinds] } }),
    ...(scorers === undefined ? {} : { scorers: { ...scorers, list: [...scorers.list] } }),
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
  const unavailableAgents: UnavailableCodeAgent[] = [];
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
    if (outcome.status === 'disabled') {
      unavailableAgents.push(...(await agentsOfDisabledPlugin(entry, options)));
    }
    if (outcome.status !== 'set-up') {
      record(outcome.status, outcome.problems);
      continue;
    }
    const refusals = [
      ...formatterUnknownKinds(outcome.result),
      ...providerSecretProblems(entry, outcome.result),
    ];
    if (refusals.length > 0) {
      record('skipped', refusals);
      continue;
    }
    const { plan } = outcome;
    const providers = providersOf(entry, outcome.context.configuration, outcome.result);
    const checked =
      providers.length === 0
        ? []
        : ((await options.models?.checkProviders?.({
            plugin: entry.descriptor.name,
            configuration: outcome.context.configuration,
            providers,
          })) ?? []);
    if (checked.length > 0) {
      record(
        'skipped',
        checked.map(({ field, message }) => ({ code: 'configuration-invalid', field, message })),
      );
      continue;
    }
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
      providers,
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
    shippedContent: shippedContentOf(records),
    unavailableAgents,
    watchSecrets: () => {
      const stops = gates.map((gate) => gate.watch());
      return () => {
        for (const stop of stops) stop();
      };
    },
  };
}
