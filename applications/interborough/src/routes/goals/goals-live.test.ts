/**
 * `/goals` reads the goals again when `bureau.events` reports a goal event, and on a timer only
 * while a goal has not ended and the Bureau’s feed is not live (COR-1725). The feed is the real
 * source over a stubbed stream, and TanStack Query’s refetch interval is the timer, so the clock is
 * faked and moved by hand.
 */
import { HttpClient } from '@lostgradient/weft';
import { cleanup, render } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';

import RouteOutletHarness from '../../app/shell/route-outlet.test-harness.svelte';
import { goalFixture } from '../../lib/bureau-fixtures.test-support.ts';
import type { Goal } from '../../lib/bureau-goals.ts';
import { installBureauStub, type BureauStub } from '../../lib/bureau-stub.test-support.ts';
import { until } from '../../lib/fake-timers.test-support.ts';
import { createLiveFeeds, type LiveFeeds } from '../../lib/live-source/live-feeds.test-support.ts';
import { AUTHORIZATION_SCOPES } from '../../lib/scopes.svelte.ts';
import { landAt } from '../chat/pages.test-support.ts';

/** How often the page reads again while a goal runs and the feed is not live (`index.svelte`). */
const GOAL_POLL_MILLISECONDS = 1_500;
/** The page reads fifty goals at a time; the probe behind the view’s states reads one. */
const PAGE_SIZE = 50;

let stub: BureauStub | undefined;
let feeds: LiveFeeds | undefined;
let goals: Goal[];

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  cleanup();
  feeds?.close();
  feeds = undefined;
  stub?.restore();
  stub = undefined;
  jest.useRealTimers();
});

function open(initial: Goal[]): void {
  goals = initial;
  stub = installBureauStub({
    'bureau.goals.list': () => ({ goals, nextOffset: null }),
    'bureau.deployment.get': () => ({ id: 'bureau-1' }),
  });
  feeds = createLiveFeeds();
  landAt('/goals');
  render(RouteOutletHarness, {
    props: {
      client: new HttpClient({ baseUrl: 'http://localhost/api' }),
      scopes: AUTHORIZATION_SCOPES,
      bureauEvents: feeds.bureauEvents,
      fleetEvents: feeds.fleetEvents,
    },
  } as never);
}

const reads = () =>
  stub?.callsTo('bureau.goals.list').filter((call) => call.params['limit'] === PAGE_SIZE).length ??
  0;

describe('/goals', () => {
  test('reads again on a timer while a goal has not ended and the feed is not live', async () => {
    open([goalFixture('goal-1', { status: 'running' })]);
    await until(() => expect(reads()).toBe(1));

    await feeds?.passPolls(3, GOAL_POLL_MILLISECONDS);

    expect(reads()).toBeGreaterThanOrEqual(4);
  });

  test('has no timer when every goal has ended, live or not', async () => {
    open([goalFixture('goal-1', { status: 'succeeded' })]);
    await until(() => expect(reads()).toBe(1));

    await feeds?.passPolls(4, GOAL_POLL_MILLISECONDS);

    expect(reads()).toBe(1);
  });

  test('reads on no timer while the feed is live, and once for each goal event', async () => {
    open([goalFixture('goal-1', { status: 'running' })]);
    await until(() => expect(reads()).toBe(1));
    await feeds?.bureauGoesLive();
    const before = reads();

    await feeds?.passPolls(6, GOAL_POLL_MILLISECONDS);
    expect(reads()).toBe(before);

    goals = [goalFixture('goal-1', { status: 'succeeded' })];
    await feeds?.bureauEvent('goal.succeeded', { goalRunId: 'goal-1' });
    await until(() => expect(reads()).toBe(before + 1));
    await feeds?.passPolls(2, GOAL_POLL_MILLISECONDS);
    expect(reads()).toBe(before + 1);
  });

  test('is not read for an event that is not a goal’s', async () => {
    open([goalFixture('goal-1', { status: 'running' })]);
    await until(() => expect(reads()).toBe(1));
    await feeds?.bureauGoesLive();
    const before = reads();

    await feeds?.bureauEvent('run.settled');
    await feeds?.passPolls(2, GOAL_POLL_MILLISECONDS);

    expect(reads()).toBe(before);
  });

  test('goes back to the timer when the feed is lost', async () => {
    open([goalFixture('goal-1', { status: 'running' })]);
    await until(() => expect(reads()).toBe(1));
    await feeds?.bureauGoesLive();
    feeds?.hub.end('bureau');
    await until(() => expect(feeds?.bureauEvents.status).toBe('reconnecting'));
    const before = reads();

    await feeds?.passPolls(3, GOAL_POLL_MILLISECONDS);

    expect(reads()).toBeGreaterThan(before);
  });
});
