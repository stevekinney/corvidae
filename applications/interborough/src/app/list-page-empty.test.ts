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
import { cleanup, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { AGENT_TABS, agentTabPath } from '../lib/agent-paths.ts';
import { catalogFixture, readyAgent } from '../lib/bureau-stub.test-support.ts';
import { installFetchImplementation } from '../lib/live-source/fetch.test-support.ts';
import { router } from '../lib/router.svelte.ts';
import { AUTHORIZATION_SCOPES } from '../lib/scopes.svelte.ts';
import {
  PUBLISHED_SCHEMA,
  servedSettings,
  settingsSnapshot,
} from '../routes/settings/settings-fixtures.test-support.ts';
import { STORAGE_CAPABILITIES } from '../routes/storage/storage-server.test-support.ts';
import { EMPTY_DIAGNOSTICS_SUMMARY } from '../routes/workers/index-actions.test-support.ts';
import { routes } from './routes.ts';
import { DESTINATIONS, HEALTH_SHORTCUTS } from './shell/destinations.ts';
import Harness from './shell/route-outlet.test-harness.svelte';
import type { ViewName } from './views.ts';

let restore: (() => void) | undefined;
afterEach(() => {
  // Unmount the page before its host goes, so nothing it left reads into the next file's test.
  cleanup();
  document.body.replaceChildren();
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
  configurationRevision: null,
};

/**
 * A host that holds nothing. `answers` names the few operations that answer something else, such
 * as the one agent whose tabs are walked: a JSON-RPC method, or a `GET` path such as `/v1/storage`.
 */
function stubEmptyHost(answers: Readonly<Record<string, unknown>> = {}): void {
  restore = installFetchImplementation(async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      'http://localhost',
    );
    const path = url.pathname.replace(/^\/api/, '');
    if (Object.hasOwn(answers, path)) {
      const answer = answers[path];
      return answer instanceof Response ? answer.clone() : Response.json(answer);
    }
    if (typeof init?.body === 'string') {
      const body = JSON.parse(init.body) as { id?: unknown; method?: unknown };
      // The engine ends its pages with no `nextOffset` at all, the Bureau with `null`: a `null`
      // would send the engine's reader for another page forever.
      const { nextOffset: _bureauEnd, ...engine } = EMPTY;
      const method = typeof body.method === 'string' ? body.method : '';
      const result = Object.hasOwn(answers, method)
        ? answers[method]
        : method.startsWith('weft.')
          ? engine
          : EMPTY;
      return Response.json({ jsonrpc: '2.0', id: body.id, result });
    }
    return Response.json(EMPTY);
  });
}

/** Headings that would say a section's name over its empty state; the page's own `h1` is not one. */
const SECTION_HEADING = 'h2, h3, h4, h5, h6, legend';

/**
 * The state is Cinder's one layout (owner report, 2026-11-19): no layout, size, alignment or
 * border variant on it, in no box, and with no section heading right above it saying the same
 * thing, so the state stands for the section on its own.
 */
function expectOneLayout(state: Element): void {
  for (const attribute of [
    'data-cinder-layout',
    'data-cinder-size',
    'data-cinder-align',
    'data-cinder-bordered',
  ]) {
    expect(state.hasAttribute(attribute)).toBe(false);
  }
  expect(state.closest('[data-cinder-bordered], .cinder-card, .cinder-form-section')).toBeNull();
  // The element right before the state, or before the first ancestor the state opens, within the
  // state's own section: a heading of the section before it is not over this one.
  const SECTION = '.weft-view, main, section, fieldset, [role="tabpanel"], [data-section]';
  let opener: Element = state;
  while (
    opener.previousElementSibling === null &&
    opener.parentElement !== null &&
    !opener.matches(SECTION)
  ) {
    if (opener.parentElement.matches(SECTION)) break;
    opener = opener.parentElement;
  }
  const before = opener.previousElementSibling;
  const heading =
    before === null
      ? null
      : before.matches(SECTION_HEADING)
        ? before
        : before.querySelector(SECTION_HEADING);
  expect(heading?.textContent?.trim() ?? null).toBeNull();
}

