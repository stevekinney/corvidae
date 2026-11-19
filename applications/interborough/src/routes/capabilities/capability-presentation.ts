/**
 * How the Capabilities page says what the catalog and the skill list hold: the words for a tool's
 * tier, default approval and source, and for a skill's trust and why it is unavailable. Every
 * answer is a function of an enumerated value, so a value this build does not know still reads.
 */
import { AGENT_PAGE_COPY } from '../../app/copy/agents.ts';
import { CAPABILITIES_COPY } from '../../app/copy/capabilities.ts';
import type { AgentCatalog, ToolApproval } from '../../lib/agent-definitions.ts';
import type { Skill } from '../../lib/bureau-skills.ts';
import { waitedFor } from '../../lib/format/clock.ts';
import type { PluginStanding } from '../../lib/host-plugins.ts';
import {
  isToolOn,
  type SourceToolApproval,
  type ToolSourceStanding,
  type ToolSourceTool,
} from '../../lib/host-tool-sources.ts';
import { API_KEY_CREDENTIAL, BEARER_CREDENTIAL } from '../../lib/tool-source-form.ts';
import { standingOf, type ToolStanding } from '../../lib/tool-standing.ts';
import { humanizeName } from '../settings/plugins/plugin-presentation.ts';

/** One tool as the catalog lists it. */
export type CatalogTool = AgentCatalog['tools'][number];

/** The tier a tool declares, or `unclassified` when it declares none (which is never read as read-only). */
export type ToolTier = NonNullable<CatalogTool['tier']> | 'unclassified';

const TOOL = CAPABILITIES_COPY.tool;
const SKILL = CAPABILITIES_COPY.skill;

/** The tier a tool states, with `null` read as `unclassified`. */
export function tierOf(tool: CatalogTool): ToolTier {
  return tool.tier ?? 'unclassified';
}

/** The badge variant that matches how much a tier can do. */
export function tierVariant(tier: ToolTier): 'success' | 'warning' | 'danger' | 'neutral' {
  if (tier === 'read-only') return 'success';
  if (tier === 'mutating') return 'warning';
  if (tier === 'dangerous') return 'danger';
  return 'neutral';
}

/** The words for a tier. */
export function tierLabel(tier: ToolTier): string {
  return TOOL.tier[tier];
}

/** The word a tool's risk chip shows (design row 30a): muted words, never a colour of their own. */
export function riskLabel(tier: ToolTier): string {
  return TOOL.chips.risk[tier];
}

/** The sentence a risk chip's tooltip says (design row 30f). */
export function riskTooltip(tier: ToolTier): string {
  return TOOL.chips.riskTooltip[tier];
}

/** What the asks level of a tool is read from: its tier and default, and the level the Bureau enforces, when it says. */
type AsksSource = Pick<CatalogTool, 'tier' | 'defaultApproval'> &
  Pick<Partial<CatalogTool>, 'defaultAsks'>;

/**
 * The asks level a tool has when an agent's file says nothing about it, in the words Access uses:
 * a dangerous tool defaults to Always (design row 30i), one that changes something or declares
 * nothing to On changes, and one that only reads to Never. Blocked is never a default: it belongs
 * to one agent's file, which the catalog does not carry.
 */
export function defaultAsks(tool: AsksSource): ToolApproval {
  // The level the hook enforces, which the Bureau reports: a dangerous tool picked Never reads
  // Never here and in every reader of this one value (the editor's "equals the default" rule too).
  if (tool.defaultAsks !== undefined) return tool.defaultAsks;
  if (tool.tier === 'dangerous') return 'always';
  return tool.defaultApproval === 'ask' ? 'on-changes' : 'never';
}

/** The words of the asks chip: "Asks: Never". */
export function asksLabel(tool: AsksSource): string {
  return TOOL.chips.asks(AGENT_PAGE_COPY.access.approvals[defaultAsks(tool)]);
}

/** The sentence the asks chip's tooltip says: what the level does, then the four values. */
export function asksTooltip(tool: AsksSource): string {
  return `${TOOL.chips.asksTooltip[defaultAsks(tool)]} ${TOOL.chips.asksValues}`;
}

