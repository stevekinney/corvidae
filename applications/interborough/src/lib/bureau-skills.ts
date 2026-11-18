/**
 * The browser's view of the executable Agent Skills the host discovered: `bureau.skills.list`
 * (COR-1818), through the generated client. A skill from a source the host does not trust is listed
 * with `available: false` and the reason, and an agent is refused it where it would use it.
 */
import { bureauClient, type BureauOutput } from './bureau-api.ts';
import type { Fetcher } from './bureau-client.ts';

type Options = { readonly signal?: AbortSignal; readonly fetch?: Fetcher };

/** One executable skill: its description, where it came from, whether that source is trusted, the tools it asks to keep and the tools it brings. */
export type Skill = BureauOutput<'bureau.skills.list'>['skills'][number];

/** Whether the host trusts the source a skill came from. */
export type SkillTrust = Skill['trust'];

/**
 * A skill as a host that sends no `tools` has it: it brings none (COR-2022). The server's schema
 * requires the list, so this default belongs to the browser, applied to the typed result.
 */
export function skillWithTools(
  skill: Omit<Skill, 'tools'> & { readonly tools?: Skill['tools'] | undefined },
): Skill {
  return { ...skill, tools: skill.tools ?? [] };
}

/** The executable skills the host discovered, trusted or not, and how many sources it configured. */
export async function listSkillCatalog(
  options?: Options,
): Promise<{ readonly skills: readonly Skill[]; readonly sourceCount: number }> {
  const catalog = await bureauClient['bureau.skills.list']({}, options);
  // Only how many sources the host configured is read: a source with no skills is still a source.
  return { skills: catalog.skills.map(skillWithTools), sourceCount: catalog.sources.length };
}

/** The executable skills the host discovered, trusted or not. */
export async function listSkills(options?: Options): Promise<readonly Skill[]> {
  const catalog = await listSkillCatalog(options);
  return catalog.skills;
}
