/**
 * What Settings › Plugins says about a plugin, worked out from what the host reports: its status as
 * a word and a dot, what it adds grouped by kind, what names it, and what depends on it when it is
 * turned off. Nothing here reads the page's drafts except through the `enabled` argument, so the
 * rules are testable on their own (`plugin-presentation.test.ts`).
 */
import type { StatusDotStatus } from '@lostgradient/cinder';

import { PLUGINS_COPY } from '../../../app/copy/plugins.ts';
import { RESTART_COPY } from '../../../app/copy/restart.ts';
import { nameList } from '../../../app/copy/shared.ts';
import type { RestartIntent } from '../../../app/restart/host-restart-flow.svelte.ts';
import type { AgentListing } from '../../../lib/agent-definitions.ts';
import { agentLabel } from '../../../lib/agent-label.ts';
import type {
  PluginContribution,
  PluginProblem,
  PluginsSnapshot,
  PluginStanding,
} from '../../../lib/host-plugins.ts';

/** How many runs the disable question names before it says "and N more". */
export const NAMED_RUNS = 5;

/** One run in flight, as the disable question names it (`plugin-runs.ts` reads them). */
export interface InFlightRun {
  readonly id: string;
  /** The run as a person reads it: its chat's title, or its identifier when it has none. */
  readonly name: string;
  /** Whether the run waits on a person, which the plugin's waiting-run count also counts. */
  readonly waiting: boolean;
}

/** What the read of a plugin's runs found: the runs (none, usually), or that it could not say. */
export type InFlightRuns =
  { readonly kind: 'listed'; readonly runs: readonly InFlightRun[] } | { readonly kind: 'unknown' };

/** No run in flight: the question as it was before the read existed. */
export const NO_RUNS: InFlightRuns = { kind: 'listed', runs: [] };

/** A status as a person reads it: the word and the dot that goes with it. */
export type PluginStatusView = { readonly label: string; readonly dot: StatusDotStatus };

/** How many of each thing name what a plugin adds. */
export type PluginReferenceTotals = {
  readonly agents: number;
  readonly schedules: number;
  readonly waitingRuns: number;
};

/** The plugin's name. */
export function nameOf(plugin: PluginStanding): string {
  return plugin.descriptor.name;
}

/**
 * Whether another plugin before this one in the listing has its name. The host's choices and
 * secrets are stored by name and belong to the first, so a later one is shown but never edited.
 */
export function isShadowed(snapshot: PluginsSnapshot, plugin: PluginStanding): boolean {
  return (
    snapshot.plugins.findIndex((entry) => nameOf(entry) === nameOf(plugin)) !==
    snapshot.plugins.indexOf(plugin)
  );
}

/** The key of a plugin in the list: its name, and for a later plugin with the same name, where it came from too. */
export function listKey(snapshot: PluginsSnapshot, plugin: PluginStanding): string {
  return isShadowed(snapshot, plugin) ? `${nameOf(plugin)}@${plugin.location}` : nameOf(plugin);
}

/**
 * The other plugin a `name-clash` is with: the one at the location of the side that is not this
 * plugin. A side the listing does not hold (the host's own options hold names too) has none.
 */
export function clashCounterpart(
  snapshot: PluginsSnapshot,
  plugin: PluginStanding,
  problem: PluginProblem,
): PluginStanding | undefined {
  if (problem.code !== 'name-clash') return undefined;
  const locations = ['first', 'second']
    .map((field): unknown => Reflect.get(problem, field))
    .map((party): unknown =>
      typeof party === 'object' && party !== null ? Reflect.get(party, 'location') : undefined,
    )
    .filter((location): location is string => typeof location === 'string');
  return snapshot.plugins.find(
    (entry) =>
      entry !== plugin && entry.location !== plugin.location && locations.includes(entry.location),
  );
}

/** Whether the running host loaded the plugin enabled. A plugin that failed its startup check was enabled. */
export function loadedEnabled(plugin: PluginStanding): boolean {
  return plugin.status !== 'disabled';
}

/**
 * The status a row shows. `enabled` is the choice the page holds now: a plugin whose choice
 * differs from what is loaded reads as what it will be after a restart, and one whose other
 * stored choices differ reads as changing.
 */