/** The server a tool of the host's belongs to, which its name leads with (`notes__lookup`), or `undefined` when it carries none. */
function serverOf(tool: Pick<CatalogTool, 'name'>): string | undefined {
  const index = tool.name.indexOf('__');
  return index > 0 ? tool.name.slice(0, index) : undefined;
}

/** The words of the source chip: "Built in", "From notes", "From the Demo plugin". */
export function toolSourceChip(
  tool: ShownTool,
  sourceNames: ReadonlyMap<string, string> = new Map(),
): string {
  const chip = TOOL.chips.source;
  if (tool.source === 'bureau') return chip.bureau;
  // A plugin that is off is named by its title, which its last listing kept (row 30p).
  if (tool.lost?.kind === 'plugin') return chip.plugin(tool.lost.title);
  if (tool.source === 'plugin') return chip.plugin(tool.plugin ?? '');
  if (tool.source === 'skill') return chip.skill(tool.skill ?? '');
  // A source is named as a person calls it ("GitHub"), when it has a name, and by its id otherwise.
  if (tool.lost?.kind === 'source') return chip.host(tool.lost.name);
  const server = serverOf(tool);
  return chip.host(server === undefined ? undefined : (sourceNames.get(server) ?? server));
}

/** The names people call the saved sources, by source id, for the chips that say where a tool comes from. */
export function sourceNamesOf(
  sources: readonly Pick<ToolSourceStanding, 'id' | 'name'>[] | undefined,
): Map<string, string> {
  const names = new Map<string, string>();
  for (const source of sources ?? []) {
    if (source.name !== undefined && source.name !== null && source.name.trim() !== '') {
      names.set(source.id, source.name.trim());
    }
  }
  return names;
}

/** The sentence the source chip's tooltip says. */
export function toolSourceTooltip(tool: Pick<CatalogTool, 'source'>): string {
  return TOOL.chips.sourceTooltip[tool.source];
}

/**
 * The name a tool's page opens with (design rows 29z, 30g): the tool's own title when it has one,
 * otherwise its identifier read as words ("bureau:discover-agents" is "Discover agents"), so the
 * heading is never the identifier itself, which sits small and monospaced beside it.
 */
export function toolHeading(tool: Pick<CatalogTool, 'name' | 'title'>): string {
  if (tool.title !== null && tool.title.trim() !== '') return tool.title.trim();
  const identifier = tool.name.split(/__|:/).at(-1) ?? '';
  return identifier.trim() === '' ? tool.name : humanizeName(identifier);
}

/** The word of the asks level a tool defaults to, as the Access tab says it: "Never", "On changes", "Always". */
export function asksWord(tool: AsksSource): string {
  return AGENT_PAGE_COPY.access.approvals[defaultAsks(tool)];
}

/**
 * What an agent that uses `tool` asks for it, as Used by says it (rows 30c, 30d, 31j, 31w): the
 * level the agent's own file states, else the tool's default marked as such. Blocked belongs to one
 * agent, so it reads "Blocked on this agent" here and is never a property of the tool.
 */
export function userAsks(
  tool: AsksSource & Pick<CatalogTool, 'userApprovals'>,
  user: string,
  /**
   * The agents defined in code: the catalog carries no level for one, because its code sets it,
   * so it reads "set in code" rather than claiming the default.
   */
  codeAgents: ReadonlySet<string> = new Set(),
): { readonly text: string; readonly blocked: boolean } {
  const copy = TOOL.userAsks;
  const stated =
    tool.userApprovals !== undefined && Object.hasOwn(tool.userApprovals, user)
      ? tool.userApprovals[user]
      : undefined;
  if (stated === 'blocked') return { text: copy.blocked, blocked: true };
  if (stated === undefined && codeAgents.has(user)) return { text: copy.inCode, blocked: false };
  const words = AGENT_PAGE_COPY.access.approvals;
  return stated === undefined
    ? { text: copy.defaulted(words[defaultAsks(tool)]), blocked: false }
    : { text: copy.level(words[stated]), blocked: false };
}

/**
 * The agents that have `tool` blocked, in the order the host sends them: each one gets the "Allow
 * all never overrides" note (row 31x), which names it, and an agent that does not has none.
 */
