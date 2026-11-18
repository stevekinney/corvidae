/**
 * `ActivityFeed` and the Bureau band's follower (COR-2227): the window replaces the rows in one
 * step and nothing it brings fades in, an arrival is added at the top once, the hold keeps the rows
 * still until it ends, and a call still being worded when the band stops following draws nothing.
 */
import { quietFor, waitUntil } from '@lostgradient/testing/wait-until';
import { Activity } from '@lucide/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import type { FormattedBureauEvent } from '../../lib/bureau-event-format.ts';
import { ActivityFeed, followBureauActivity } from './home-activity-feed.svelte.ts';
import type { ActivityEntry } from './home-activity-rows.ts';
import {
  bureauEnvelope,
  installActivityWorld,
  REPLAY_COMPLETE_CHUNK,
  type ActivityWorld,
} from './home-activity.test-support.ts';

let world: ActivityWorld | undefined;

afterEach(() => {
  world?.restore();
  world = undefined;
});

const entry = (key: string, at: number): ActivityEntry => ({
  key,
  at,
  icon: Activity,
  title: key,
  tier: 'info',
});

const keys = (feed: ActivityFeed) => feed.shown.map((shown) => shown.key);

describe('ActivityFeed', () => {
  test('a window replaces the rows with its newest three, and nothing it brings fades in', () => {
    const feed = new ActivityFeed();
    expect(feed.ready).toBe(false);
    feed.replace([entry('a', 1), entry('b', 2), entry('c', 3), entry('d', 4)]);
    expect(feed.ready).toBe(true);
    expect(keys(feed)).toEqual(['d', 'c', 'b']);
    expect(feed.arrived.size).toBe(0);
  });

  test('an arrival enters at the top and fades in, once, and is ignored before the first window', () => {
    const feed = new ActivityFeed();
    feed.add([entry('early', 9)]);
    expect(feed.shown).toEqual([]);
    feed.replace([entry('a', 1), entry('b', 2), entry('c', 3)]);
    feed.add([entry('d', 4)]);
    expect(keys(feed)).toEqual(['d', 'c', 'b']);
    expect([...feed.arrived]).toEqual(['d']);
    feed.add([entry('d', 4)]);
    expect(keys(feed)).toEqual(['d', 'c', 'b']);
  });

  test('the hold keeps the rows still until focus, hover and press have all ended', async () => {
    const feed = new ActivityFeed();
    feed.replace([entry('a', 1)]);
    const list = document.createElement('div');
    const outside = document.createElement('button');
    document.body.append(list, outside);
    const release = feed.hold(list);
    list.dispatchEvent(new FocusEvent('focusin'));
    list.dispatchEvent(new PointerEvent('pointerenter', { pointerType: 'mouse' }));
    feed.add([entry('b', 2)]);
    expect(keys(feed)).toEqual(['a']);
    list.dispatchEvent(new FocusEvent('focusout', { relatedTarget: outside }));
    await quietFor(20);
    expect(keys(feed)).toEqual(['a']);
    list.dispatchEvent(new PointerEvent('pointerleave', { pointerType: 'mouse' }));
    await waitUntil(() => keys(feed).join() === 'b,a');

    // A press that began in the list holds until it ends, wherever it ends.
    list.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch' }));
    feed.add([entry('c', 3)]);
    expect(keys(feed)).toEqual(['b', 'a']);
    window.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'touch' }));
    await waitUntil(() => keys(feed).join() === 'c,b,a');
    release();
    list.remove();
    outside.remove();
  });

  test('a hold that ends after its list was taken away draws nothing, and nothing waiting draws nothing', async () => {
    const feed = new ActivityFeed();
    feed.replace([entry('a', 1)]);
    const shown = feed.shown;
    const list = document.createElement('div');
    document.body.append(list);
    const release = feed.hold(list);
    list.dispatchEvent(new FocusEvent('focusin'));
    feed.add([entry('b', 2)]);
    // The focusout Chromium fires as the list is removed, before the list's teardown runs.
    list.dispatchEvent(new FocusEvent('focusout'));
    release();
    list.remove();
    await quietFor(20);
    expect(keys(feed)).toEqual(['a']);
    expect(feed.shown).toBe(shown);

    // With nothing waiting, a draw leaves the rows it has, the same array.
    const other = new ActivityFeed();
    other.replace([entry('c', 3)]);
    const drawn = other.shown;
    other.draw();
    expect(other.shown).toBe(drawn);
  });

  test('a touch that passes over the list is not a hover', () => {
    const feed = new ActivityFeed();
    feed.replace([entry('a', 1)]);
    const list = document.createElement('div');
    document.body.append(list);
    const release = feed.hold(list);
    list.dispatchEvent(new PointerEvent('pointerenter', { pointerType: 'touch' }));
    feed.add([entry('b', 2)]);
    expect(keys(feed)).toEqual(['b', 'a']);
    release();
    list.remove();
  });
});

describe('followBureauActivity', () => {
  test('a window still being worded when the band stops following draws nothing', async () => {
    world = installActivityWorld();
    const feed = new ActivityFeed();
    let answer: ((answers: (FormattedBureauEvent | null)[]) => void) | undefined;
    const follower = followBureauActivity(
      feed,
      world.bureauEvents,
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const stop = follower.start();
    await waitUntil(() => world?.hub.opened('bureau') === 1);
    world.hub.write('bureau', bureauEnvelope('b:1', 'chat.started', 1), REPLAY_COMPLETE_CHUNK);
    await waitUntil(() => answer !== undefined);
    stop();
    answer?.([null]);
    await quietFor(20);
    expect(feed.ready).toBe(false);
  });
});
