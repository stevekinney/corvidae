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
});
