/**
 * The Engine view follows the engine's fleet feed (COR-1725): its health probe is made once and
 * has no timer, and its pending reviews ask on a timer only while the feed is not live and ask
 * again for each review event. The feed is the real source over a stubbed stream (`../live-feeds/live-site.test-support.ts`).
 */
import { cleanup } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';

import { until } from '../../lib/fake-timers.test-support.ts';
import { queryKeys } from '../../lib/query.ts';
import {
  describeLiveSite,
  fetchCount,
  mountLiveView,
} from '../live-feeds/live-site.test-support.ts';
import { ScriptedFetch } from './dashboard-test-support.test-support.ts';
import HealthLine from './health-line.svelte';
import DashboardIndex from './index.svelte';

const THIRTY_SECONDS = 30_000;
const HEALTH_KEY = ['dashboard', 'health'];

let scripted: ScriptedFetch | undefined;

function restore(): void {
  scripted?.restore();
  scripted = undefined;
}

describe('the Engine page’s health probe', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    restore();
    jest.useRealTimers();
  });

  test('is made once, when the page opens, and on no timer whether the feed is live or not', async () => {
    scripted = new ScriptedFetch();
    scripted.routeUrl('/v1/health', { status: 'ok' });
    scripted.routeJsonRpcMethod('weft.workflows.aggregate', {
      total: 0,
      groups: [],
      truncated: false,
    });
    const { feeds, queryClient } = mountLiveView({ component: DashboardIndex });
    try {
      await until(() => expect(fetchCount(queryClient, HEALTH_KEY)).toBe(1));

      await feeds.passPolls(4, THIRTY_SECONDS);
      expect(fetchCount(queryClient, HEALTH_KEY)).toBe(1);

      await feeds.fleetGoesLive();
      await feeds.passPolls(4, THIRTY_SECONDS);
      expect(fetchCount(queryClient, HEALTH_KEY)).toBe(1);
    } finally {
      feeds.close();
    }
  });
});

describeLiveSite('the health line’s pending reviews', {
  intervalMilliseconds: THIRTY_SECONDS,
  watched: [queryKeys.reviews.list({ status: 'pending' })],
  events: [
    { kind: 'human-review:requested', rereads: [queryKeys.reviews.list({ status: 'pending' })] },
    { kind: 'human-review:completed', rereads: [queryKeys.reviews.list({ status: 'pending' })] },
  ],
  mount() {
    scripted = new ScriptedFetch();
    scripted.routeJsonRpcMethod('weft.tasks.diagnostics', {
      items: [],
      summary: {
        stuckQueued: 0,
        staleInflight: 0,
        retryStorms: 0,
        allWorkersAtCapacity: 0,
        deadLettered: 0,
        delayed: 0,
        unadoptedTerminal: 0,
      },
    });
    scripted.routeUrl('/v1/reviews', []);
    return mountLiveView({ component: HealthLine });
  },
  restore,
});
