/**
 * The browser's view of the executable Agent Skills the host discovered: `bureau.skills.list`
 * (COR-1818), parsed at the boundary. A skill from a source the host does not trust is listed with
 * `available: false` and the reason, and an agent is refused it where it would use it.
 */
import { z } from 'zod';

import { callBureau, type Fetcher } from './bureau-client.ts';

type Options = { readonly signal?: AbortSignal; readonly fetch?: Fetcher };

const sourceKindSchema = z.enum(['project', 'user', 'built-in', 'remote', 'storage', 'plugin']);
const trustSchema = z.enum(['trusted', 'untrusted', 'revoked']);

const skillSchema = z.object({
  name: z.string(),
  description: z.string(),
  source: z.object({
    id: z.string(),
    kind: sourceKindSchema,
    location: z.string(),
    plugin: z.string().nullable(),
  }),
  trust: trustSchema,
  trustReason: z.string(),
  available: z.boolean(),
  unavailableReason: z.string().nullable(),
  allowedTools: z.array(z.string()),
});

const skillsSchema = z.object({
  skills: z.array(skillSchema),
  // Only how many sources the host configured is read: a source with no skills is still a source.
  sources: z.array(z.unknown()),
});

/** One executable skill: its description, where it came from, whether that source is trusted, and the tools it asks to keep. */
export type Skill = z.infer<typeof skillSchema>;

/** Whether the host trusts the source a skill came from. */
export type SkillTrust = Skill['trust'];

/** The executable skills the host discovered, trusted or not, and how many sources it configured. */
export async function listSkillCatalog(
  options?: Options,
): Promise<{ readonly skills: readonly Skill[]; readonly sourceCount: number }> {
  const parsed = skillsSchema.parse(await callBureau('bureau.skills.list', {}, options));
  return { skills: parsed.skills, sourceCount: parsed.sources.length };
}

/** The executable skills the host discovered, trusted or not. */
export async function listSkills(options?: Options): Promise<readonly Skill[]> {
  const catalog = await listSkillCatalog(options);
  return catalog.skills;
}
