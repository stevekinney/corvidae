/**
 * The two halves of every view that follows the engine's fleet feed instead of asking on a timer
 * (COR-1725), as tests: it asks again on a timer only while the feed is not live, and asks once
 * for each event that reports what it reads. The entries are read through the query client, by how
 * many times each has been fetched, so a site needs only the keys it reads and the kinds that
 * change them. The clock is the test's: the timer is TanStack Query's refetch interval, so the
 * clock is faked and moved by hand (`../lib/live-source/live-feeds.test-support.ts`).
 */
import { HttpClient } from '@lostgradient/weft';
import { QueryClient, type QueryKey } from '@tanstack/svelte-query';
import { cleanup, render, type RenderResult } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';

import { until } from '../lib/fake-timers.test-support.ts';
import { createLiveFeeds, type LiveFeeds } from '../lib/live-source/live-feeds.test-support.ts';
import LiveFeedPage from './live-feed-page.test-harness.svelte';

export interface LiveSiteMount {
  readonly feeds: LiveFeeds;
  readonly queryClient: QueryClient;
  /** What Testing Library rendered, for a test of what the page shows. */
  readonly view: RenderResult;
}

export interface LiveSite {
  /** Mounts the view over a client that answers its reads, with the live feeds provided to it. */
  readonly mount: () => LiveSiteMount;
  /** Undoes what `mount` installed besides the live feeds (the scripted `fetch`). */
  readonly restore: () => void;
  /** The view's own refetch interval, in milliseconds. */
  readonly intervalMilliseconds: number;
  /** Every entry the view reads on a timer. */
  readonly watched: readonly QueryKey[];
  /** Each kind of fleet event the view follows, and the entries it asks for again. */
  readonly events: ReadonlyArray<{
    readonly kind: string;
    /** The frame's payload, for a kind that names what it changed (a task's `operationId`). */
    readonly payload?: Record<string, unknown>;
    readonly rereads: readonly QueryKey[];
  }>;
}

/**
 * Renders a view the way the shell does for its pages (`./live-feed-page.test-harness.svelte`), over
 * the live feeds. Install the scripted `fetch` first: the feeds route what they do not own to it.
 */
export function mountLiveView(view: {
  readonly component: unknown;
  readonly componentProps?: Record<string, unknown>;
}): LiveSiteMount {
  const feeds = createLiveFeeds();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, notifyOnChangeProps: 'all' } },
  });
  const rendered = render(LiveFeedPage, {
    props: {
      client: new HttpClient({ baseUrl: 'http://weft.test/api' }),
      queryClient,
      fleetEvents: feeds.fleetEvents,
      component: view.component,
      componentProps: view.componentProps ?? {},
    },
  } as never);
  return { feeds, queryClient, view: rendered };
}

/** How many times the entry has been fetched, whether it answered or failed. */
export function fetchCount(queryClient: QueryClient, key: QueryKey): number {
  const state = queryClient.getQueryState(key);
  return (state?.dataUpdateCount ?? 0) + (state?.errorUpdateCount ?? 0);
}

export function describeLiveSite(name: string, site: LiveSite): void {
  describe(name, () => {
    let mounted: LiveSiteMount | undefined;

    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      cleanup();
      mounted?.feeds.close();
      mounted = undefined;
      site.restore();
      jest.useRealTimers();
    });

    async function open(): Promise<LiveSiteMount> {
      mounted = site.mount();
      const { queryClient } = mounted;
      await until(() => {
        for (const key of site.watched) expect(fetchCount(queryClient, key)).toBeGreaterThan(0);
      });
      return mounted;
    }

    const counts = (queryClient: QueryClient) =>
      site.watched.map((key) => fetchCount(queryClient, key));

    test('asks again on a timer while the fleet feed is not live', async () => {
      const { feeds, queryClient } = await open();
      const before = counts(queryClient);

      await feeds.passPolls(3, site.intervalMilliseconds);

      const after = counts(queryClient);
      for (const [index, count] of after.entries()) expect(count).toBeGreaterThan(before[index]!);
    });

    test('asks on no timer while the feed is live', async () => {
      const { feeds, queryClient } = await open();
      await feeds.fleetGoesLive();
      const before = counts(queryClient);

      await feeds.passPolls(5, site.intervalMilliseconds);

      expect(counts(queryClient)).toEqual(before);
    });

    for (const event of site.events) {
      test(`asks again once for ${event.kind}, and for nothing else it does not change`, async () => {
        const { feeds, queryClient } = await open();
        await feeds.fleetGoesLive();
        const before = new Map(
          site.watched.map((key) => [JSON.stringify(key), fetchCount(queryClient, key)]),
        );

        await feeds.fleetEvent(
          event.kind,
          event.payload === undefined ? {} : { payload: event.payload },
        );
        await until(() => {
          for (const key of event.rereads) {
            expect(fetchCount(queryClient, key)).toBe(before.get(JSON.stringify(key))! + 1);
          }
        });
        await feeds.passPolls(2, site.intervalMilliseconds);

        for (const key of site.watched) {
          const expected =
            before.get(JSON.stringify(key))! +
            (event.rereads.some((reread) => JSON.stringify(reread) === JSON.stringify(key))
              ? 1
              : 0);
          expect(fetchCount(queryClient, key)).toBe(expected);
        }
      });
    }

    test('does not ask again for an event it does not follow', async () => {
      const { feeds, queryClient } = await open();
      await feeds.fleetGoesLive();
      const before = counts(queryClient);

      await feeds.fleetEvent('alert:fired');
      await feeds.passPolls(1, 1);

      expect(counts(queryClient)).toEqual(before);
    });

    test('goes back to the timer when the feed is lost', async () => {
      const { feeds, queryClient } = await open();
      await feeds.fleetGoesLive();
      feeds.hub.end('fleet');
      await until(() => expect(feeds.fleetEvents.status).toBe('reconnecting'));
      const before = counts(queryClient);

      await feeds.passPolls(3, site.intervalMilliseconds);

      const after = counts(queryClient);
      for (const [index, count] of after.entries()) expect(count).toBeGreaterThan(before[index]!);
    });
  });
}
