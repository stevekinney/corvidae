/**
 * Every Weft run tag the Bureau or the engine sets on a run for its own bookkeeping, by prefix, so
 * a client can tell a system tag from one a person gave a run: a page counts these and never lists
 * them as a person's, never offers them for editing, and never shows a 40-character hash as a tag.
 *
 * - `origin:<kind>`: where the run came from (`taskOriginTag`, and Weft's `origin:schedule`);
 * - `origin-parent:<run>` and `origin-parent-sha256:<hash>`: the run that started it
 *   (`taskOriginParentTag`);
 * - `bureau-steering-run:<hash>`: the session incarnation durable steering finds it by
 *   (`steeringSessionRunTag`);
 * - `hook-origin:<hook>`: the hook that started a workflow instance (`hookOriginTag`).
 *
 * `reserved-tag-prefixes.test.ts` holds each tag function to this list, so a new system tag that
 * no prefix here covers fails it, and Interborough's `run-tags.test.ts` fails when a prefix here is
 * one its page does not count as a system tag.
 */
export const RESERVED_RUN_TAG_PREFIXES = [
  'origin:',
  'origin-parent:',
  'origin-parent-sha256:',
  'bureau-steering-run:',
  'hook-origin:',
] as const;

/** Whether `tag` is one the Bureau or the engine set, by {@link RESERVED_RUN_TAG_PREFIXES}. */
export function isReservedRunTag(tag: string): boolean {
  return RESERVED_RUN_TAG_PREFIXES.some((prefix) => tag.startsWith(prefix));
}