export function blockedUsers(tool: Pick<CatalogTool, 'userApprovals'>): string[] {
  return Object.entries(tool.userApprovals ?? {})
    .filter(([, level]) => level === 'blocked')
    .map(([agent]) => agent);
}

/**
 * Why a tool the Tools tab lists cannot run (rows 30n to 30p, COR-2435): its source is not
 * connected (it failed, or waits for a sign-in), or its plugin is off. The tool comes from the last
 * listing the host kept, so its chips and asks level are still the ones it had.
 */
export type LostCause =
  | {
      readonly kind: 'source';
      readonly id: string;
      readonly name: string;
      readonly state: ToolSourceStanding['state'];
    }
  | { readonly kind: 'plugin'; readonly name: string; readonly title: string };

/** A tool the Tools tab lists: one the catalog holds, or one of a last listing that cannot run now. */
export type ShownTool = CatalogTool & { readonly lost?: LostCause };

/** The plugin fields {@link lostTools} reads. */
type LostPlugin = Pick<PluginStanding, 'status' | 'lastListing'> & {
  readonly descriptor: Pick<PluginStanding['descriptor'], 'name' | 'title'>;
};

/**
 * The tools that cannot run now, from the last listings the host kept (COR-2435): each tool of a
 * source that is not loaded and of a plugin that is off, which the catalog does not hold. A tool
 * the owner turned off is left out, as the catalog leaves it out. None has a user: an agent file
 * that names it cannot run it.
 */
export function lostTools(
  catalog: readonly Pick<CatalogTool, 'name'>[],
  sources: readonly ToolSourceStanding[] | undefined,
  plugins: readonly LostPlugin[] | undefined,
): ShownTool[] {
  const held = new Set(catalog.map((tool) => tool.name));
  const lost: ShownTool[] = [];
  const add = (tool: ShownTool): void => {
    if (held.has(tool.name)) return;
    held.add(tool.name);
    lost.push(tool);
  };
  for (const source of sources ?? []) {
    if (source.state === 'loaded' || source.lastListing === undefined) continue;
    const cause: LostCause = {
      kind: 'source',
      id: source.id,
      name: sourceHeading(source),
      state: source.state,
    };
    for (const tool of source.lastListing.tools) {
      if (!isToolOn(tool)) continue;
      add({
        name: tool.name,
        description: tool.description,
        shortDescription: tool.shortDescription,
        title: tool.title,
        inputSchema: tool.inputSchema,
        tier: tool.tier,
        defaultApproval: tool.tier === 'read-only' ? 'allow' : 'ask',
        source: 'host',
        plugin: null,
        skill: null,
        users: [],
        userApprovals: {},
        lost: cause,
      });
    }
  }
  for (const plugin of plugins ?? []) {
    if (plugin.status !== 'disabled' || plugin.lastListing === undefined) continue;
    const cause: LostCause = {
      kind: 'plugin',
      name: plugin.descriptor.name,
      title: plugin.descriptor.title,
    };
    for (const tool of plugin.lastListing.tools) {
      add({
        name: tool.name,
        description: tool.description,
        shortDescription: tool.shortDescription,
        title: tool.title,
        inputSchema: tool.inputSchema,
        tier: tool.tier,
        defaultApproval: tool.tier === 'read-only' ? 'allow' : 'ask',
        source: 'plugin',
        plugin: plugin.descriptor.name,
        skill: null,
        users: [],
        userApprovals: {},
        lost: cause,
      });
    }
  }
  return lost;
}

/** The sentence of a lost tool's warning row (rows 30n, 30p). */
export function lostToolWarning(cause: LostCause): string {
  const copy = TOOL.lost;
  if (cause.kind === 'plugin') return copy.plugin(cause.title);
  return cause.state === 'needs-authorization' ? copy.signIn(cause.name) : copy.source(cause.name);
}

/**
 * The tools of a source's table (row 31u): the ones it offers when it loaded, else the ones it
 * listed last, which show paused. `remembered` is whether they are the last listing.
 */
export function sourceTableTools(source: ToolSourceStanding): {
  readonly tools: ToolSourceTool[];
  readonly remembered: boolean;
} {
  if (source.tools.length > 0 || source.lastListing === undefined) {
    return { tools: source.tools, remembered: false };
  }
  return { tools: source.lastListing.tools, remembered: true };
}