/** Its actions are buttons, never text links, and its words have no path, tool id or file format. */
function expectButtonsAndPlainWords(state: Element): Element[] {
  const actions = [...state.querySelectorAll('.cinder-empty-state-action > :not(.cinder-sr-only)')];
  expect(actions.every((action) => action.classList.contains('cinder-button'))).toBe(true);
  expect(state.querySelectorAll('a:not(.cinder-button)')).toHaveLength(0);
  const words = state.textContent ?? '';
  expect(words).not.toMatch(/(^|\s)[~.]?\/\w/);
  expect(words).not.toContain('bureau:');
  expect(words).not.toMatch(/\.(json|md|ya?ml)\b/i);
  return actions;
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

      const state = await waitFor(() => {
        const found = container.querySelector<HTMLElement>(`[data-list-empty="${page.view}"]`);
        if (found === null) throw new Error(`no empty state on ${page.path} yet`);
        return found;
      });
      const frame = container.querySelector(`.weft-view[data-view="${page.view}"]`);

      // The header stays: the page's title as its one level-one heading.
      expect(frame?.querySelectorAll('h1')).toHaveLength(1);
      expect(frame?.querySelector('h1')?.compareDocumentPosition(state)).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING,
      );

      // Its create action is a labelled primary button, never a "+" alone.
      if (page.create !== null) {
        const create = [
          ...(frame?.querySelectorAll('.cinder-page-header .cinder-button') ?? []),
        ].find((button) => button.textContent?.trim() === page.create);
        expect(create).toBeDefined();
        expect(create?.hasAttribute('data-cinder-icon-only')).toBe(false);
        expect(create?.getAttribute('data-cinder-variant')).toBe('primary');
      }

      // One state, in Cinder's one layout, in no box.
      expect(frame?.querySelectorAll('.cinder-empty-state')).toHaveLength(1);
      expectOneLayout(state);

      // The page's own icon, the one its sidebar item shows.
      const navigation = navigationIconName(page.view);
      expect(navigation).toBeDefined();
      expect(iconName(state.querySelector('.cinder-empty-state-icon svg'))).toBe(navigation);

      // Buttons, never text links; the first is the create action, in the header's words.
      const actions = expectButtonsAndPlainWords(state);
      if (page.create !== null && page.view !== 'checks') {
        expect(actions[0]?.textContent?.trim()).toBe(page.create);
        expect(actions[0]?.getAttribute('data-cinder-variant')).toBe('primary');
      }

      // No controls over nothing: no count, search, filter or segments.
      expect(frame?.querySelector('.cinder-filter-bar')).toBeNull();
      expect(frame?.querySelector('.cinder-search-field')).toBeNull();
      expect(frame?.querySelector('.cinder-segmented-control')).toBeNull();
    });
  }
});

/** The one agent whose tabs are walked: everything it holds is empty. */
const WALKED_AGENT = {
  name: 'assistant',
  displayName: 'Assistant',
  description: 'Answers every message.',
  definitionRevision: 3,
  kind: 'file',
  a2a: false,
};

/**
 * Every tab and section page that can be empty (owner report, 2026-11-19): Health's tabs, the
 * Capabilities tabs, an agent's tabs and the Settings sections. Each draws Cinder's one empty
 * state, alone, with no section heading above it saying the same thing.
 */
/** The settings as the Bureau serves them, which every Settings section reads first. */
const SETTINGS_ANSWERS = {
  'bureau.settings.get': settingsSnapshot(servedSettings()),
  'bureau.settings.schema': { schema: PUBLISHED_SCHEMA },
  // No provider connected, so no model; no plugin installed; no remote call made.
  '/host/providers': { configurationRevision: null, providers: [], catalog: [], models: [] },
  '/host/plugins': { configurationRevision: null, plugins: [], unloaded: [] },
  'bureau.audit.query': { records: [], nextCursor: null },
};

const READY_AGENT = readyAgent();
const AGENT_ANSWERS = {
  ...SETTINGS_ANSWERS,
  'bureau.agents.list': { agents: [WALKED_AGENT] },
  'bureau.agents.catalog': catalogFixture({ tools: [] }),
  'bureau.agents.versions.list': { versions: [] },
  'bureau.memory.list': { memories: [], nextOffset: null },
  // Its file holds no instructions, no tools and no card.
  'bureau.agents.definitions.get': readyAgent({
    id: WALKED_AGENT.name,
    name: WALKED_AGENT.displayName,
    definition:
      READY_AGENT.definition === null
        ? null
        : { ...READY_AGENT.definition, tools: [], card: [], instructions: '' },
  }),
};

