/**
 * The route table: Chat is the home screen, sessions live under `/chats/:chat`, runs moved
 * from `/workflows` to `/runs`, and `/workflows` is the catalog of definitions.
 *
 * These tests check the table's wiring and never import a route's component. Importing one
 * compiles its Svelte source and everything it pulls in, which costs seconds per route under load
 * and grows with every route. Compilation stays covered by `typecheck` (`svelte-check`) and by
 * `scripts/build.slow.test.ts`, which bundles `index.html` and follows every route's lazy import.
 */
import { Glob } from 'bun';
import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { agentEditPath, agentPath } from '../lib/agent-paths.ts';
import {
  matchRoute,
  scheduleCreatePath,
  scheduleDetailPath,
  scheduleEditPath,
  workflowDetailPath,
} from '../lib/router.svelte.ts';
import {
  workflowEditPath,
  workflowNewPath,
  workflowRunsPath,
  workflowTypePath,
} from '../lib/workflow-type-paths.ts';
import { type RouteDefinition, routes } from './routes.ts';
import { DESTINATIONS } from './shell/destinations.ts';
import { VIEW_NAMES } from './views.ts';

const sourceRoot = join(import.meta.dir, '..');
/** The directory `routes.ts` lives in, which its relative import specifiers resolve against. */
const routesDirectory = import.meta.dir;

/**
 * The `.svelte` file a route's `load` imports, as an absolute path. It reads the specifier out of
 * the function's source rather than calling it, so nothing is compiled. A `load` that does not
 * contain exactly one string-literal `import()` is a wiring this test cannot read, and fails.
 */