/** The tools from which Capabilities groups its rows by source (row 32e, the "40 or more" frame). */
export const GROUP_TOOLS_FROM = 40;

/**
 * Where a tool comes from, as its row says it (rows 31e, 31f): "Built in", or the name of the
 * server, plugin or skill that brings it, read as words ("github" is "Github"), because the
 * catalog carries no display name of a source.
 */
export function toolRowSource(
  tool: ShownTool,
  sourceNames: ReadonlyMap<string, string> = new Map(),
): string {
  if (tool.source === 'bureau') return TOOL.chips.source.bureau;
  if (tool.source === 'plugin') return humanizeName(tool.plugin ?? '');
  if (tool.source === 'skill') return humanizeName(tool.skill ?? '');
  // A source that has a saved name is called by it ("GitHub"), as the chip says it.
  if (tool.lost?.kind === 'source') return tool.lost.name;
  const server = serverOf(tool);
  if (server === undefined) return TOOL.sources.host;
  return sourceNames.get(server) ?? humanizeName(server);
}

/** The key of the group of tools Bureau adds, which a grouped list shows first. */
const BUILT_IN_GROUP = 'bureau:';

/** The group a tool's row belongs to when the list is grouped by source: one key per source, labelled as its rows say it. */
export function toolGroup(
  tool: ShownTool,
  sourceNames: ReadonlyMap<string, string> = new Map(),
): { readonly key: string; readonly label: string } {
  const origin =
    tool.source === 'plugin'
      ? tool.plugin
      : tool.source === 'skill'
        ? tool.skill
        : tool.source === 'host'
          ? serverOf(tool)
          : null;
  return { key: `${tool.source}:${origin ?? ''}`, label: toolRowSource(tool, sourceNames) };
}

/**
 * The tools put in the order a grouped list needs: the rows of one source together, Built in
 * first and the other sources by name, each source's tools in the order the catalog gave them.
 */
export function groupToolsBySource<Tool extends CatalogTool>(tools: readonly Tool[]): Tool[] {
  const groups = new Map<string, { label: string; tools: Tool[] }>();
  for (const tool of tools) {
    const { key, label } = toolGroup(tool);
    const group = groups.get(key) ?? { label, tools: [] };
    group.tools.push(tool);
    groups.set(key, group);
  }
  return [...groups.entries()]
    .sort(([leftKey, left], [rightKey, right]) => {
      if (leftKey === BUILT_IN_GROUP) return rightKey === BUILT_IN_GROUP ? 0 : -1;
      if (rightKey === BUILT_IN_GROUP) return 1;
      return left.label.localeCompare(right.label);
    })
    .flatMap(([, group]) => group.tools);
}

/** Whether a tool matches what was typed: by its name for a person or its identifier. */
export function matchesToolFilter(tool: CatalogTool, typed: string): boolean {
  return matchesFilter(toolHeading(tool), typed) || matchesFilter(tool.name, typed);
}

/** The name a skill's page opens with: its identifier read as words ("release-notes" is "Release notes"). */
export function skillHeading(skill: Pick<Skill, 'name'>): string {
  return humanizeName(skill.name);
}

/** Whether a skill matches what was typed: by its name for a person or its identifier. */
export function matchesSkillFilter(skill: Skill, typed: string): boolean {
  return matchesFilter(skillHeading(skill), typed) || matchesFilter(skill.name, typed);
}

/** The words of a skill's muted meta line, in order: what it holds, where it is from, when it loads (rows 31m, 32v). */
export function skillMeta(skill: Pick<Skill, 'tools' | 'source'>): string[] {
  const meta = SKILL.meta;
  return [
    skill.tools.length === 0
      ? meta.instructionsOnly
      : meta.instructionsAndTools(skill.tools.length),
    SKILL.sourceKinds[skill.source.kind],
    meta.loadedWhenRelevant,
  ];
}

