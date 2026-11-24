import { expect, test } from 'bun:test';

import { loadFixture } from './fixture-loader.ts';

test('preserves an app fixture’s intentionally pending highlighting contract', async () => {
  const loaded = await loadFixture('delayed-code', 'assertion', {
    fixtureModules: {},
    hostModules: {},
    appHostModules: {
      './fixtures/delayed-code.svelte': async () => ({ default: {} as never }),
    },
    appFixtureDeclarations: {
      'delayed-code': [{ name: 'assertion', highlighting: 'intentionally-pending' }],
    },
  });

  expect(loaded.fixture).toMatchObject({
    name: 'assertion',
    highlighting: 'intentionally-pending',
  });
});
