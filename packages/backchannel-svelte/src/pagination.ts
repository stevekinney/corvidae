import { hashKey } from '@tanstack/svelte-query';
import type { CatalogHost } from './index.ts';

/** Producer-declared fields of a cursor-paged read. */
export type PaginationFields = {
  readonly items: string;
  readonly cursorInput: string;
  readonly nextCursor: string;
  readonly total: string;
  readonly itemKey: readonly string[];
  readonly cursorFilters?: readonly string[];
};

/** Extend a scoped cached result with a page, keeping identity and total bounds. */
export function createPagination(
  host: CatalogHost,
  operation: string,
  input: () => unknown,
  fields: PaginationFields,
) {
  const descriptor = { ...fields, itemKey: [...fields.itemKey] };
  let pending: Promise<void> | undefined;
  return {
    loadMore() {
      if (pending) return pending;
      const currentInput = JSON.parse(JSON.stringify(input())) as Record<string, unknown>;
      const key = host.key(operation, currentInput);
      const keyHash = hashKey(key);
      const current = host.cache.getQueryData<Record<string, unknown>>(key);
      const cursor = current?.[descriptor.nextCursor];
      if (cursor == null) return Promise.resolve();
      pending = (async () => {
        const next = (await host.call(operation, {
          ...currentInput,
          [descriptor.cursorInput]: cursor,
        })) as Record<string, unknown>;
        if (
          host.disposed ||
          hashKey(host.key(operation, input())) !== keyHash ||
          host.cache.getQueryData(key) !== current
        )
          return;
        const before = current?.[descriptor.items];
        const after = next[descriptor.items];
        const total = next[descriptor.total];
        if (
          !Array.isArray(before) ||
          !Array.isArray(after) ||
          typeof total !== 'number' ||
          total < 0
        )
          throw new Error(`Invalid page from ${operation}`);
        const seen = new Set<string>();
        const items = [...before, ...after]
          .filter((item: Record<string, unknown>) => {
            const identity = JSON.stringify(descriptor.itemKey.map((field) => item[field]));
            if (seen.has(identity)) return false;
            seen.add(identity);
            return true;
          })
          .slice(0, total);
        host.cache.setQueryData(key, { ...next, [descriptor.items]: items });
      })().finally(() => {
        pending = undefined;
      });
      return pending;
    },
  };
}
