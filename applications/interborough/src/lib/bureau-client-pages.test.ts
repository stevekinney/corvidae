import { afterEach, describe, expect, test } from 'bun:test';

import { listAllContexts } from './bureau-client.ts';
import { contextFixture } from './bureau-fixtures.test-support.ts';
import { installBureauStub, type BureauStub } from './bureau-stub.test-support.ts';

let stub: BureauStub | undefined;
afterEach(() => {
  stub?.restore();
  stub = undefined;
});

describe('every session the Bureau holds', () => {
  test('is read a page at a time, following the offset until the Bureau has no more', async () => {
    const all = Array.from({ length: 5 }, (_, index) => contextFixture(`chat-${String(index)}`));
    stub = installBureauStub({
      'bureau.contexts.list': (params) => {
        const offset = typeof params['offset'] === 'number' ? params['offset'] : 0;
        // The Bureau answers no more than two to a page, however many are asked for.
        const page = all.slice(offset, offset + 2);
        return { contexts: page, nextOffset: offset + 2 < all.length ? offset + 2 : null };
      },
    });

    const contexts = await listAllContexts();

    expect(contexts.map((context) => context.id)).toEqual(all.map((context) => context.id));
    expect(stub.callsTo('bureau.contexts.list').map((call) => call.params['offset'])).toEqual([
      0, 2, 4,
    ]);
  });

  test('is not read for ever from a Bureau whose offset does not move', async () => {
    stub = installBureauStub({
      'bureau.contexts.list': () => ({ contexts: [contextFixture('chat-0')], nextOffset: 0 }),
    });

    expect(await listAllContexts()).toHaveLength(1);
    expect(stub.callsTo('bureau.contexts.list')).toHaveLength(1);
  });
});
