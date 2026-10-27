/**
 * Importing the route outlet's test harness loads every route's component, so no test that mounts
 * it pays a route's first import inside its own wait.
 */
import { describe, expect, test } from 'bun:test';

import { routes } from '../routes.ts';
import { routeComponents } from './route-modules.test-support.ts';
import Harness from './route-outlet.test-harness.svelte';

/** Whether `promise` settles before the next macrotask; an evaluated module's import does. */
async function settlesAtOnce(promise: Promise<unknown>): Promise<boolean> {
  const later = new Promise<false>((resolve) => setTimeout(() => resolve(false), 0));
  return Promise.race([promise.then(() => true), later]);
}

describe('the route outlet harness', () => {
  test('has loaded every route’s component by the time it is imported', async () => {
    const pending: string[] = [];
    for (const route of routes) {
      if (!(await settlesAtOnce(route.load()))) pending.push(route.pattern);
    }

    expect(Harness).toBeDefined();
    expect(routeComponents).toHaveLength(routes.length);
    expect(pending).toEqual([]);
  });

  test('hands routes that share a component the one evaluated module', async () => {
    // Importing a not-yet-evaluated module from several places at once drops the file from Bun's
    // coverage report (the placeholder area's floor failed on it), so the harness loads in turn.
    const sharing = routes.filter((route) => route.load === routes[0]?.load);
    expect(sharing.length).toBeGreaterThan(1);
    const loaded = await Promise.all(sharing.map((route) => route.load()));
    expect(new Set(loaded.map((module) => module.default)).size).toBe(1);
    expect(routeComponents[0]).toBe(loaded[0]?.default);
  });
});
