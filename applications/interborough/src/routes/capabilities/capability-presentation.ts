/**
 * How the Capabilities page says what the catalog and the skill list hold: the words for a tool's
 * tier, default approval and source, and for a skill's trust and why it is unavailable. Every
 * answer is a function of an enumerated value, so a value this build does not know still reads.
 */
import { AGENT_PAGE_COPY, CAPABILITIES_COPY } from '../../app/copy.ts';
import type { AgentCatalog, ToolApproval } from '../../lib/agent-definitions.ts';
import type { Skill } from '../../lib/bureau-skills.ts';
import type { ToolSourceStanding, ToolSourceTool } from '../../lib/host-tool-sources.ts';
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

/**
 * The asks level a tool has when an agent's file says nothing about it, in the words Access uses:
 * a dangerous tool defaults to Always (design row 30i), one that changes something or declares
 * nothing to On changes, and one that only reads to Never. Blocked is never a default: it belongs
 * to one agent's file, which the catalog does not carry.
 */
export function defaultAsks(tool: Pick<CatalogTool, 'tier' | 'defaultApproval'>): ToolApproval {
  if (tool.tier === 'dangerous') return 'always';
  return tool.defaultApproval === 'ask' ? 'on-changes' : 'never';
}

/** The words of the asks chip: "Asks: Never". */
export function asksLabel(tool: Pick<CatalogTool, 'tier' | 'defaultApproval'>): string {
  return TOOL.chips.asks(AGENT_PAGE_COPY.access.approvals[defaultAsks(tool)]);
}

/** The sentence the asks chip's tooltip says: what the level does, then the four values. */
export function asksTooltip(tool: Pick<CatalogTool, 'tier' | 'defaultApproval'>): string {
  return `${TOOL.chips.asksTooltip[defaultAsks(tool)]} ${TOOL.chips.asksValues}`;
}

/** The server a tool of the host's belongs to, which its name leads with (`notes__lookup`), or `undefined` when it carries none. */
function serverOf(tool: Pick<CatalogTool, 'name'>): string | undefined {
  const index = tool.name.indexOf('__');
  return index > 0 ? tool.name.slice(0, index) : undefined;
}

/** The words of the source chip: "Built in", "From notes", "From the Demo plugin". */
export function toolSourceChip(tool: CatalogTool): string {
  const chip = TOOL.chips.source;
  if (tool.source === 'bureau') return chip.bureau;
  if (tool.source === 'plugin') return chip.plugin(tool.plugin ?? '');
  if (tool.source === 'skill') return chip.skill(tool.skill ?? '');
  return chip.host(serverOf(tool));
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
export function asksWord(tool: Pick<CatalogTool, 'tier' | 'defaultApproval'>): string {
  return AGENT_PAGE_COPY.access.approvals[defaultAsks(tool)];
}

/** The tools from which Capabilities groups its rows by source (row 32e, the "40 or more" frame). */
export const GROUP_TOOLS_FROM = 40;

/**
 * Where a tool comes from, as its row says it (rows 31e, 31f): "Built in", or the name of the
 * server, plugin or skill that brings it, read as words ("github" is "Github"), because the
 * catalog carries no display name of a source.
 */
export function toolRowSource(tool: CatalogTool): string {
  if (tool.source === 'bureau') return TOOL.chips.source.bureau;
  if (tool.source === 'plugin') return humanizeName(tool.plugin ?? '');
  if (tool.source === 'skill') return humanizeName(tool.skill ?? '');
  const server = serverOf(tool);
  return server === undefined ? TOOL.sources.host : humanizeName(server);
}

/** The key of the group of tools Bureau adds, which a grouped list shows first. */
const BUILT_IN_GROUP = 'bureau:';

/** The group a tool's row belongs to when the list is grouped by source: one key per source, labelled as its rows say it. */
export function toolGroup(tool: CatalogTool): { readonly key: string; readonly label: string } {
  const origin =
    tool.source === 'plugin'
      ? tool.plugin
      : tool.source === 'skill'
        ? tool.skill
        : tool.source === 'host'
          ? serverOf(tool)
          : null;
  return { key: `${tool.source}:${origin ?? ''}`, label: toolRowSource(tool) };
}

/**
 * The tools put in the order a grouped list needs: the rows of one source together, Built in
 * first and the other sources by name, each source's tools in the order the catalog gave them.
 */
export function groupToolsBySource(tools: readonly CatalogTool[]): CatalogTool[] {
  const groups = new Map<string, { label: string; tools: CatalogTool[] }>();
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
    skill.tools.length === 0 ? meta.instructionsOnly : meta.instructionsAndTools(skill.tools.length),
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
