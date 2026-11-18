/**
 * Where a ListDetail keeps its open item (`router-selection-location.ts`): one parameter of the
 * address, written through the router, and only while the address is the page's own.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { routerSelectionLocationFor } from './router-selection-location.ts';
import { router } from './router.svelte.ts';

beforeEach(() => {
  if (!(window instanceof Window)) throw new Error('expected a happy-dom test window');
  window.happyDOM.setURL('http://localhost/');
});

afterEach(() => {
  router.navigate('/', { replace: true });
});

describe('a selection kept in the address', () => {
  test('reads one parameter of the current address', () => {
    router.navigate('/reviews?review=bureau%3Aa&tab=done', { replace: true });
    const location = routerSelectionLocationFor('/reviews');
    expect(location.read('review')).toBe('bureau:a');
    expect(location.read('missing')).toBeNull();
  });

  test('writes the key, keeps the other parameters, and clears it when the key is null', () => {
    router.navigate('/reviews?tab=done', { replace: true });
    const location = routerSelectionLocationFor('/reviews');
    location.write('review', 'bureau:a');
    expect(router.search.get('review')).toBe('bureau:a');
    expect(router.search.get('tab')).toBe('done');
    location.write('review', null);
    expect(router.search.get('review')).toBeNull();
    expect(router.search.get('tab')).toBe('done');
  });

  test('builds the address that opens the page with an item selected, from any page', () => {
    router.navigate('/hooks/default-on?tab=done', { replace: true });
    const location = routerSelectionLocationFor('/settings/plugins');
    expect(location.pathTo('plugin', 'slack')).toBe('/settings/plugins?plugin=slack');
    expect(location.pathTo('plugin', 'a b&c')).toBe('/settings/plugins?plugin=a+b%26c');
    // The address the list reads back is the key it was given.
    router.navigate(location.pathTo('plugin', 'a b&c'), { replace: true });
    expect(location.read('plugin')).toBe('a b&c');
  });

  test('writes nothing onto another page, which the list outlives the navigation to by a tick', () => {
    router.navigate('/chats', { replace: true });
    routerSelectionLocationFor('/reviews').write('review', 'bureau:a');
    expect(router.pathname).toBe('/chats');
    expect(router.search.get('review')).toBeNull();
  });
});