/** The words for where a tool comes from. */
export function toolSourceLabel(tool: CatalogTool): string {
  if (tool.source === 'plugin') return TOOL.sources.plugin(tool.plugin ?? '');
  if (tool.source === 'skill') return TOOL.sources.skill(tool.skill ?? '');
  return TOOL.sources[tool.source];
}

/**
 * The line a tool's row shows under its name: the one-line description when the tool declares one,
 * otherwise the first line of the description the model reads.
 */
export function toolSummary(tool: CatalogTool): string {
  if (tool.shortDescription !== null && tool.shortDescription.trim() !== '') {
    return tool.shortDescription;
  }
  return tool.description.trim().split('\n', 1)[0] ?? '';
}

/** A key that names a skill within the list: two sources can hold a skill of one name. */
export function skillKey(skill: Skill): string {
  return `${skill.source.id}/${skill.name}`;
}

/** Whether the host refuses agents this skill because of the trust in its source. */
export function isUntrusted(skill: Skill): boolean {
  return skill.trust !== 'trusted';
}

/** The words for the trust in a skill's source. */
export function trustLabel(skill: Skill): string {
  return SKILL.trustLabel[skill.trust];
}

/** The words for the kind of source a skill came from. */
export function skillSourceLabel(skill: Skill): string {
  return SKILL.sourceKinds[skill.source.kind];
}

const UNAVAILABLE = new Map<string, string>(Object.entries(SKILL.unavailable));

/** Why an agent cannot use a skill, or `undefined` when it can. A reason this build does not know is shown as the host wrote it. */
export function unavailableText(skill: Skill): string | undefined {
  if (skill.available) return undefined;
  const reason = skill.unavailableReason;
  if (reason === null) return SKILL.notAvailable;
  return UNAVAILABLE.get(reason) ?? reason;
}

/** Whether a name contains what was typed, ignoring case and the space around it. */
export function matchesFilter(name: string, typed: string): boolean {
  const needle = typed.trim().toLowerCase();
  return needle === '' || name.toLowerCase().includes(needle);
}

const SOURCE = CAPABILITIES_COPY.source;

/** The badge variant that matches where a tool source stands. */
export function sourceStateVariant(
  state: ToolSourceStanding['state'],
): 'success' | 'warning' | 'danger' | 'info' {
  if (state === 'loaded') return 'success';
  if (state === 'failed') return 'danger';
  if (state === 'needs-authorization') return 'warning';
  return 'info';
}

/** The words for where a tool source stands. */
export function sourceStateLabel(state: ToolSourceStanding['state']): string {
  return SOURCE.states[state];
}

/** A sentence saying what a source's standing means for its tools. */
export function sourceStateDescription(state: ToolSourceStanding['state']): string {
  return SOURCE.stateDescriptions[state];
}

/** The words for the kind of source. */
export function sourceKindLabel(source: ToolSourceStanding): string {
  return SOURCE.kinds[source.kind];
}

/** The tier a source's tool declares, or `unclassified` when it declares none or one this build does not know. */
export function sourceToolTier(tool: Pick<ToolSourceTool, 'tier'>): ToolTier {
  switch (tool.tier) {
    case 'read-only':
    case 'mutating':
    case 'dangerous':
      return tool.tier;
    default:
      return 'unclassified';
  }
}

/**
 * What happens when an agent whose file says nothing about the tool calls it: Armorer asks first for
 * every tool that is not read-only, and for one that declares nothing, so the tier is the answer.
 */
export function sourceToolStanding(tool: ToolSourceTool): ToolStanding {
  const tier = sourceToolTier(tool);
  return standingOf(
    {
      tier: tier === 'unclassified' ? null : tier,
      defaultApproval: tier === 'read-only' ? 'allow' : 'ask',
    },
    undefined,
  );
}

/**
 * Whether the running host has not yet loaded what is saved for `source`, so a restart changes what
 * Capabilities lists: a source added or changed since the host started, an Accepts secrets setting
 * saved since, or an OAuth source that has been signed in to since it last tried. An OAuth source
 * that is saved and not signed in to is not waiting for a restart but for a sign-in.
 */
export function sourceWaitsForRestart(source: ToolSourceStanding): boolean {
  return (
    // An OAuth source that nobody has signed in to lists nothing after a restart, so it waits for a sign-in instead.
    (source.state === 'pending-restart' && source.authorized !== false) ||
    source.settingsPending === true ||
    (source.state === 'needs-authorization' &&
      source.authorized === true &&
      source.tokensRejected !== true)
  );
}

