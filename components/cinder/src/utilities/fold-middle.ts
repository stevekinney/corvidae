/**
 * A list of rows that keeps its first and last few and folds the middle behind one control, so a
 * long run keeps the shape of the page. Rows that must stay visible wherever they fall (a failure,
 * a call waiting on a person) are pinned: they split the folded middle into separate groups, and
 * each group counts only the rows it hides.
 */

/** One row of the list the fold is planned for, or one group of rows it hides. */
export type FoldPlanEntry<Item> =
  | {
      /** A row that stays visible. */
      readonly kind: 'item';
      /** The row. */
      readonly item: Item;
      /** Where the row sits in the list that was planned. */
      readonly index: number;
    }
  | {
      /** A run of rows folded behind one control. */
      readonly kind: 'group';
      /** The index of the group's first row, which names the group. */
      readonly key: number;
      /** The rows the group hides, in order. */
      readonly items: readonly Item[];
      /** Where the group's first row sits in the list that was planned. */
      readonly index: number;
    };

/** How a fold keeps rows. */
export type FoldOptions<Item> = {
  /** How many rows stay visible at the start. @default 3 */
  readonly first?: number;
  /** How many rows stay visible at the end. @default 3 */
  readonly last?: number;
  /**
   * The fewest rows a group may hide. A group of one hides a row to show a control of the same
   * height, which saves nothing, so a run shorter than this stays visible. @default 2
   */
  readonly minimumHidden?: number;
  /** Rows that stay visible wherever they fall, and split the folded middle. */
  readonly isPinned?: (item: Item, index: number) => boolean;
};

/**
 * Plans which rows show and which fold. A list too short to hide `minimumHidden` rows between its
 * first and last few is returned whole.
 */
export function planFold<Item>(
  items: readonly Item[],
  options: FoldOptions<Item> = {},
): FoldPlanEntry<Item>[] {
  const first = Math.max(0, Math.floor(options.first ?? 3));
  const last = Math.max(0, Math.floor(options.last ?? 3));
  const minimumHidden = Math.max(1, Math.floor(options.minimumHidden ?? 2));
  const isPinned = options.isPinned;
  const plan: FoldPlanEntry<Item>[] = [];
  let run: { start: number; items: Item[] } | undefined;

  const closeRun = (): void => {
    if (run === undefined) return;
    if (run.items.length >= minimumHidden) {
      plan.push({ kind: 'group', key: run.start, items: run.items, index: run.start });
    } else {
      run.items.forEach((item, offset) =>
        plan.push({ kind: 'item', item, index: (run?.start ?? 0) + offset }),
      );
    }
    run = undefined;
  };

  items.forEach((item, index) => {
    const kept = index < first || index >= items.length - last || isPinned?.(item, index) === true;
    if (kept) {
      closeRun();
      plan.push({ kind: 'item', item, index });
      return;
    }
    run ??= { start: index, items: [] };
    run.items.push(item);
  });
  closeRun();
  return plan;
}

/**
 * Says what a folded group holds: the names that appear most, each with how many times when it
 * appears more than once ("Lookup order ×10, Check inventory ×4"), and the rows of every other name
 * counted together ("6 others"). Names with the same count keep the order they first appeared in.
 * @param names - One name per hidden row, in order.
 * @param shown - How many names to list before the rest are counted. @default 3
 */
export function summarizeFoldedNames(names: readonly string[], shown = 3): string {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  const ranked = [...counts].sort((left, right) => right[1] - left[1]);
  const listed = ranked.slice(0, shown);
  const rest = ranked.slice(shown).reduce((total, [, count]) => total + count, 0);
  const parts = listed.map(([name, count]) => (count > 1 ? `${name} ×${count}` : name));
  if (rest > 0) parts.push(`${rest} ${rest === 1 ? 'other' : 'others'}`);
  return parts.join(', ');
}
