/**
 * The unit-lane guard for the showcase specification (`tests/e2e/showcase.spec.ts`), which runs in
 * a browser outside `check`: every route in the table has an address to open, every address opens
 * the route it is named for, and no word of the showcase content is a run of more than 40
 * characters that no line can break at (the stress seed, `responsive.spec.ts`, is where those are).
 */
import { describe, expect, test } from 'bun:test';

import * as content from '../fixtures/showcase-content.ts';
import type { ShowcaseSeed } from '../fixtures/showcase-seed.ts';
import { routes } from '../src/app/routes.ts';
import { matchRoute } from '../src/lib/router.svelte.ts';
import {
  showcaseAddresses,
  showcaseVariantNames,
  showcaseVariants,
} from './e2e/showcase-routes.ts';

const SEED: ShowcaseSeed = {
  agents: ['agent-1', 'agent-2'],
  instructionsAgent: 'agent-2',
  memoryAgent: 'agent-1',
  memory: 'memory-1',
  memories: ['memory-1'],
  chats: {
    release: 'chat-1',
    'refund-denied': 'chat-2',
    'refund-waiting': 'chat-3',
    'refund-approved': 'chat-4',
    question: 'chat-5',
    'model-picker': 'chat-6',
    attachment: 'chat-7',
    failed: 'chat-8',
  },
  workflows: { digest: 'digest', review: 'review', sync: 'sync' },
  runs: { succeeded: 'run-1', failed: 'run-2', running: 'run-3', cancelled: 'run-4' },
  schedules: ['schedule-1', 'schedule-2', 'schedule-3'],
  hooks: ['hook-1', 'hook-2'],
  goals: ['goal-1', 'goal-2'],
  reviews: { waiting: 'bureau:review-1', decided: 'bureau:review-2' },
  created: [],
};

const PATTERNS = routes.filter((route) => route.redirect === undefined).map((r) => r.pattern);

describe('the showcase specification’s routes', () => {
  test('has an address for every route that renders, and for no other', () => {
    expect(Object.keys(showcaseAddresses(SEED)).toSorted()).toEqual(PATTERNS.toSorted());
  });

  test('opens each route’s address on that route', () => {
    for (const [pattern, address] of Object.entries(showcaseAddresses(SEED))) {
      expect(matchRoute(address.split('?')[0]!)?.pattern, address).toBe(pattern);
    }
  });

  test('opens each variant’s address on the route it is named for', () => {
    const variants = Object.entries(showcaseVariants(SEED));
    expect(variants.length).toBeGreaterThan(0);
    for (const [name, address] of variants) {
      expect(matchRoute(address.split('?')[0]!)?.pattern, address).toBe(name.split(' ')[0]);
    }
  });

  test('names the same variants whatever the seed holds', () => {
    expect(showcaseVariantNames()).toEqual(Object.keys(showcaseVariants(SEED)));
  });
});

/** Every string inside `value`, however deeply it is nested. */
function stringsIn(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(stringsIn);
  return [];
}

/** The longest run of characters in `text` with no whitespace in it. */
function longestUnbrokenRun(text: string): string {
  return text
    .split(/\s+/)
    .reduce((longest, word) => (word.length > longest.length ? word : longest), '');
}

describe('the showcase content', () => {
  const literals = Object.entries(content).flatMap(([name, value]) =>
    stringsIn(value).map((text) => ({ name, text })),
  );

  test('holds the minimum the design review needs', () => {
    expect(content.SHOWCASE_AGENTS.length).toBeGreaterThanOrEqual(6);
    expect(content.SHOWCASE_AGENTS.some((agent) => (agent.memories?.length ?? 0) > 0)).toBe(true);
    expect(
      new Set(content.SHOWCASE_AGENTS.map((agent) => agent.definition['description'])).size,
    ).toBe(content.SHOWCASE_AGENTS.length);
    expect(Object.keys(content.SHOWCASE_CHATS).length).toBeGreaterThanOrEqual(5);
    expect(Object.keys(content.SHOWCASE_WORKFLOWS)).toHaveLength(3);
    expect(new Set(content.SHOWCASE_SCHEDULES.map((schedule) => schedule.timeZone)).size).toBe(3);
    expect(content.SHOWCASE_SCHEDULES.filter((schedule) => schedule.paused)).toHaveLength(1);
    expect(content.SHOWCASE_HOOKS).toHaveLength(2);
    expect(content.SHOWCASE_GOALS).toHaveLength(2);
  });

  test('has no word longer than 40 characters in any literal', () => {
    expect(literals.length).toBeGreaterThan(50);
    for (const { name, text } of literals) {
      expect(longestUnbrokenRun(text).length, `${name}: ${text.slice(0, 60)}`).toBeLessThanOrEqual(
        40,
      );
    }
  });
});
