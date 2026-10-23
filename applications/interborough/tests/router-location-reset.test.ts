/**
 * The preload returns the router to the root after every test, so one file's navigation never
 * decides what a later file's view renders (COR-1676). The second test would see `/runs/run-1`
 * without it, because the first leaves the router there on purpose.
 */
import { describe, expect, test } from 'bun:test';

import { router } from '../src/lib/router.svelte.ts';
import { landAt } from '../src/routes/chat/pages.test-support.ts';

describe('the router between tests', () => {
  test('a test may navigate and leave the router at that address', () => {
    landAt('/runs/run-1');
    expect(router.pathname).toBe('/runs/run-1');
  });

  test('the next test starts at the root', () => {
    expect(router.pathname).toBe('/');
    expect(window.location.pathname).toBe('/');
  });
});