function componentPathOfRoute(route: RouteDefinition): string {
  const specifiers = [...route.load.toString().matchAll(/\bimport\(\s*(["'`])([^"'`]+)\1\s*\)/g)];
  if (specifiers.length !== 1) {
    throw new Error(
      `The route ${route.pattern} must load its component with one literal import(), found ${specifiers.length}.`,
    );
  }
  return resolve(routesDirectory, specifiers[0]![2]!);
}

/** The component file a pattern's route loads. */
function componentPathOf(pattern: string): string {
  const route = routes.find((candidate) => candidate.pattern === pattern);
  if (route === undefined) throw new Error(`No route has the pattern ${pattern}.`);
  return componentPathOfRoute(route);
}

/** An absolute path for a source-relative specifier, spelled as the route table spells it. */
function sourcePath(specifier: string): string {
  return resolve(routesDirectory, specifier);
}

describe('the route table', () => {
  test('gives every route a view', () => {
    expect(routes.filter((route) => route.view === undefined)).toEqual([]);
    for (const route of routes) expect(VIEW_NAMES).toContain(route.view as never);
  });

  test('loads a component file that exists for every route that renders, and names a path for the one that redirects', () => {
    for (const route of routes) {
      if (route.redirect !== undefined) continue;
      const path = componentPathOfRoute(route);
      expect(path, route.pattern).toEndWith('.svelte');
      expect(existsSync(path), `${route.pattern} loads ${path}`).toBe(true);
    }
    expect(
      routes.filter((route) => route.redirect !== undefined).map((route) => route.pattern),
    ).toEqual(['/']);
  });

  test('gives the route that redirects a component file too, which the outlet never mounts', () => {
    const home = routes.find((route) => route.redirect !== undefined);
    expect(home?.pattern).toBe('/');
    expect(existsSync(componentPathOfRoute(home!))).toBe(true);
  });

  test('registers /chats/new before /chats/:chat, because the first match wins', () => {
    const patterns = routes.map((route) => route.pattern);

    expect(patterns.indexOf('/chats/new')).toBeLessThan(patterns.indexOf('/chats/:chat'));
    expect(matchRoute('/chats/new')?.pattern).toBe('/chats/new');
    expect(matchRoute('/chats/abc')?.pattern).toBe('/chats/:chat');
  });

  test('serves the agents list and one agent', () => {
    expect(matchRoute('/agents')?.pattern).toBe('/agents');
    expect(matchRoute('/agents/assistant')).toEqual({
      pattern: '/agents/:agent',
      params: { agent: 'assistant' },
    });
  });

  test('serves the engine run list under /health, in the engine view, apart from the Bureau runs', () => {
    expect(matchRoute('/health/runs')).toEqual({ pattern: '/health/runs', params: {} });
    expect(routes.find((route) => route.pattern === '/health/runs')?.view).toBe('health');
    expect(componentPathOf('/health/runs')).toBe(
      sourcePath('../routes/workflows/list/workflow-list.svelte'),
    );
    expect(componentPathOf('/runs')).not.toBe(componentPathOf('/health/runs'));
  });

  test('has no two routes with one pattern', () => {
    const patterns = routes.map((route) => route.pattern);
    expect(new Set(patterns).size).toBe(patterns.length);
  });

  test('makes Chat the home screen, with sessions under /chats/:chat', () => {
    expect(matchRoute('/')).toEqual({ pattern: '/', params: {} });
    expect(routes.find((route) => route.pattern === '/')?.view).toBe('chat');
    expect(matchRoute('/chats')?.pattern).toBe('/chats');
    expect(matchRoute('/chats/session-1')).toEqual({
      pattern: '/chats/:chat',
      params: { chat: 'session-1' },
    });
  });

  test('puts the runs list and one run at /runs and /runs/:run', () => {
    expect(matchRoute('/runs')?.pattern).toBe('/runs');
    expect(matchRoute('/runs/run-1')).toEqual({ pattern: '/runs/:run', params: { run: 'run-1' } });
    const runsComponent = sourcePath('../routes/workflows/index.svelte');
    for (const pattern of ['/runs', '/runs/:run']) {
      expect(componentPathOf(pattern), pattern).toBe(runsComponent);
      expect(routes.find((candidate) => candidate.pattern === pattern)?.view, pattern).toBe('runs');
    }
  });

  test('serves the Workflows area at /workflows and under /workflows/:workflow, apart from the runs list', () => {
    const runsComponent = sourcePath('../routes/workflows/index.svelte');
    const area = sourcePath('../routes/workflow-definitions/index.svelte');
    expect(matchRoute('/workflows')?.pattern).toBe('/workflows');
    expect(matchRoute('/workflows/invoice')).toEqual({
      pattern: '/workflows/:workflow',
      params: { workflow: 'invoice' },
    });
    expect(matchRoute('/workflows/invoice/runs')).toEqual({
      pattern: '/workflows/:workflow/runs',
      params: { workflow: 'invoice' },
    });
    expect(matchRoute('/workflows/invoice/edit')).toEqual({
      pattern: '/workflows/:workflow/edit',
      params: { workflow: 'invoice' },
    });
    expect(matchRoute('/workflows/new')).toEqual({ pattern: '/workflows/new', params: {} });
    for (const pattern of [
      '/workflows',
      '/workflows/new',
      '/workflows/:workflow',
      '/workflows/:workflow/runs',
      '/workflows/:workflow/edit',
    ]) {
      const loaded = componentPathOf(pattern);
      expect(loaded, pattern).toBe(area);
      expect(loaded, pattern).not.toBe(runsComponent);
      expect(routes.find((candidate) => candidate.pattern === pattern)?.view, pattern).toBe(
        'workflows',
      );
    }
  });

  test('registers the page that makes a workflow before the page of a type, so new is never read as a type', () => {
    const patterns = routes.map((route) => route.pattern);
    expect(patterns.indexOf('/workflows/new')).toBeGreaterThan(-1);
    expect(patterns.indexOf('/workflows/new')).toBeLessThan(
      patterns.indexOf('/workflows/:workflow'),
    );
  });

  test('never reads a type’s runs or editor as a type, because a path segment is one name', () => {
    expect(matchRoute('/workflows/a/b/c')).toBeNull();
    expect(matchRoute('/workflows/runs')?.pattern).toBe('/workflows/:workflow');
  });

  test('names the routes the sidebar links to', () => {
    const patterns = routes.map((route) => route.pattern);
    for (const path of [
      '/agents',
      '/schedules',
      '/reviews',
      '/health/workers',
      '/health/storage',
      '/settings/api-reference',
      '/health/audit',
      '/settings',
      '/health',
    ]) {
      expect(patterns).toContain(path);
    }
  });
});

describe('the capabilities route', () => {
  test('is /capabilities, a wide list with its detail in its own view, and is in the sidebar', () => {
    expect(matchRoute('/capabilities')).toEqual({ pattern: '/capabilities', params: {} });
    const route = routes.find((candidate) => candidate.pattern === '/capabilities');
    expect(route?.view).toBe('capabilities');
    expect(route?.kind).toBe('list-detail');
    expect(route?.crumb).toBe('Capabilities');
  });
});

describe('the agent editor’s routes', () => {
  test('are /agents/new and /agents/:agent/edit, both in the agent editor view', () => {
    expect(matchRoute('/agents/new')).toEqual({ pattern: '/agents/new', params: {} });
    expect(matchRoute('/agents/researcher/edit')).toEqual({
      pattern: '/agents/:agent/edit',
      params: { agent: 'researcher' },
    });
    for (const pattern of ['/agents/new', '/agents/:agent/edit']) {
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

  test('load one component, which both routes render', () => {
    const editor = sourcePath('../routes/agent-editor/index.svelte');
    expect(componentPathOf('/agents/new')).toBe(editor);
    expect(componentPathOf('/agents/:agent/edit')).toBe(editor);
  });
});

describe('a link to a workflow type', () => {
  test('is built in one module, so no other file spells /workflows/ for a run', () => {
    expect(workflowTypePath('order-processing')).toBe('/workflows/order-processing');
    expect(workflowTypePath('a/b')).toBe('/workflows/a%2Fb');
    expect(workflowRunsPath('order-processing')).toBe('/workflows/order-processing/runs');
    expect(workflowEditPath('order-processing')).toBe('/workflows/order-processing/edit');
    expect(matchRoute(workflowRunsPath('a/b'))?.params).toEqual({ workflow: 'a/b' });
    expect(workflowNewPath()).toBe('/workflows/new');
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
      // pattern, which names a workflow type as `:workflow`, is how the Workflows area is addressed and
      // is not a link to a run, and neither is the literal `/workflows/new`, the page that makes a
      // workflow, which no run's address can be.
      if (/['"`]\/workflows[/?](?!:workflow|new['"`])/.test(text)) offenders.push(path);
    }
    expect(offenders).toEqual([]);
  });
});

describe('the routes for schedules and goals', () => {
  test('put the schedules list at /schedules, the page that makes one at /schedules/new, one schedule at /schedules/:schedule, and its edit page at /schedules/:schedule/edit, all in the schedules view', () => {
    expect(matchRoute('/schedules')).toEqual({ pattern: '/schedules', params: {} });
    expect(matchRoute('/schedules/new')).toEqual({ pattern: '/schedules/new', params: {} });
    expect(matchRoute('/schedules/nightly-rollup')).toEqual({
      pattern: '/schedules/:schedule',
      params: { schedule: 'nightly-rollup' },
    });
    expect(matchRoute('/schedules/nightly-rollup/edit')).toEqual({
      pattern: '/schedules/:schedule/edit',
      params: { schedule: 'nightly-rollup' },
    });
    for (const pattern of [
      '/schedules',
      '/schedules/new',
      '/schedules/:schedule',
      '/schedules/:schedule/edit',
    ]) {
      expect(routes.find((candidate) => candidate.pattern === pattern)?.view, pattern).toBe(
        'schedules',
      );
    }
    expect(componentPathOf('/schedules/new')).toBe(componentPathOf('/schedules'));
    expect(componentPathOf('/schedules/:schedule')).toBe(componentPathOf('/schedules'));
    expect(componentPathOf('/schedules/:schedule/edit')).toBe(componentPathOf('/schedules'));
  });

  test('keep /goals, /goals/new and /goals/:goal in one view, in the sidebar after Schedules', () => {
    expect(matchRoute('/goals')).toEqual({ pattern: '/goals', params: {} });
    expect(matchRoute('/goals/new')).toEqual({ pattern: '/goals/new', params: {} });
    expect(matchRoute('/goals/goal-1')).toEqual({
      pattern: '/goals/:goal',
      params: { goal: 'goal-1' },
    });
    for (const pattern of ['/goals', '/goals/new', '/goals/:goal']) {
      expect(routes.find((candidate) => candidate.pattern === pattern)?.view).toBe('goals');
    }
    const order = DESTINATIONS.map((destination) => destination.view);
    expect(order.indexOf('goals')).toBe(order.indexOf('schedules') + 1);
  });

  test('read /health/audit as the audit trail, not a placeholder', () => {
    expect(componentPathOf('/health/audit')).toBe(sourcePath('../routes/audit/index.svelte'));
  });

  test('read /settings as the settings page, in its own view', () => {
    expect(componentPathOf('/settings')).toBe(sourcePath('../routes/settings/index.svelte'));
    expect(routes.find((candidate) => candidate.pattern === '/settings')?.view).toBe('settings');
  });
});

describe('a link to a schedule', () => {
  test('is /schedules/<id>, built in one place', () => {
    expect(scheduleDetailPath('nightly-rollup')).toBe('/schedules/nightly-rollup');
    expect(scheduleDetailPath('a b/c')).toBe('/schedules/a%20b%2Fc');
    expect(scheduleEditPath('nightly-rollup')).toBe('/schedules/nightly-rollup/edit');
    expect(matchRoute(scheduleEditPath('a b/c'))?.params).toEqual({ schedule: 'a b/c' });
    expect(scheduleCreatePath()).toBe('/schedules/new');
    expect(matchRoute(scheduleCreatePath())?.pattern).toBe('/schedules/new');
    expect(matchRoute(scheduleDetailPath('a b/c'))?.params).toEqual({ schedule: 'a b/c' });
  });

  test('keeps a dot-only id out of the path, which a browser would normalise away', () => {
    expect(scheduleDetailPath('..')).toStartWith('/schedules/_?');
    expect(scheduleEditPath('..')).toStartWith('/schedules/_/edit?');
  });

  test('keeps a schedule named new out of the path, which is the new schedule page’s', () => {
    expect(scheduleDetailPath('new')).toBe('/schedules/_?__weft_schedule_id=new');
    expect(scheduleEditPath('new')).toBe('/schedules/_/edit?__weft_schedule_id=new');
    expect(matchRoute(scheduleDetailPath('new'))?.pattern).toBe('/schedules/:schedule');
    expect(matchRoute('/schedules/new')?.pattern).toBe('/schedules/new');
  });

  test('is never the old query-string form anywhere in the source', async () => {
    // Spelled in two halves so that this file is not an offender itself.
    const old = ['schedules', 'id='].join('?');
    const offenders: string[] = [];
    for await (const path of new Glob('**/*.{svelte,ts,md}').scan(sourceRoot)) {
      const text = await Bun.file(join(sourceRoot, path)).text();
      if (text.includes(old)) offenders.push(path);
    }
    expect(offenders).toEqual([]);
  });
});

describe('a link to an agent', () => {
  test('is built in one module, so a list, a schedule, and a goal agree on how a name is encoded', async () => {
    expect(agentPath('assistant')).toBe('/agents/assistant');
    expect(agentPath('a b/c')).toBe('/agents/a%20b%2Fc');
    expect(agentEditPath('assistant')).toBe('/agents/assistant/edit');
    expect(matchRoute(agentPath('a b/c'))?.params).toEqual({ agent: 'a b/c' });

    const offenders: string[] = [];
    for await (const path of new Glob('**/*.{svelte,ts}').scan(sourceRoot)) {
      if (/\.test(?:-support|-harness)?\./.test(path) || path === 'lib/agent-paths.ts') continue;
      const text = await Bun.file(join(sourceRoot, path)).text();
      // A template literal that builds `/agents/<name>`, which only the module above does.
      if (/`\/agents\/\$\{/.test(text)) offenders.push(path);
    }
    expect(offenders).toEqual([]);
  });
});