/** What a person calls a source (rows 31o, 32k): the name the host saved, or its identifier when it saved none. */
export function sourceHeading(source: Pick<ToolSourceStanding, 'id' | 'name'>): string {
  const name = source.name?.trim() ?? '';
  return name === '' ? source.id : name;
}

/** Whether a source matches what was typed: by its name for a person or its identifier. */
export function matchesSourceFilter(
  source: Pick<ToolSourceStanding, 'id' | 'name'>,
  typed: string,
): boolean {
  return matchesFilter(sourceHeading(source), typed) || matchesFilter(source.id, typed);
}

/** The tone of the dot beside a source's state word. A source waiting for a restart is hollow: it is not running yet. */
export function sourceStatusTone(
  state: ToolSourceStanding['state'],
): 'success' | 'danger' | 'warning' | 'pending' {
  if (state === 'loaded') return 'success';
  if (state === 'failed') return 'danger';
  if (state === 'needs-authorization') return 'warning';
  return 'pending';
}

/**
 * The muted facts after a source's state word, in order (row 32k): how it signs in, when it was
 * last tested, and what kind of source it is ("OAuth sign-in", "last tested 1 h ago", "OpenAPI
 * spec"). The host does not say whether a stored credential is a key or a token, so a source that
 * holds one reads "Credential stored". `now` is the page's clock, in epoch milliseconds.
 */
export function sourceStatusFacts(
  source: Pick<ToolSourceStanding, 'authorized' | 'credentials' | 'kind' | 'lastTested'>,
  now: number,
): string[] {
  const facts: string[] = [];
  if (source.authorized !== undefined) facts.push(SOURCE.status.auth.oauth);
  // The connect form stores an API key as `key` and a bearer token as `token` (row 32k), so the
  // names the host reports say which one the source holds; any other credential stays unnamed.
  else if (source.credentials.includes(API_KEY_CREDENTIAL)) facts.push(SOURCE.status.auth.apiKey);
  else if (source.credentials.includes(BEARER_CREDENTIAL)) facts.push(SOURCE.status.auth.bearer);
  else if (source.credentials.length > 0) facts.push(SOURCE.status.auth.credentials);
  const tested = source.lastTested === undefined ? Number.NaN : Date.parse(source.lastTested);
  if (!Number.isNaN(tested)) facts.push(SOURCE.status.lastTested(waitedFor(tested, now)));
  facts.push(SOURCE.kinds[source.kind]);
  return facts;
}

/** The name a source's tool has for a person: its own name read as words ("list_invoices" is "List invoices"). */
export function sourceToolHeading(tool: Pick<ToolSourceTool, 'tool'>): string {
  return humanizeName(tool.tool);
}

/**
 * The Default asks level a source's tool has (rows 32l, 32r): the one the host reports, which is
 * the owner's pick or the level the tier gives, and for a host that reports none the tier's own:
 * a tool that only reads never asks, a dangerous one always asks, and one that changes something or
 * declares nothing asks on changes. Blocked is never a default.
 */
export function sourceToolApproval(
  tool: Pick<ToolSourceTool, 'approval' | 'tier'>,
): SourceToolApproval {
  if (tool.approval !== undefined) return tool.approval;
  const tier = sourceToolTier(tool);
  if (tier === 'read-only') return 'never';
  if (tier === 'dangerous') return 'always';
  return 'on-changes';
}

/**
 * Whether a source's tool has a setting saved that the running host has not loaded yet: its Accepts
 * secrets switch or its On checkbox differs from what is running. The host loads either at its next
 * start.
 */
export function sourceToolWaitsForRestart(
  tool: Pick<ToolSourceTool, 'acceptsSecrets' | 'savedAcceptsSecrets' | 'enabled' | 'savedEnabled'>,
): boolean {
  return (
    tool.savedAcceptsSecrets !== tool.acceptsSecrets ||
    (tool.savedEnabled ?? tool.enabled ?? true) !== (tool.enabled ?? true)
  );
}
