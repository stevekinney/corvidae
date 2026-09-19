/// <reference lib="dom" />
import { afterEach, describe, expect, test } from 'bun:test';

import { requiredInstance, setupHappyDom } from '@corvidae/testing';
import { makeItems, renderedRows, rowSnippet } from './virtual-list-test-helpers.ts';

setupHappyDom();

const { cleanup, fireEvent, render, waitFor } = await import('@testing-library/svelte');
const { tick } = await import('svelte');
const { default: VirtualList } = await import('./virtual-list.svelte');

afterEach(() => cleanup());

describe('VirtualList — edge callbacks under adaptive overscan', () => {
  test('reads the visible range from scroll geometry, not from the window', async () => {
    // Structural, for the same reason as the adaptive row-size test above: reproducing
    // this needs the effective overscan to exceed the configured one, which only
    // velocity produces — and events fired from a test share a timestamp, so the
    // velocity tracker reports zero and adaptation never engages. CIN-614 adds the
    // playground example that makes it reachable in a browser.
    //
    // What it pins is the invariant, because BOTH ways of undoing the window's
    // overscan are wrong and in opposite directions. Subtracting the configured
    // overscan leaves the adaptive growth in, and the callbacks fire tens of rows
    // early. Subtracting the effective overscan over-corrects at the list's own edges,
    // where the window is clamped and the overscan realized on that side is smaller
    // than the one requested — in a 100-row list `endIndex` is 100 however wide
    // adaptation grew, so the last visible row reads as 49 and `onEndReached` is
    // suppressed until the idle timer shrinks the window back.
    //
    // The visible range therefore must not be reconstructed from the window at all.
    const source = await Bun.file(
      new URL('./virtual-list.svelte', import.meta.url).pathname,
    ).text();
    const edgeEffect = source.slice(
      source.indexOf('const lastRenderedIndex = Math.max(0, itemCount - 1);'),
      source.indexOf('const maskedProximity'),
    );
    expect(edgeEffect).toContain('resolveAnchorIndexAtOffset(scrollOffset)');
    expect(edgeEffect).not.toContain('currentWindow.startIndex');
    expect(edgeEffect).not.toContain('currentWindow.endIndex');

    // And the trigger distance stays the CONFIGURED overscan. Widening it with the
    // effective value would fetch pages earlier the faster the reader scrolled, which
    // is not what the prop promises.
    expect(edgeEffect).toContain('overscan: resolvedOverscan');
    expect(edgeEffect).not.toContain('overscan: effectiveOverscan');
  });

  test('still fires both callbacks with an overscan wider than the list', async () => {
    // The clamping case, exercised by configuration rather than by velocity: with an
    // overscan half the collection, the window is pinned to both edges at once, so
    // every index the window could offer is clamped and only the geometry still
    // describes what the reader can see.
    let startReached = 0;
    let endReached = 0;
    const { container } = render(VirtualList, {
      items: makeItems(100),
      itemHeight: 20,
      height: '200px',
      overscan: 50,
      onStartReached: () => {
        startReached += 1;
      },
      onEndReached: () => {
        endReached += 1;
      },
      row: rowSnippet(),
      'aria-label': 'Feed',
    });

    await waitFor(() => expect(renderedRows(container).length).toBeGreaterThan(0));
    await waitFor(() => expect(startReached).toBe(1));

    const list = requiredInstance(container.querySelector('.cinder-virtual-list'), HTMLElement);
    list.scrollTop = 1_800;
    await fireEvent.scroll(list);
    await tick();

    await waitFor(() => expect(endReached).toBe(1));
  });
});
