/**
 * How the Capabilities page says what the catalog and the skill list hold: the words for a tool's
 * tier, default approval and source, and for a skill's trust and why it is unavailable. Every
 * answer is a function of an enumerated value, so a value this build does not know still reads.
 */
import { CAPABILITIES_COPY } from '../../app/copy.ts';
import type { AgentCatalog } from '../../lib/agent-definitions.ts';
import type { Skill } from '../../lib/bureau-skills.ts';
import type { ToolSourceStanding, ToolSourceTool } from '../../lib/host-tool-sources.ts';
import { standingOf, type ToolStanding } from '../../lib/tool-standing.ts';

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

/** A sentence saying what a tier means. */
export function tierDescription(tier: ToolTier): string {
  return TOOL.tierDescription[tier];
}

/** The words for what happens by default when an agent calls the tool. */
export function approvalLabel(tool: CatalogTool): string {
  return TOOL.approvals[tool.defaultApproval];
}

/** The words for where a tool comes from. */
export function toolSourceLabel(tool: CatalogTool): string {
  if (tool.source === 'plugin') return TOOL.sources.plugin(tool.plugin ?? '');
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
export function sourceToolTier(tool: ToolSourceTool): ToolTier {
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