export function statusOf(plugin: PluginStanding, enabled: boolean): PluginStatusView {
  const words = PLUGINS_COPY.status;
  if (enabled !== loadedEnabled(plugin)) {
    return enabled
      ? { label: words.enabledAfterRestart, dot: 'warning' }
      : { label: words.disabledAfterRestart, dot: 'warning' };
  }
  if (plugin.restartRequired && plugin.enabled === enabled) {
    return { label: words.changesAfterRestart, dot: 'warning' };
  }
  switch (plugin.status) {
    case 'running':
      return { label: words.running, dot: 'success' };
    case 'needs-setup':
      // Neutral: amber is for what waits on the person, and a plugin that needs a key is not that.
      return { label: words.needsSetup, dot: 'neutral' };
    case 'disabled':
      return { label: words.disabled, dot: 'neutral' };
    case 'skipped':
      return { label: words.notLoaded, dot: 'danger' };
  }
}

/** The short word for where a plugin came from. */
export function sourceWord(source: PluginStanding['source']): string {
  const words = PLUGINS_COPY.source;
  return source === 'built-in' ? words.builtIn : source === 'folder' ? words.folder : words.package;
}

/** The sentence for where a plugin came from. */
export function sourceKind(source: PluginStanding['source']): string {
  const words = PLUGINS_COPY.sourceKind;
  return source === 'built-in' ? words.builtIn : source === 'folder' ? words.folder : words.package;
}

/** One thing a plugin adds: its name as a person reads it, and the identifier a file names it by. */
export type ContributionItem = { readonly id: string; readonly title: string };

/** One kind of thing a plugin adds, with the heading it goes under. */
export type ContributionGroup = {
  readonly kind: string;
  readonly label: string;
  readonly items: readonly ContributionItem[];
};

/** The kinds the page lists first, in this order; any other kind follows in the host's order. */
const LEADING_KINDS = ['tool', 'activity', 'skill'] as const;

