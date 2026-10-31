/**
 * The route table's contract (COR-1837): routes nest as the breadcrumb hierarchy does, the old
 * flat addresses are gone with no redirect, every route has a breadcrumb label and a parent, and
 * the trail for each route's address matches the address.
 */
import { Glob } from 'bun';
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { matchRoute } from '../lib/router.svelte.ts';
import { breadcrumbTrail } from './breadcrumbs.svelte.ts';
import { routes, type RouteDefinition } from './routes.ts';

const SOURCE_ROOT = join(import.meta.dir, '..');

/** Addresses that were routes before the nesting. Pre-release: none has a redirect. */
const RETIRED_PATHS = [
  '/chat',
  '/chat/new',
  '/chat/session-1',
  '/engine',
  '/engine/runs',
  '/workers',
  '/storage',
  '/audit',
  '/system',
  '/tasks',
  '/tasks/run-1',
  '/agents/assistant/memory',
] as const;

/** The patterns a path's leading segments name: `/a/:b/c` is `/a`, `/a/:b`, then itself. */
function ancestorPatterns(pattern: string): string[] {
  const segments = pattern.split('/').filter((segment) => segment.length > 0);
  return segments.slice(0, -1).map((_, index) => `/${segments.slice(0, index + 1).join('/')}`);
}

/**
 * What is wrong with a table's breadcrumbs: a route that renders but has no label, and a route
 * whose parent address is not a route with a label, so the trail would skip a level.
 */
function breadcrumbGaps(table: readonly RouteDefinition[]): string[] {
  const gaps: string[] = [];
  for (const route of table) {
    if (route.redirect !== undefined) continue;
    if (route.crumb === undefined) gaps.push(`${route.pattern} has no breadcrumb label`);
    for (const ancestor of ancestorPatterns(route.pattern)) {
      const parent = table.find((candidate) => candidate.pattern === ancestor);
      if (parent?.crumb === undefined)
        gaps.push(`${route.pattern} has no parent route ${ancestor}`);
    }
  }
  return gaps;
}

/** A concrete address for a pattern: each parameter filled with a value of its own name. */
function addressOf(pattern: string): string {
  return pattern.replace(/:(\w+)/g, (_, name: string) => `sample-${name}`);
}

describe('the route table', () => {
  test('names no route by a path it had before it nested, and keeps no redirect for one', () => {
    for (const path of RETIRED_PATHS) expect(matchRoute(path), path).toBeNull();
    expect(
      routes.filter((route) => route.redirect !== undefined).map((route) => route.pattern),
    ).toEqual(['/']);
  });

  test('names no retired path in the application source', async () => {
    const offenders: string[] = [];
    for await (const file of new Glob('**/*.{ts,svelte}').scan({
      cwd: SOURCE_ROOT,
      onlyFiles: true,
    })) {
      if (/\.test\./.test(file) || file.startsWith('host/')) continue;
      const text = await Bun.file(join(SOURCE_ROOT, file)).text();
      for (const path of RETIRED_PATHS) {
        if (/\d|-/.test(path)) continue;
        for (const quote of ["'", '"', '`']) {
          if (text.includes(`${quote}${path}${quote}`)) offenders.push(`${file} ${quote}${path}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test('nests as the design lists, with the parameter names the design gives', () => {
    const patterns = routes.map((route) => route.pattern);
    expect(patterns).toEqual(
      expect.arrayContaining([
        '/chats',
        '/chats/new',
        '/chats/:chat',
        '/agents/:agent',
        '/agents/:agent/edit',
        '/agents/:agent/memories',
        '/workflows/:workflow',
        '/workflows/:workflow/runs',
        '/workflows/:workflow/runs/:run',
        '/workflows/:workflow/edit',
        '/runs',
        '/runs/:run',
        '/schedules/:schedule',
        '/reviews',
        '/goals',
        '/goals/new',
        '/goals/:goal',
        '/health',
        '/health/runs',
        '/health/workers',
        '/health/storage',
        '/health/audit',
        '/settings',
        '/settings/model-policy',
        '/settings/data-and-retention',
        '/settings/api-reference',
      ]),
    );
  });

  test('renders a run under its workflow and by its ID alone as one page, with no redirect between them', () => {
    const nested = routes.find((route) => route.pattern === '/workflows/:workflow/runs/:run');
    const alone = routes.find((route) => route.pattern === '/runs/:run');
    expect(nested?.redirect).toBeUndefined();
    expect(alone?.redirect).toBeUndefined();
    expect(nested?.view).toBe(alone?.view);
    expect(nested?.load.toString()).toBe(alone?.load.toString());
    expect(matchRoute('/workflows/invoice/runs/run-1')).toEqual({
      pattern: '/workflows/:workflow/runs/:run',
      params: { workflow: 'invoice', run: 'run-1' },
    });
  });

  test('gives every route a breadcrumb label and a parent that has one', () => {
    expect(breadcrumbGaps(routes)).toEqual([]);
  });

  test('fails a route that has no breadcrumb label, and one whose parent is missing', () => {
    const load = routes[1]!.load;
    expect(
      breadcrumbGaps([
        { pattern: '/a', kind: 'reading', crumb: 'A', load },
        { pattern: '/a/b', kind: 'reading', load },
      ]),
    ).toEqual(['/a/b has no breadcrumb label']);
    expect(breadcrumbGaps([{ pattern: '/a/b', kind: 'reading', crumb: 'B', load }])).toEqual([
      '/a/b has no parent route /a',
    ]);
    expect(
      breadcrumbGaps([
        { pattern: '/a', kind: 'reading', load },
        { pattern: '/a/b', kind: 'reading', crumb: 'B', load },
      ]),
    ).toEqual(['/a has no breadcrumb label', '/a/b has no parent route /a']);
  });

  test('gives each route a trail that matches its address, one crumb for each segment', () => {
    for (const route of routes) {
      if (route.redirect !== undefined) continue;
      const address = addressOf(route.pattern);
      const segments = address.split('/').filter((segment) => segment.length > 0);
      const trail = breadcrumbTrail(address, new Map());
      expect(trail.length, `${route.pattern}: ${JSON.stringify(trail)}`).toBe(segments.length);
      // Every crumb but the last links to its own leading part of the address.
      for (const [index, item] of trail.entries()) {
        if (index === trail.length - 1) expect(item.href, route.pattern).toBeUndefined();
        else expect(item.href, route.pattern).toBe(`/${segments.slice(0, index + 1).join('/')}`);
      }
    }
  });

  test('reads the trail of a nested run as Workflows, the workflow, Runs, then the run', () => {
    expect(breadcrumbTrail('/workflows/invoice/runs/run-1', new Map())).toEqual([
      { label: 'Workflows', href: '/workflows' },
      { label: 'invoice', href: '/workflows/invoice' },
      { label: 'Runs', href: '/workflows/invoice/runs' },
      { label: 'run-1' },
    ]);
    expect(breadcrumbTrail('/settings/api-reference', new Map())).toEqual([
      { label: 'Settings', href: '/settings' },
      { label: 'API reference' },
    ]);
    expect(breadcrumbTrail('/health/workers', new Map())).toEqual([
      { label: 'Health', href: '/health' },
      { label: 'Workers' },
    ]);
  });
});
