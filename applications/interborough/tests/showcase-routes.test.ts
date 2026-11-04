/**
 * The unit-lane guard for the showcase specification (`tests/e2e/showcase.spec.ts`), which runs in
 * a browser outside `check`: every route in the table has an address to open, every address opens
 * the route it is named for, and no word of the showcase content is a run of more than 40
 * characters that no line can break at (the stress seed, `responsive.spec.ts`, is where those are).
 */
import { describe, expect, test } from 'bun:test';

import type { SampleWorldRecords } from '../fixtures/sample-world-records.ts';
import * as content from '../fixtures/showcase-content.ts';
import { routes } from '../src/app/routes.ts';
import { matchRoute } from '../src/lib/router.svelte.ts';
import {
  showcaseAddresses,
  showcaseVariantNames,
  showcaseVariants,
} from './e2e/showcase-routes.ts';

const SEED: SampleWorldRecords = {
  chats: {
    refund: 'chat-1',
    release: 'chat-2',
    sayHello: 'chat-3',
    lookUp4468: 'chat-4',
    billing: 'chat-5',
  },
  agent: 'agent-1',
  memory: 'memory-1',
  workflows: { releaseNotes: 'release', triageInbox: 'triage', orderRefund: 'refund' },
  runs: { failed: 'run-1', done: 'run-2', waiting: 'run-3', canceled: 'run-4' },
  schedules: {
    dailySummary: 'schedule-1',
    inboxTriage: 'schedule-2',
    releaseNotesDigest: 'schedule-3',
    weeklyRefundAudit: 'schedule-4',
  },
  goals: { sayHello: 'goal-1', draftReleaseNotes: 'goal-2', summarizeRefunds: 'goal-3' },
  hooks: {
    pageOnCall: 'hook-1',
    notifySlack: 'hook-2',
    triageFinishes: 'hook-3',
    scheduleMisses: 'hook-4',
    refundAudit: 'hook-5',
  },
  reviews: { waiting: 'bureau:review-1', decided: 'bureau:review-2' },
  toolSource: 'github',
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

  test('holds the sample world’s three workflow files', () => {
    expect(content.SHOWCASE_WORKFLOW_FILES.map((file) => file.id)).toEqual([
      'release-notes',
      'order-refund',
      'triage-inbox',
    ]);
  });

  test('has no word longer than 40 characters in any literal', () => {
    expect(literals.length).toBeGreaterThan(3);
    for (const { name, text } of literals) {
      expect(longestUnbrokenRun(text).length, `${name}: ${text.slice(0, 60)}`).toBeLessThanOrEqual(
        40,
      );
    }
  });
});