/** `fetch-page` as words, `Fetch page`: the name a contribution has when its plugin gave it no title. */
export function humanizeName(name: string): string {
  const words = name.replaceAll(/[-_]+/g, ' ').trim();
  return words === '' ? name : `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

/** The identifier a contribution is named by in a file: `plugin:name`, without a tool's `@version`. */
export function identifierOf(id: string): string {
  const at = id.lastIndexOf('@');
  return at > 0 ? id.slice(0, at) : id;
}

/**
 * What a plugin adds, grouped by kind: tools, activities and skills first, then the other kinds in
 * the order the host listed them. Each item has its human name (the one the plugin gave it, else
 * its name as words) and the identifier small beside it. `skills` are the plugin's own skills,
 * which the host lists apart from the contributions.
 */
export function contributionGroups(
  plugin: PluginStanding,
  skills: readonly { readonly name: string }[] = [],
): readonly ContributionGroup[] {
  const groups = new Map<string, ContributionItem[]>();
  const add = (kind: string, item: ContributionItem): void => {
    const items = groups.get(kind);
    if (items === undefined) groups.set(kind, [item]);
    else items.push(item);
  };
  for (const entry of plugin.contributions) {
    const id = identifierOf(entry.id);
    add(entry.kind, { id, title: entry.title ?? humanizeName(id.slice(id.indexOf(':') + 1)) });
  }
  for (const skill of skills) {
    const id = skill.name.includes(':') ? skill.name : `${nameOf(plugin)}:${skill.name}`;
    add('skill', { id, title: humanizeName(id.slice(id.indexOf(':') + 1)) });
  }
  const kinds = [
    ...LEADING_KINDS.filter((kind) => groups.has(kind)),
    ...[...groups.keys()].filter((kind) => !LEADING_KINDS.some((leading) => leading === kind)),
  ];
  return kinds.map((kind) => ({
    kind,
    label: Object.hasOwn(PLUGINS_COPY.contributionKinds, kind)
      ? (PLUGINS_COPY.contributionKinds[kind] ?? kind)
      : kind,
    items: groups.get(kind) ?? [],
  }));
}

/**
 * The agents a disabled plugin holds back, named as a person reads them: its own agents (the
 * identifiers that start with `<name>:`) that the catalog lists unavailable, where no available
 * agent has the same name.
 */
export function heldBackAgents(
  pluginName: string,
  agents: readonly Pick<AgentListing, 'id' | 'name' | 'state'>[],
): string[] {
  const available = new Set(
    agents.filter((agent) => agent.state === 'ready').map((agent) => agent.name),
  );
  return agents
    .filter(
      (agent) =>
        agent.state === 'unavailable' &&
        agent.id.startsWith(`${pluginName}:`) &&
        !available.has(agent.name),
    )
    .map((agent) => agentLabel(agent.name, undefined));
}

/** The sum of what names each thing a plugin adds. */
export function referenceTotals(plugin: PluginStanding): PluginReferenceTotals {
  let agents = 0;
  let schedules = 0;
  let waitingRuns = 0;
  for (const entry of plugin.contributions) {
    agents += entry.references.agents;
    schedules += entry.references.schedules;
    waitingRuns += entry.references.waitingRuns;
  }
  return { agents, schedules, waitingRuns };
}

/**
 * The `In use` sentence of a running plugin: what names what it adds, or that nothing does yet.
 * A plugin that is not running has none, because nothing can use it.
 */
export function inUseSentence(plugin: PluginStanding): string | undefined {
  if (plugin.status !== 'running') return undefined;
  const words = PLUGINS_COPY.inUse;
  const title = plugin.descriptor.title;
  const totals = referenceTotals(plugin);
  const counts = [
    totals.agents > 0
      ? { text: PLUGINS_COPY.counts.agents(totals.agents), one: totals.agents === 1 }
      : undefined,
    totals.schedules > 0
      ? { text: PLUGINS_COPY.counts.schedules(totals.schedules), one: totals.schedules === 1 }
      : undefined,
    totals.waitingRuns > 0
      ? { text: PLUGINS_COPY.counts.waitingRuns(totals.waitingRuns), one: totals.waitingRuns === 1 }
      : undefined,
  ].filter((part) => part !== undefined);
  if (counts.length === 0) return words.nothing(title);
  return words.some(
    title,
    counts.map((part) => part.text),
    counts.length === 1 && counts[0]?.one === true,
  );
}

/** One line of the disable dialog: the count, and the sentence about what it means. */
export type DisableImpact = {
  readonly key: 'inFlightRuns' | 'agents' | 'schedules' | 'waitingRuns';
  readonly count: string;
  readonly sentence: string;
};

/**
 * What depends on the plugin now, from the counts the host reports for each thing it adds. Each
 * line names the contributions that are named by that many; a plugin nothing depends on has none.
 */
export function disableImpacts(
  plugin: PluginStanding,
  inFlight: InFlightRuns = NO_RUNS,
): readonly DisableImpact[] {
  const words = PLUGINS_COPY.disable;
  const named = (key: 'agents' | 'schedules' | 'waitingRuns'): string =>
    plugin.contributions
      .filter((entry: PluginContribution) => entry.references[key] > 0)
      .map((entry) => entry.id)
      .join(', ');
  const totals = referenceTotals(plugin);
  const title = plugin.descriptor.title;
  const impacts: DisableImpact[] = [];
  // The runs going now come first, because failing them is the costliest effect. A run that waits
  // on a person is in the plugin's waiting runs too, so it is counted once, here. When the runs
  // could not be read, the one line says the same fate for any run going or waiting, so the
  // waiting runs have no line of their own: no run is told two fates.
  let waitingRuns = totals.waitingRuns;
  if (inFlight.kind === 'unknown') {
    impacts.push({
      key: 'inFlightRuns',
      count: words.inFlightRunsUnknownLead,
      sentence: words.inFlightRunsUnknown(title),
    });
    waitingRuns = 0;
  } else if (inFlight.runs.length > 0) {
    const shown = inFlight.runs.slice(0, NAMED_RUNS);
    impacts.push({
      key: 'inFlightRuns',
      count: PLUGINS_COPY.counts.inFlightRuns(inFlight.runs.length),
      sentence: words.inFlightRuns(
        title,
        shown.map((run) => run.name),
        inFlight.runs.length - shown.length,
      ),
    });
    waitingRuns = Math.max(0, waitingRuns - inFlight.runs.filter((run) => run.waiting).length);
  }
  if (totals.agents > 0) {
    const count = PLUGINS_COPY.counts.agents(totals.agents);
    impacts.push({ key: 'agents', count, sentence: words.agents(totals.agents, named('agents')) });
  }
  if (totals.schedules > 0) {
    const count = PLUGINS_COPY.counts.schedules(totals.schedules);
    impacts.push({
      key: 'schedules',
      count,
      sentence: words.schedules(totals.schedules, named('schedules')),
    });
  }
  if (waitingRuns > 0) {
    const count = PLUGINS_COPY.counts.waitingRuns(waitingRuns);
    impacts.push({
      key: 'waitingRuns',
      count,
      sentence: words.waitingRuns(waitingRuns, named('waitingRuns')),
    });
  }
  return impacts;
}

/**
 * What stops working when a plugin is turned off, such as "2 agents and 1 schedule", or
 * `undefined` when nothing depends on it.
 */
export function unavailableAfterDisable(plugin: PluginStanding): string | undefined {
  const impacts = disableImpacts(plugin);
  return impacts.length === 0 ? undefined : nameList(impacts.map((impact) => impact.count));
}

/** The plugins by standing, named as a person reads them. */
export function standingNames(snapshot: PluginsSnapshot): {
  running: string[];
  needSetup: string[];
  disabled: string[];
  notLoaded: string[];
} {
  const names = { running: [], needSetup: [], disabled: [], notLoaded: [] } as {
    running: string[];
    needSetup: string[];
    disabled: string[];
    notLoaded: string[];
  };
  for (const plugin of snapshot.plugins) {
    const title = plugin.descriptor.title;
    if (plugin.status === 'running') names.running.push(title);
    else if (plugin.status === 'needs-setup') names.needSetup.push(title);
    else if (plugin.status === 'disabled') names.disabled.push(title);
    else names.notLoaded.push(title);
  }
  return names;
}

/**
 * The lead and the words of the banner once the host is back: what applied, how the plugins stand
 * now, and, for a plugin turned off, what that affected. The impact is the one the disable dialog
 * showed before the restart, because the host no longer holds the references it counted.
 */
export function restartBackWords(
  intent: RestartIntent,
  snapshot: PluginsSnapshot | undefined,
): { title: string; text: string } {
  const words = RESTART_COPY.back;
  const names = snapshot === undefined ? undefined : standingNames(snapshot);
  const standing =
    names === undefined
      ? ''
      : words.standing(names.running, names.needSetup, names.disabled, names.notLoaded);
  if (intent.disabling !== undefined) {
    return {
      title: words.disabled(intent.disabling.title),
      text: [
        standing,
        words.unavailable(intent.disabling.title, intent.disabling.unavailable),
        words.enableAgain,
      ]
        .filter((part) => part !== '')
        .join(' '),
    };
  }
  return {
    title: words.title,
    text: [words.applied(intent.changes), standing].filter((part) => part !== '').join(' '),
  };
}

/**
 * Where a secret is kept, as a person reads it: the folder of its file, written from the home
 * folder (`~/.interborough/secrets`) when it is under the state directory, and the location as
 * given when it is not a path at all (a remote host names an environment variable).
 */
export function secretsDirectory(location: string): string {
  const slash = location.lastIndexOf('/');
  if (slash < 0) return location;
  const directory = location.slice(0, slash);
  const marker = '/.interborough/';
  const at = `${directory}/`.indexOf(marker);
  return at < 0 ? directory : `~${`${directory}/`.slice(at, -1)}`;
}

/**
 * The model provider a plugin contributes, or `undefined` for a plugin that is not one. A key a
 * provider plugin holds is connected through the Models flow, which tests it before it saves it.
 */
export function providerOf(plugin: PluginStanding): string | undefined {
  const provider = plugin.contributions.find((entry) => entry.kind === 'provider');
  if (provider === undefined) return undefined;
  const id = identifierOf(provider.id);
  return id.slice(id.indexOf(':') + 1);
}
