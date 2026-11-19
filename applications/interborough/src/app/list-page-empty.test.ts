/**
 * Every list page's empty state is one pattern (owner report, 2026-11-19): the page header stays
 * with its create action as a labelled primary button; under it one Cinder `EmptyState` in its
 * `page` layout, never in a box; the page's own sidebar icon; buttons, never text links; plain
 * words with no paths or tool ids; and no count, search, filter or segments over nothing.
 *
 * The walk drives every list in the sidebar against an engine and a Bureau that hold nothing. The
 * state's place under the header (top-aligned, at one offset) is CSS that happy-dom does not lay
 * out: Cinder's own test holds the rule, and the browser spec `list-empty-states.spec.ts` measures
 * it. Here the walk asserts the structure that rule applies to.
 */
import { HttpClient } from '@lostgradient/weft';
import { render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { installFetchImplementation } from '../lib/live-source/fetch.test-support.ts';
import { router } from '../lib/router.svelte.ts';
import { AUTHORIZATION_SCOPES } from '../lib/scopes.svelte.ts';
import { DESTINATIONS } from './shell/destinations.ts';
import Harness from './shell/route-outlet.test-harness.svelte';
import type { ViewName } from './views.ts';

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});

/** What every list answers when it holds nothing; each reader takes only its own field. */
const EMPTY = {
  items: [],
  total: 0,
  tasks: [],
  nextPageToken: null,
  goals: [],
  contexts: [],
  agents: [],
  definitions: [],
  hooks: [],
  reviews: [],
  waits: [],
  results: [],
  checks: [],
  schedules: [],
  workflows: [],
  files: [],
  tools: [],
  models: [],
  skills: [],
  sources: [],
  plugins: [],
  providers: [],
  nextOffset: null,
  nextCursor: null,
};

function stubEmptyHost(): void {
  restore = installFetchImplementation(async (_input, init) => {
    if (typeof init?.body === 'string') {
      const body = JSON.parse(init.body) as { id?: unknown; method?: unknown };
      // The engine ends its pages with no `nextOffset` at all, the Bureau with `null`: a `null`
      // would send the engine's reader for another page forever.
      const { nextOffset: _bureauEnd, ...engine } = EMPTY;
      const result =
        typeof body.method === 'string' && body.method.startsWith('weft.') ? engine : EMPTY;
      return Response.json({ jsonrpc: '2.0', id: body.id, result });
    }
    return Response.json(EMPTY);
  });
}

function landAt(path: string): void {
  if (!(window instanceof Window)) throw new Error('expected a happy-dom test window');
  window.happyDOM.setURL('http://localhost/');
  router.navigate(path, { replace: true });
}

/**
 * Every list page in the sidebar and its create action in the header's words. Reviews and Checks
 * list what agents and checks produce, so nothing is made from their header: `null`.
 */
const LIST_PAGES: readonly { view: ViewName; path: string; create: string | null }[] = [
  { view: 'chat', path: '/chats', create: 'New chat' },
  { view: 'reviews', path: '/reviews', create: null },
  { view: 'runs', path: '/runs', create: 'Start run' },
  { view: 'checks', path: '/checks', create: null },
  { view: 'agents', path: '/agents', create: 'New agent' },
  { view: 'workflows', path: '/workflows', create: 'New workflow' },
  { view: 'schedules', path: '/schedules', create: 'New schedule' },
  { view: 'goals', path: '/goals', create: 'New goal' },
  { view: 'capabilities', path: '/capabilities', create: 'Connect tools' },
  { view: 'hooks', path: '/hooks', create: 'New hook' },
];

/** The sidebar's places that are not lists. */
const NOT_LISTS: readonly ViewName[] = ['home', 'health', 'settings'];

/** The icon's own name among lucide's classes, such as `lucide-target`. */
function iconName(svg: Element | null | undefined): string | undefined {
  return [...(svg?.classList ?? [])].find(
    (name) => name.startsWith('lucide-') && name !== 'lucide-icon',
  );
}

