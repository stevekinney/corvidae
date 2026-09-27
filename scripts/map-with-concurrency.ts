/**
 * How many files a repository scan reads at once.
 *
 * Awaiting one read at a time makes a scan cost one event-loop round trip per file, and each of
 * those round trips stretches with host scheduling latency: thousands of them on a machine running
 * several agents at once cost seconds and timed out tests that do the same work in well under one on
 * a quiet host. Reading this many at a time turns the scan into a few dozen rounds instead.
 */
export const fileReadConcurrency = 64;

/**
 * `items.map(transform)` with at most `limit` transforms in flight, resolving to the results in
 * input order. The first rejection rejects the whole map, and no further item is started after it.
 */
export async function mapWithConcurrency<Item, Result>(
  items: readonly Item[],
  limit: number,
  transform: (item: Item, index: number) => Promise<Result>,
): Promise<Result[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`concurrency limit must be a positive integer, received ${limit}`);
  }
  const results = Array.from<Result>({ length: items.length });
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (!failed && next < items.length) {
      const index = next++;
      try {
        results[index] = await transform(items[index] as Item, index);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
