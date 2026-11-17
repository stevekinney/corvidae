/**
 * A run's tags as the Details rail says them (rows 54j, 55d, 55h): the tags a person gave it, and a
 * count of the system tags the Bureau and the engine put on it (`origin:goal`, `origin:schedule`,
 * `origin-parent:<run>`), which are counted, never listed, and never edited by hand.
 */

/** Whether `tag` is one the system set: an `origin:` or `origin-` tag. */
export function isSystemTag(tag: string): boolean {
  return tag.startsWith('origin:') || tag.startsWith('origin-');
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
