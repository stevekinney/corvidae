import { BASELINE_REVISIONS, type MemoryBaselineAdapter, type RecallRequest } from './adapter';

/**
 * The floor: a deployment with no memory. It retains nothing, so a deletion
 * has nothing to remove and every recall comes back empty. Whatever it gets
 * right, it gets right without memory.
 */
export function createNoMemoryBaseline(): MemoryBaselineAdapter {
  return {
    name: 'no-memory',
    revision: BASELINE_REVISIONS['no-memory'],
    components: [],
    observe: () => Promise.resolve('not-retained'),
    forget: () => Promise.resolve({ status: 'not-retained', receipted: false }),
    restart: () => Promise.resolve(),
    recall: ({ query, limit }: RecallRequest) =>
      Promise.resolve({
        plan: { strategy: 'none', scope: 'none', query, limit },
        items: [],
        withheld: 0,
      }),
    close: () => Promise.resolve(),
  };
}
