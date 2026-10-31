/**
 * The selection a ListDetail keeps in the address, through the router: it reads one parameter, keeps
 * the rest of the query when it writes, replaces the history entry, and writes only while the
 * router is on the page it was made for.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { routerSelectionLocationFor } from './router-selection-location.ts';
import { router } from './router.svelte.ts';

function resetLocation(path: string): void {
  if (!(window instanceof Window)) throw new Error('expected the test window to be happy-dom');
  window.happyDOM.setURL('http://localhost/');
  router.navigate(path, { replace: true });
}

beforeEach(() => {
  resetLocation('/health/workers');
});

describe('routerSelectionLocationFor', () => {
  test('reads one parameter of the address, and null when it is absent', () => {
    resetLocation('/health/workers?tab=workers&worker=wkr_1');
    const location = routerSelectionLocationFor('/health/workers');
    expect(location.read('worker')).toBe('wkr_1');
    expect(location.read('missing')).toBeNull();
  });

  test('writes the key without disturbing the rest of the query, and clears it with null', () => {
    resetLocation('/health/workers?tab=workers');
    const location = routerSelectionLocationFor('/health/workers');
    location.write('worker', 'wkr_2');
    expect(router.pathname).toBe('/health/workers');
    expect(router.search.get('tab')).toBe('workers');
    expect(router.search.get('worker')).toBe('wkr_2');
    location.write('worker', null);
    expect(router.search.get('worker')).toBeNull();
    expect(router.search.get('tab')).toBe('workers');
  });

  test('writes nothing once the router has left the page it was made for', () => {
    const location = routerSelectionLocationFor('/health/workers');
    resetLocation('/agents');
    location.write('worker', 'wkr_3');
    expect(router.pathname).toBe('/agents');
    expect(router.search.get('worker')).toBeNull();
  });
});