function navigationIconName(view: ViewName): string | undefined {
  const destination = DESTINATIONS.find((entry) => entry.view === view);
  if (destination === undefined) return undefined;
  const { container, unmount } = render(destination.icon, { props: {} });
  const name = iconName(container.querySelector('svg'));
  unmount();
  return name;
}

describe('every list page’s empty state', () => {
  test('walks every list in the sidebar', () => {
    const lists = DESTINATIONS.map((destination) => destination.view).filter(
      (view) => !NOT_LISTS.includes(view),
    );
    expect(LIST_PAGES.map((page) => page.view).toSorted()).toEqual(lists.toSorted());
  });

  for (const page of LIST_PAGES) {
    test(`${page.path}: header, one unboxed page-layout state, its own icon, buttons and plain words`, async () => {
      stubEmptyHost();
      landAt(page.path);
      const { container } = render(Harness, {
        props: {
          client: new HttpClient({ baseUrl: 'http://localhost/api' }),
          scopes: AUTHORIZATION_SCOPES,
        },
      });

      const state = await waitFor(
        () => {
          const found = container.querySelector<HTMLElement>(`[data-list-empty="${page.view}"]`);
          if (found === null) throw new Error(`no empty state on ${page.path} yet`);
          return found;
        },
        { timeout: 5_000 },
      );
      const frame = container.querySelector(`.weft-view[data-view="${page.view}"]`);

      // The header stays: the page's title as its one level-one heading.
      expect(frame?.querySelectorAll('h1')).toHaveLength(1);
      expect(frame?.querySelector('h1')?.compareDocumentPosition(state)).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING,
      );

      // Its create action is a labelled primary button, never a "+" alone.
      if (page.create !== null) {
        const header = page.view === 'chat' ? '.ib-chats__title' : '.cinder-page-header';
        const create = [...(frame?.querySelectorAll(`${header} .cinder-button`) ?? [])].find(
          (button) => button.textContent?.trim() === page.create,
        );
        expect(create).toBeDefined();
        expect(create?.hasAttribute('data-cinder-icon-only')).toBe(false);
        expect(create?.getAttribute('data-cinder-variant')).toBe('primary');
      }

      // One state, in the page layout, at the default size, in no box.
      expect(frame?.querySelectorAll('.cinder-empty-state')).toHaveLength(1);
      expect(state.getAttribute('data-cinder-layout')).toBe('page');
      expect(state.getAttribute('data-cinder-size')).toBe('default');
      expect(state.hasAttribute('data-cinder-bordered')).toBe(false);
      expect(state.closest('[data-cinder-bordered], .cinder-card')).toBeNull();

      // The page's own icon, the one its sidebar item shows.
      expect(iconName(state.querySelector('.cinder-empty-state-icon svg'))).toBe(
        navigationIconName(page.view),
      );

      // Buttons, never text links; the first is the create action, in the header's words.
      const actions = [
        ...state.querySelectorAll('.cinder-empty-state-action > :not(.cinder-sr-only)'),
      ];
      expect(actions.every((action) => action.classList.contains('cinder-button'))).toBe(true);
      expect(state.querySelectorAll('a:not(.cinder-button)')).toHaveLength(0);
      if (page.create !== null && page.view !== 'checks') {
        expect(actions[0]?.textContent?.trim()).toBe(page.create);
        expect(actions[0]?.getAttribute('data-cinder-variant')).toBe('primary');
      }

      // Plain words: no path and no tool id.
      const words = state.textContent ?? '';
      expect(words).not.toMatch(/(^|\s)[~.]?\/\w/);
      expect(words).not.toContain('bureau:');
      expect(words).not.toMatch(/\.(json|md|ya?ml)\b/i);

      // No controls over nothing: no count, search, filter or segments.
      expect(frame?.querySelector('.cinder-filter-bar')).toBeNull();
      expect(frame?.querySelector('.cinder-search-field')).toBeNull();
      expect(frame?.querySelector('.cinder-segmented-control')).toBeNull();
    });
  }
});
