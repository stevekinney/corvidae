/**
 * A run's tags as the Details rail says them (rows 54j, 55d, 55h): the tags a person gave it, and a
 * count of the system tags the Bureau and the engine put on it (`origin:goal`, `origin:schedule`,
 * `origin-parent:<run>`, `bureau-steering-run:<hash>`, `hook-origin:<hook>`), which are counted,
 * never listed, and never edited by hand.
 */

/**
 * The Bureau's reserved run tag prefixes (`RESERVED_RUN_TAG_PREFIXES` in `@lostgradient/bureau`),
 * mirrored because the page cannot load the Bureau's package in a browser. `run-tags-fact.test.ts`
 * fails when the Bureau reserves a prefix this list does not hold.
 */
export const SYSTEM_TAG_PREFIXES: readonly string[] = [
  'origin:',
  'origin-parent:',
  'origin-parent-sha256:',
  'bureau-steering-run:',
  'hook-origin:',
];

/** Whether `tag` is one the system set, by {@link SYSTEM_TAG_PREFIXES}. */
export function isSystemTag(tag: string): boolean {
  return SYSTEM_TAG_PREFIXES.some((prefix) => tag.startsWith(prefix));
}

/** The tags a person may edit, in their order. */
export function editableRunTags(tags: readonly string[] | null | undefined): string[] {
  return (tags ?? []).filter((tag) => !isSystemTag(tag));
}

/** The Tags row's value: the person's tags, and how many system tags there are besides. */
export function runTagsFact(tags: readonly string[] | null | undefined): {
  readonly tags: string[];
  readonly systemTagCount: number;
} {
  const all = tags ?? [];
  const editable = editableRunTags(all);
  return { tags: editable, systemTagCount: all.length - editable.length };
}
