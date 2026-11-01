/**
 * What Settings › Plugins says about a plugin, worked out from what the host reports: its status as
 * a word and a dot, what it adds grouped by kind, what names it, and what depends on it when it is
 * turned off. Nothing here reads the page's drafts except through the `enabled` argument, so the
 * rules are testable on their own (`plugin-presentation.test.ts`).
 */
import type { StatusDotStatus } from '@lostgradient/cinder';

import { PLUGINS_COPY } from '../../../app/copy.ts';
import type {
  PluginContribution,
  PluginProblem,
  PluginStanding,
  PluginsSnapshot,
} from '../../../lib/host-plugins.ts';

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
      return { label: words.needsSetup, dot: 'warning' };
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

/** What a plugin adds, grouped by kind in the order the host listed them. */
export function contributionGroups(
  plugin: PluginStanding,
): readonly { kind: string; label: string; ids: readonly string[] }[] {
  const groups = new Map<string, string[]>();
  for (const entry of plugin.contributions) {
    const ids = groups.get(entry.kind);
    if (ids === undefined) groups.set(entry.kind, [entry.id]);
    else ids.push(entry.id);
  }
  return [...groups].map(([kind, ids]) => ({
    kind,
    label: Object.hasOwn(PLUGINS_COPY.contributionKinds, kind)
      ? (PLUGINS_COPY.contributionKinds[kind] ?? kind)
      : kind,
    ids,
  }));
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

/** The `In use` sentence: what names what the plugin adds, or why nothing does. */
export function inUseSentence(plugin: PluginStanding): string {
  const words = PLUGINS_COPY.inUse;
  if (plugin.status === 'disabled') return words.disabled;
  if (plugin.status === 'skipped') return words.notRunning;
  const totals = referenceTotals(plugin);
  const parts = [
    totals.agents > 0 ? PLUGINS_COPY.counts.agents(totals.agents) : undefined,
    totals.schedules > 0 ? PLUGINS_COPY.counts.schedules(totals.schedules) : undefined,
    totals.waitingRuns > 0 ? PLUGINS_COPY.counts.waitingRuns(totals.waitingRuns) : undefined,
  ].filter((part): part is string => part !== undefined);
  return parts.length === 0 ? words.nothing : words.some(parts);
}

/** One line of the disable dialog: the count, and the sentence about what it means. */
export type DisableImpact = {
  readonly key: 'agents' | 'schedules' | 'waitingRuns';
  readonly count: string;
  readonly sentence: string;
};

/**
 * What depends on the plugin now, from the counts the host reports for each thing it adds. Each
 * line names the contributions that are named by that many; a plugin nothing depends on has none.
 */
export function disableImpacts(plugin: PluginStanding): readonly DisableImpact[] {
  const words = PLUGINS_COPY.disable;
  const named = (key: DisableImpact['key']): string =>
    plugin.contributions
      .filter((entry: PluginContribution) => entry.references[key] > 0)
      .map((entry) => entry.id)
      .join(', ');
  const totals = referenceTotals(plugin);
  const impacts: DisableImpact[] = [];
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
  if (totals.waitingRuns > 0) {
    const count = PLUGINS_COPY.counts.waitingRuns(totals.waitingRuns);
    impacts.push({
      key: 'waitingRuns',
      count,
      sentence: words.waitingRuns(totals.waitingRuns, named('waitingRuns')),
    });
  }
  return impacts;
}

/** How many plugins are running, need setup, and are disabled, for the line shown once the host is back. */
export function standingCounts(snapshot: PluginsSnapshot): {
  running: number;
  needSetup: number;
  disabled: number;
} {
  let running = 0;
  let needSetup = 0;
  let disabled = 0;
  for (const plugin of snapshot.plugins) {
    if (plugin.status === 'running') running += 1;
    else if (plugin.status === 'needs-setup') needSetup += 1;
    else if (plugin.status === 'disabled') disabled += 1;
  }
  return { running, needSetup, disabled };
}
