/**
 * The route table: Chat is the home screen, sessions live under `/chat/:sessionId`, runs moved
 * from `/workflows` to `/runs`, and `/workflows` is the catalog of definitions.
 */
import { Glob } from 'bun';
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { matchRoute, workflowDetailPath } from '../lib/router.svelte.ts';
import {
  workflowEditPath,
  workflowRunsPath,
  workflowTypePath,
} from '../lib/workflow-type-paths.ts';
import { routes } from './routes.ts';
import { VIEW_NAMES } from './views.ts';

const sourceRoot = join(import.meta.dir, '..');

/** The component a pattern's route loads. */
async function componentOf(pattern: string): Promise<unknown> {
  const route = routes.find((candidate) => candidate.pattern === pattern);
  if (route === undefined) throw new Error(`No route has the pattern ${pattern}.`);
  const loaded = await route.load();
  return loaded.default;
}

async function defaultOf(load: Promise<{ default: unknown }>): Promise<unknown> {
  const loaded = await load;
  return loaded.default;
}

describe('the route table', () => {
  test('gives every route a view', () => {
    expect(routes.filter((route) => route.view === undefined)).toEqual([]);
    for (const route of routes) expect(VIEW_NAMES).toContain(route.view as never);
  });

  test('loads a component for every route that renders, and names a path for the one that redirects', async () => {
    for (const route of routes) {
      if (route.redirect !== undefined) continue;
      const loaded = await route.load();
      expect(loaded.default, route.pattern).toBeDefined();
    }
    expect(
      routes.filter((route) => route.redirect !== undefined).map((route) => route.pattern),
    ).toEqual(['/']);
  });

  test('registers /chat/new before /chat/:sessionId, because the first match wins', () => {
    const patterns = routes.map((route) => route.pattern);

    expect(patterns.indexOf('/chat/new')).toBeLessThan(patterns.indexOf('/chat/:sessionId'));
    expect(matchRoute('/chat/new')?.pattern).toBe('/chat/new');
    expect(matchRoute('/chat/abc')?.pattern).toBe('/chat/:sessionId');
  });

  test('serves the agents list and one agent', () => {
    expect(matchRoute('/agents')?.pattern).toBe('/agents');
    expect(matchRoute('/agents/assistant')).toEqual({
      pattern: '/agents/:id',
      params: { id: 'assistant' },
    });
  });

  test('has no two routes with one pattern', () => {
    const patterns = routes.map((route) => route.pattern);
    expect(new Set(patterns).size).toBe(patterns.length);
  });

  test('makes Chat the home screen, with sessions under /chat/:sessionId', () => {
    expect(matchRoute('/')).toEqual({ pattern: '/', params: {} });
    expect(routes.find((route) => route.pattern === '/')?.view).toBe('chat');
    expect(matchRoute('/chat')?.pattern).toBe('/chat');
    expect(matchRoute('/chat/session-1')).toEqual({
      pattern: '/chat/:sessionId',
      params: { sessionId: 'session-1' },
    });
  });

  test('puts the runs list and one run at /runs and /runs/:id', async () => {
    expect(matchRoute('/runs')?.pattern).toBe('/runs');
    expect(matchRoute('/runs/run-1')).toEqual({ pattern: '/runs/:id', params: { id: 'run-1' } });
    const runsComponent = await defaultOf(import('../routes/workflows/index.svelte'));
    for (const pattern of ['/runs', '/runs/:id']) {
      expect(await componentOf(pattern), pattern).toBe(runsComponent);
      expect(routes.find((candidate) => candidate.pattern === pattern)?.view, pattern).toBe('runs');
    }
  });

  test('serves the Workflows area at /workflows and under /workflows/:type, apart from the runs list', async () => {
    const runsComponent = await defaultOf(import('../routes/workflows/index.svelte'));
    const area = await defaultOf(import('../routes/workflow-definitions/index.svelte'));
    expect(matchRoute('/workflows')?.pattern).toBe('/workflows');
    expect(matchRoute('/workflows/invoice')).toEqual({
      pattern: '/workflows/:type',
      params: { type: 'invoice' },
    });
    expect(matchRoute('/workflows/invoice/runs')).toEqual({
      pattern: '/workflows/:type/runs',
      params: { type: 'invoice' },
    });
    expect(matchRoute('/workflows/invoice/edit')).toEqual({
      pattern: '/workflows/:type/edit',
      params: { type: 'invoice' },
    });
    for (const pattern of [
      '/workflows',
      '/workflows/:type',
      '/workflows/:type/runs',
      '/workflows/:type/edit',
    ]) {
      const loaded = await componentOf(pattern);
      expect(loaded, pattern).toBe(area);
      expect(loaded, pattern).not.toBe(runsComponent);
      expect(routes.find((candidate) => candidate.pattern === pattern)?.view, pattern).toBe(
        'workflows',
      );
    }
  });

  test('never reads a type’s runs or editor as a type, because a path segment is one name', () => {
    expect(matchRoute('/workflows/a/b/c')).toBeNull();
    expect(matchRoute('/workflows/runs')?.pattern).toBe('/workflows/:type');
  });

  test('names the routes the sidebar links to, and no route the old navigation had', () => {
    const patterns = routes.map((route) => route.pattern);
    for (const path of [
      '/agents',
      '/schedules',
      '/inbox',
      '/workers',
      '/storage',
      '/system',
      '/audit',
      '/engine',
    ]) {
      expect(patterns).toContain(path);
    }
    expect(matchRoute('/reviews')).toBeNull();
  });
});

