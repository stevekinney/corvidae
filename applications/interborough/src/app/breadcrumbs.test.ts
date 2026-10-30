/**
 * The top bar's breadcrumb trail (COR-1834, design row 06a) is built from the route table: each
 * leading part of the address a route matches gives that route's crumb, a parameter shows until
 * the page supplies its label, and the page itself is the last entry, without a link.
 */
import { render } from '@testing-library/svelte';
import { describe, expect, test } from 'bun:test';
import { tick } from 'svelte';

import { breadcrumbTrail } from './breadcrumbs.svelte.ts';
import Harness from './breadcrumbs.test-harness.svelte';
import { VIEW_COPY } from './copy.ts';
import { routes } from './routes.ts';

const NONE = new Map<string, string>();

describe('the breadcrumb trail', () => {
  test('a top-level page is its view’s name alone', () => {
    expect(breadcrumbTrail('/agents', NONE)).toEqual([{ label: VIEW_COPY.agents.label }]);
    expect(breadcrumbTrail('/engine', NONE)).toEqual([{ label: 'Health' }]);
  });

  test('a nested page links each ancestor and shows a parameter until the page names it', () => {
    expect(breadcrumbTrail('/agents/assistant-1/memory', NONE)).toEqual([
      { label: 'Agents', href: '/agents' },
      { label: 'assistant-1', href: '/agents/assistant-1' },
      { label: 'Memory' },
    ]);
    const labels = new Map([['/agents/assistant-1', 'assistant']]);
    expect(breadcrumbTrail('/agents/assistant-1/memory', labels)).toEqual([
      { label: 'Agents', href: '/agents' },
      { label: 'assistant', href: '/agents/assistant-1' },
      { label: 'Memory' },
    ]);
  });

  test('a literal segment wins over a parameter, as the route table orders them', () => {
    expect(breadcrumbTrail('/agents/new', NONE)).toEqual([
      { label: 'Agents', href: '/agents' },
      { label: 'New agent' },
    ]);
    expect(breadcrumbTrail('/workflows/digest/runs', NONE)).toEqual([
      { label: 'Workflows', href: '/workflows' },
      { label: 'digest', href: '/workflows/digest' },
      { label: 'Runs' },
    ]);
  });

  test('decodes a parameter, and leaves out what no route names', () => {
    expect(breadcrumbTrail('/runs/run%20one', NONE)).toEqual([
      { label: 'Runs', href: '/runs' },
      { label: 'run one' },
    ]);
    expect(breadcrumbTrail('/nowhere/at/all', NONE)).toEqual([]);
    expect(breadcrumbTrail('/', NONE)).toEqual([]);
  });

  test('every route that renders a page names its crumb, and only redirects have none', () => {
    for (const route of routes) {
      expect(route.crumb === undefined, route.pattern).toBe(route.redirect !== undefined);
    }
  });

  test('every crumb of every route renders, from the route table’s own patterns', () => {
    for (const route of routes.filter((candidate) => candidate.crumb !== undefined)) {
      const path = route.pattern.replaceAll(/:([A-Za-z]+)/g, 'sample');
      const trail = breadcrumbTrail(path, NONE);
      const last = trail.at(-1);
      const crumb = route.crumb;
      expect(last?.label, route.pattern).toBe(typeof crumb === 'string' ? crumb : 'sample');
      expect(last?.href, route.pattern).toBeUndefined();
    }
  });

  test('a mounted page supplies its label, and the parameter returns when it unmounts', async () => {
    const path = '/agents/assistant-2/memory';
    const view = render(Harness, { props: { path: '/agents/assistant-2', label: undefined } });
    await tick();
    expect(breadcrumbTrail(path)[1]?.label).toBe('assistant-2');
    await view.rerender({ path: '/agents/assistant-2', label: 'Assistant' });
    await tick();
    expect(breadcrumbTrail(path)[1]?.label).toBe('Assistant');
    view.unmount();
    expect(breadcrumbTrail(path)[1]?.label).toBe('assistant-2');
  });
});
