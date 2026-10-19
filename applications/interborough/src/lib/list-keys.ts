/**
 * Keys for a keyed `{#each}` over server records that carry no unique id of their own.
 *
 * A key built from a record's fields (a timestamp and a digest, a reason, a path) collides when
 * the server reports two records alike, and Svelte answers a duplicate key by throwing
 * (`each_key_duplicate`), which takes the whole view down. The records are still distinct
 * entries, so each is kept and the key gains the number of earlier records that share its base:
 * the first keeps `base#0`, a second alike is `base#1`. The numbering follows list order, so a
 * record keeps its key across a refetch that returns the same sequence.
 *
 * Use this for every keyed list over server data without an id. A list over records that do
 * carry a unique server id (a workflow id, an operation id, a worker id) keys on that id.
 * `list-keys.guard.test.ts` names the lists that must go through here.
 *
 * @module
 */

export interface KeyedItem<T> {
  readonly key: string;
  readonly item: T;
}

/** Pairs each item with a key that stays unique when `keyOf` returns the same base twice. */
export function keyedByOccurrence<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
): readonly KeyedItem<T>[] {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const base = keyOf(item);
    const occurrence = seen.get(base) ?? 0;
    seen.set(base, occurrence + 1);
    return { key: `${base}#${occurrence}`, item };
  });
}
