import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { expect, test } from 'bun:test';
import { startWithBrowserBuild } from './browser-build.ts';

test('starts host preparation while the browser build is pending', async () => {
  const build = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const starting = startWithBrowserBuild({
    build: () => build.promise,
    start: async (ready) => {
      entered.resolve();
      await ready;
      return 'host';
    },
    stop: async () => {},
  });
  await entered.promise;
  build.resolve();
  expect(await starting).toBe('host');
});

test('a failed build fails startup and stops outstanding builds', async () => {
  const failure = new Error('build failed');
  let stops = 0;
  const starting = startWithBrowserBuild({
    build: () => Promise.reject(failure),
    start: async (ready) => {
      await ready;
      return 'host';
    },
    stop: async () => {
      stops += 1;
    },
  });
  expect(await rejectionOf(starting)).toBe(failure);
  expect(stops).toBe(1);
});

test('a failed host start stops and settles its pending browser build', async () => {
  const failure = new Error('host failed');
  const build = Promise.withResolvers<void>();
  let stops = 0;
  const starting = startWithBrowserBuild({
    build: () => build.promise,
    start: async () => {
      throw failure;
    },
    stop: async () => {
      stops += 1;
      build.reject(new Error('stopped'));
    },
  });
  expect(await rejectionOf(starting)).toBe(failure);
  expect(stops).toBe(1);
});
