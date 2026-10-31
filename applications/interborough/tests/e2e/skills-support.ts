/**
 * The executable skills the end-to-end host starts with (`e2e-server.ts`): two sources in its
 * configuration, one the host trusts and one it does not, so the Capabilities page has a trusted
 * and an untrusted skill to show. One skill carries a long name, a long description with an
 * unbroken word in it, and several allowed tools, for the responsive specification. The names live
 * here, apart from the code that writes the directories (`skills-seed.ts`), so a unit test can read
 * them without loading the file system code.
 */
/** The skill sources the host is configured with. */
export const E2E_SKILL_SOURCES = { trusted: 'e2e-home', untrusted: 'e2e-workspace' } as const;

/** A skill name is at most 64 characters of lowercase letters, digits and hyphens. */
export const E2E_LONG_SKILL = `responsive-skill-${'k'.repeat(47)}`;

/** The unbroken word in the long skill's description. */
export const E2E_LONG_SKILL_WORD = `skillword-${'w'.repeat(290)}`;

/** The seeded skills, by source. */
export const E2E_SKILLS = {
  summarize: { name: 'e2e-summarize', source: E2E_SKILL_SOURCES.trusted },
  long: { name: E2E_LONG_SKILL, source: E2E_SKILL_SOURCES.trusted },
  deploy: { name: 'e2e-deploy', source: E2E_SKILL_SOURCES.untrusted },
} as const;

/** The key ListDetail gives a skill in the address: its source, then its name. */
export function skillAddressKey(skill: { readonly source: string; readonly name: string }): string {
  return `${skill.source}/${skill.name}`;
}
