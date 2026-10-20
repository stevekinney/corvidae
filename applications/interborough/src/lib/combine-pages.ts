/**
 * Joins the pages of an offset-paged query into one list of rows.
 *
 * The Bureau pages by offset, and a list that is newest first shifts while it is read: a record
 * created between two page reads pushes the previous page's last row onto the next page. The
 * rows then hold one key twice, and a keyed `{#each}` over them throws (`each_key_duplicate`),
 * which takes the whole route down. A row is the same record when its key is, so the first
 * occurrence stays and a later one is dropped.
 *
 * Use this for every list that combines the pages of an infinite query.
 * `combine-pages.guard.test.ts` names the lists that must go through here.
 *
 * @module
 */

/** The rows of every loaded page in page order, each key kept once (its first occurrence). */
export function combinePages<Page, Row>(
  pages: readonly Page[] | undefined,
  rowsOf: (page: Page) => readonly Row[],
  keyOf: (row: Row) => string,
): Row[] {
  const seen = new Set<string>();
  const rows: Row[] = [];
  for (const page of pages ?? []) {
    for (const row of rowsOf(page)) {
      const key = keyOf(row);
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(row);
    }
  }
  return rows;
}
