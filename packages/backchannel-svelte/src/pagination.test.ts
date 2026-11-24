import { QueryClient } from '@tanstack/svelte-query';
import { expect, it } from 'bun:test';
import { createCatalogHost } from './index.ts';
import { createPagination } from './pagination.ts';

it('deduplicates pages by composite identity and respects the declared total', async () => {
  const cache = new QueryClient();
  const host = createCatalogHost({
    scope: 'a',
    cache,
    transport: async () => ({ items: [{ id: 2 }, { id: 3 }], next: null, total: 2 }),
  });
  const input = () => ({ cursor: undefined });
  cache.setQueryData(host.key('list', input()), {
    items: [{ id: 1 }, { id: 2 }],
    next: 'second',
    total: 2,
  });
  const pages = createPagination(host, 'list', input, {
    items: 'items',
    cursorInput: 'cursor',
    nextCursor: 'next',
    total: 'total',
    itemKey: ['id'],
  });
  await pages.loadMore();
  expect(cache.getQueryData(host.key('list', input()))).toEqual({
    items: [{ id: 1 }, { id: 2 }],
    next: null,
    total: 2,
  });
});

it('discards a late page after the input changes', async () => {
  const cache = new QueryClient();
  let finish!: (value: unknown) => void;
  const host = createCatalogHost({
    scope: 'a',
    cache,
    transport: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  let filter = 'one';
  const input = () => ({ filter });
  const initial = { items: [{ id: 1 }], next: 'second', total: 2 };
  cache.setQueryData(host.key('list', input()), initial);
  const pages = createPagination(host, 'list', input, {
    items: 'items',
    cursorInput: 'cursor',
    nextCursor: 'next',
    total: 'total',
    itemKey: ['id'],
  });
  const request = pages.loadMore();
  filter = 'two';
  finish({ items: [{ id: 2 }], next: null, total: 2 });
  await request;
  expect(cache.getQueryData(host.key('list', { filter: 'one' }))).toEqual(initial);
  expect(cache.getQueryData(host.key('list', { filter: 'two' }))).toBeUndefined();
});

it('appends unseen composite identities from the next cursor', async () => {
  const cache = new QueryClient();
  const inputs: unknown[] = [];
  const host = createCatalogHost({
    scope: 'a',
    cache,
    transport: async (_operation, input) => {
      inputs.push(input);
      return {
        items: [
          { tenant: 'a', id: 1 },
          { tenant: 'b', id: 1 },
        ],
        next: null,
        total: 2,
      };
    },
  });
  const input = () => ({ filter: 'active' });
  cache.setQueryData(host.key('list', input()), {
    items: [{ tenant: 'a', id: 1 }],
    next: 'cursor-1',
    total: 2,
  });
  const pages = createPagination(host, 'list', input, {
    items: 'items',
    cursorInput: 'cursor',
    nextCursor: 'next',
    total: 'total',
    itemKey: ['tenant', 'id'],
  });
  await pages.loadMore();
  expect(inputs).toEqual([{ filter: 'active', cursor: 'cursor-1' }]);
  expect(cache.getQueryData(host.key('list', input()))).toEqual({
    items: [
      { tenant: 'a', id: 1 },
      { tenant: 'b', id: 1 },
    ],
    next: null,
    total: 2,
  });
});
