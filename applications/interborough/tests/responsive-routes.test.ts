/**
 * The unit-lane guard for the responsive specification (`tests/e2e/responsive.spec.ts`), which runs
 * in a browser outside `check`: every route in the table has an address to open, and every route
 * still pending names an owning issue and a route that exists.
 */
import { describe, expect, test } from 'bun:test';

import { routes } from '../src/app/routes.ts';
import { matchRoute } from '../src/lib/router.svelte.ts';
import { pending, responsiveAddresses, responsiveVariants } from './e2e/responsive-routes.ts';

const SEED = {
  chat: 'chat-1',
  agent: 'agent-1',
  instructionsAgent: 'agent-3',
  memoryAgent: 'agent-2',
  memory: 'memory-1',
  workflow: 'order-processing',
  workflowFile: 'digest',
  run: 'run-1',
  schedule: 'schedule-1',
  goal: 'goal-1',
  hook: 'hook-1',
  review: 'bureau:review-1',
  decidedReview: 'bureau:review-2',
} as const;

const PATTERNS = routes.filter((route) => route.redirect === undefined).map((r) => r.pattern);

describe('the responsive specification’s routes', () => {
  test('has an address for every route that renders, and for no other', () => {
    expect(Object.keys(responsiveAddresses(SEED)).toSorted()).toEqual(PATTERNS.toSorted());
  });

  test('opens each route’s address on that route', () => {
    for (const [pattern, address] of Object.entries(responsiveAddresses(SEED))) {
      expect(matchRoute(address.split('?')[0]!)?.pattern, address).toBe(pattern);
    }
  });

  test('opens each variant’s address on the route it is named for', () => {
    const variants = Object.entries(responsiveVariants(SEED));
    expect(variants.length).toBeGreaterThan(0);
    for (const [name, address] of variants) {
      expect(matchRoute(address.split('?')[0]!)?.pattern, address).toBe(name.split(' ')[0]);
    }
  });

  test('lists each pending route once, with an owning Linear issue', () => {
    for (const entry of pending) {
      expect(PATTERNS, entry.pattern).toContain(entry.pattern);
      expect(entry.issue, entry.pattern).toMatch(/^COR-\d+$/);
      for (const width of entry.failsAt ?? []) expect([375, 768, 1280]).toContain(width);
    }
    expect(new Set(pending.map((entry) => entry.pattern)).size).toBe(pending.length);
  });
});