describe('the agent editor’s routes', () => {
  test('are /agents/new and /agents/:id/edit, both in the agent editor view', () => {
    expect(matchRoute('/agents/new')).toEqual({ pattern: '/agents/new', params: {} });
    expect(matchRoute('/agents/researcher/edit')).toEqual({
      pattern: '/agents/:id/edit',
      params: { id: 'researcher' },
    });
    for (const pattern of ['/agents/new', '/agents/:id/edit']) {
      expect(routes.find((candidate) => candidate.pattern === pattern)?.view, pattern).toBe(
        'agent-editor',
      );
    }
  });

  test('come before any route that would read `new` as an agent identifier', () => {
    const patterns = routes.map((route) => route.pattern);
    const newRoute = patterns.indexOf('/agents/new');
    expect(newRoute).toBeGreaterThanOrEqual(0);
    for (const [index, pattern] of patterns.entries()) {
      if (/^\/agents\/:[a-z]+$/i.test(pattern)) expect(index, pattern).toBeGreaterThan(newRoute);
    }
  });

  test('load one component, which both routes render', async () => {
    const editor = await defaultOf(import('../routes/agent-editor/index.svelte'));
    expect(await componentOf('/agents/new')).toBe(editor);
    expect(await componentOf('/agents/:id/edit')).toBe(editor);
  });
});

describe('a link to a workflow type', () => {
  test('is built in one module, so no other file spells /workflows/ for a run', () => {
    expect(workflowTypePath('order-processing')).toBe('/workflows/order-processing');
    expect(workflowTypePath('a/b')).toBe('/workflows/a%2Fb');
    expect(workflowRunsPath('order-processing')).toBe('/workflows/order-processing/runs');
    expect(workflowEditPath('order-processing')).toBe('/workflows/order-processing/edit');
    expect(matchRoute(workflowRunsPath('a/b'))?.params).toEqual({ type: 'a/b' });
  });
});

describe('a link to a run', () => {
  test('starts with /runs/', () => {
    expect(workflowDetailPath('run-1')).toBe('/runs/run-1');
    expect(workflowDetailPath('orders/east')).toBe('/runs/orders%2Feast');
    expect(workflowDetailPath('..')).toStartWith('/runs/_?');
  });

  test('is never built on /workflows/ anywhere in the source', async () => {
    const offenders: string[] = [];
    for await (const path of new Glob('**/*.{svelte,ts}').scan(sourceRoot)) {
      if (/\.test(?:-support|-harness)?\.|(^|\/)host\//.test(path)) continue;
      // The one module that builds a workflow type's address, which is never a run's.
      if (path === 'app/routes.ts' || path === 'lib/workflow-type-paths.ts') continue;
      const text = await Bun.file(join(sourceRoot, path)).text();
      // A quoted path, or a template literal, that begins `/workflows/` or `/workflows?`. A route's
      // pattern, which names a workflow type as `:type`, is how the Workflows area is addressed and
      // is not a link to a run.
      if (/['"`]\/workflows[/?](?!:type)/.test(text)) offenders.push(path);
    }
    expect(offenders).toEqual([]);
  });
});
