import { throwingRejectionOf } from '@lostgradient/testing/promise-outcome';
import { QueryClient } from '@tanstack/svelte-query';
import { expect, it } from 'bun:test';
import { createCatalogHost } from './index.ts';
import { createPagination } from './pagination.ts';

it('ignores inherited cursors and item identity fields', async () => {
  const cache = new QueryClient();
  let calls = 0;
  const host = createCatalogHost({
    scope: 'a',
    cache,
    transport: async () => {
      calls++;
      return { items: [{ id: 'inherited' }], next: null, total: 2 };
    },
  });
  const input = () => ({});
  const fields = {
    items: 'items',
    cursorInput: 'cursor',
    nextCursor: 'next',
    total: 'total',
    itemKey: ['id'],
  };
  const pages = createPagination(host, 'list', input, fields);
  cache.setQueryData(
    host.key('list', input()),
    Object.assign(Object.create({ next: 'inherited' }), { items: [] }),
  );
  await pages.loadMore();
  expect(calls).toBe(0);
  const inheritedItem = Object.create({ id: 'inherited' });
  cache.setQueryData(host.key('list', input()), { items: [inheritedItem], next: 'next' });
  await pages.loadMore();
  expect(calls).toBe(1);
  const result = cache.getQueryData<{ items: unknown[] }>(host.key('list', input()));
  expect(result?.items).toHaveLength(2);
});

it('rejects inherited page items and totals', async () => {
  for (const inherited of ['current-items', 'next-items', 'next-total']) {
    const cache = new QueryClient();
    const next =
      inherited === 'next-items'
        ? Object.assign(Object.create({ items: [] }), { next: null, total: 1 })
        : inherited === 'next-total'
          ? Object.assign(Object.create({ total: 1 }), { items: [], next: null })
          : { items: [], next: null, total: 1 };
    const host = createCatalogHost({ scope: 'a', cache, transport: async () => next });
    const input = () => ({});
    const current =
      inherited === 'current-items'
        ? Object.assign(Object.create({ items: [] }), { next: 'cursor' })
        : { items: [], next: 'cursor' };
    cache.setQueryData(host.key('list', input()), current);
    const pages = createPagination(host, 'list', input, {
      items: 'items',
      cursorInput: 'cursor',
      nextCursor: 'next',
      total: 'total',
      itemKey: ['id'],
    });
    expect(await throwingRejectionOf(pages.loadMore())).toThrow('Invalid page');
  }
});

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