/** A store with no key in it. */
const EMPTY_STORAGE = {
  'weft.storage.capabilities': STORAGE_CAPABILITIES,
  '/host/storage': { bureauKeyPrefixes: [], sizeBytes: null },
  '/host/storage/summary': { keyCount: 0, sizeBytes: 0 },
  '/v1/storage': new Response('', { headers: { 'Content-Type': 'application/x-ndjson' } }),
};

/** The engine with no worker, no queue and nothing to diagnose. */
const EMPTY_FLEET = {
  'weft.workers.list': { items: [], deployments: [], routingPolicy: 'least-loaded' },
  'weft.tasks.diagnostics': { items: [], summary: EMPTY_DIAGNOSTICS_SUMMARY },
  'weft.workers.rejections': { items: [], limit: 25 },
};

/** What each Health tab answers when it holds nothing. */
const HEALTH_ANSWERS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  '/health/workers': EMPTY_FLEET,
  '/health/storage': EMPTY_STORAGE,
  '/health/audit': { 'bureau.audit.query': { records: [], nextCursor: null } },
};

/**
 * Tabs and sections whose ready view has no empty state.
 */
const NOT_LISTS_UNDER_A_PAGE: Readonly<Record<string, string>> = {
  '/agents/assistant/settings': 'the agent’s settings form',
  '/settings/data-and-retention': 'the retention windows form',
  '/settings/mcp': 'the endpoint and client instructions are always available',
};

/**
 * Every tab and section page under a list or Health: Health's tabs (`HEALTH_SHORTCUTS`), the
 * Capabilities tabs other than Tools (the list page walked above), every agent tab (`AGENT_TABS`)
 * and every Settings section in the route table.
 */
const SUB_ROUTES: readonly { path: string; serve: () => void }[] = [
  ...HEALTH_SHORTCUTS.map(({ path }) => ({
    path,
    serve: () => stubEmptyHost(HEALTH_ANSWERS[path] ?? {}),
  })),
  ...['skills', 'sources'].map((tab) => ({
    path: `/capabilities?tab=${tab}`,
    serve: () => stubEmptyHost(),
  })),
  ...AGENT_TABS.map((tab) => agentTabPath(WALKED_AGENT.name, tab)).map((path) => ({
    path,
    serve: () => stubEmptyHost(AGENT_ANSWERS),
  })),
  ...routes
    .map((route) => route.pattern)
    .filter((pattern) => pattern.startsWith('/settings/'))
    .map((path) => ({ path, serve: () => stubEmptyHost(SETTINGS_ANSWERS) })),
].filter((route) => !Object.hasOwn(NOT_LISTS_UNDER_A_PAGE, route.path));

describe('every tab’s and section’s empty state', () => {
  test('walks the Health, Capabilities, agent and Settings pages that have an empty state', () => {
    const walked = SUB_ROUTES.map((route) => route.path);
    expect(walked).toContain('/health/workers');
    expect(walked).toContain('/health/storage');
    expect(walked).toContain('/health/audit');
    expect(walked).toContain('/capabilities?tab=skills');
    expect(walked).toContain('/capabilities?tab=sources');
    expect(walked.filter((path) => path.startsWith('/agents/'))).toHaveLength(
      AGENT_TABS.length - 1,
    );
    expect(walked.filter((path) => path.startsWith('/settings/')).length).toBeGreaterThan(4);
  });

  for (const route of SUB_ROUTES) {
    test(`${route.path}: Cinder’s one empty state, alone, buttons and plain words`, async () => {
      route.serve();
      landAt(route.path);
      const { container } = render(Harness, {
        props: {
          client: new HttpClient({ baseUrl: 'http://localhost/api' }),
          scopes: AUTHORIZATION_SCOPES,
        },
      });

      const states = await waitFor(() => {
        const found = [...container.querySelectorAll('.cinder-empty-state')];
        if (found.length === 0)
          throw new Error(
            `no empty state on ${route.path} yet: ${container.querySelector('main')?.textContent?.replace(/\s+/g, ' ').slice(0, 300) ?? 'no main'}`,
          );
        return found;
      });
      for (const state of states) {
        expectOneLayout(state);
        expectButtonsAndPlainWords(state);
      }
    });
  }
});
