/**
 * Tests for the history-API router (plan §4, §8, T1.3).
 *
 * happy-dom's default `window.location` is `about:blank` (no origin), and
 * `history.pushState` is a silent no-op from a non-hierarchical origin —
 * every test that touches the reactive `router` singleton first calls
 * `resetLocation()` to give the window a real `http://localhost/` origin
 * (via happy-dom's own `happyDOM.setURL`, exposed on `window` by
 * `tests/setup.ts`'s global preload) so `pushState`/`replaceState` actually
 * take effect, exactly as they would from a real page load.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { Window, type DetachedWindowAPI } from 'happy-dom';

import { routes } from '../app/routes.ts';
import { chatSessionPath } from './identifier-paths.ts';
import { matchRoute, router, scheduleDetailPath, workflowDetailPath } from './router.svelte.ts';

function happyDomAPI(): DetachedWindowAPI {
  if (!(window instanceof Window)) {
    throw new Error('expected the test window to be backed by happy-dom');
  }
  return window.happyDOM;
}

/** Gives `window.location` a real origin and lands the router at `path`. */
function resetLocation(path = '/'): void {
  happyDomAPI().setURL('http://localhost/');
  router.navigate(path, { replace: true });
}

describe('matchRoute', () => {
  const definitions = [
    { pattern: '/', kind: 'reading' as const, load: () => Promise.reject(new Error('unused')) },
    { pattern: '/runs', kind: 'reading' as const, load: () => Promise.reject(new Error('unused')) },
    {
      pattern: '/runs/:id',
      kind: 'reading' as const,
      load: () => Promise.reject(new Error('unused')),
    },
  ];

  test('matches a static pattern exactly', () => {
    expect(matchRoute('/runs', definitions)).toEqual({
      pattern: '/runs',
      params: {},
    });
  });

  test('matches the root pattern only for the empty path', () => {
    expect(matchRoute('/', definitions)).toEqual({ pattern: '/', params: {} });
    expect(matchRoute('/runs', definitions)?.pattern).not.toBe('/');
  });

  test('extracts and decodes a dynamic segment', () => {
    expect(matchRoute('/runs/wf%20123', definitions)).toEqual({
      pattern: '/runs/:id',
      params: { id: 'wf 123' },
    });
  });

  test('treats a segment that is not valid percent-encoding as no match', () => {
    expect(matchRoute('/runs/%E0', definitions)).toBeNull();
    expect(matchRoute('/runs/%', definitions)).toBeNull();
    // A later literal segment that would not match anyway must not let the decode throw first.
    const nested = [
      { pattern: '/workflows/:type/runs', kind: 'reading' as const, load: definitions[1]!.load },
    ];
    expect(matchRoute('/workflows/%E0/nope', nested)).toBeNull();
    expect(matchRoute('/workflows/%E0/runs', nested)).toBeNull();
  });

  test('returns null when segment counts differ', () => {
    expect(matchRoute('/runs/wf_1/timeline', definitions)).toBeNull();
    expect(
      matchRoute('/', [{ pattern: '/runs', kind: 'reading' as const, load: definitions[1]!.load }]),
    ).toBeNull();
  });

  test('normalizes a trailing slash away (empty segments are filtered)', () => {
    expect(matchRoute('/runs/', definitions)).toEqual({
      pattern: '/runs',
      params: {},
    });
  });

  test('first definition wins when multiple patterns could match', () => {
    const ambiguous = [
      { pattern: '/runs/:id', kind: 'table' as const, load: definitions[2]!.load },
      { pattern: '/runs/new', kind: 'table' as const, load: definitions[1]!.load },
    ];
    expect(matchRoute('/runs/new', ambiguous)?.pattern).toBe('/runs/:id');
  });

  test('returns null for a completely unowned path', () => {
    expect(matchRoute('/not-a-route', definitions)).toBeNull();
  });

  test('every pattern in the real route table matches its own literal path', () => {
    for (const definition of routes) {
      const literalPath = definition.pattern.replace(/:[^/]+/g, 'sample-id');
      expect(matchRoute(literalPath)?.pattern).toBe(definition.pattern);
    }
  });
});

describe('router singleton', () => {
  beforeEach(() => {
    resetLocation('/');
  });

  test('navigate() updates pathname and match', () => {
    router.navigate('/runs');
    expect(router.pathname).toBe('/runs');
    expect(router.match).toEqual({ pattern: '/runs', params: {} });
  });

  test('navigate() to a dynamic route decodes params', () => {
    router.navigate('/runs/wf_123');
    expect(router.match).toEqual({ pattern: '/runs/:id', params: { id: 'wf_123' } });
  });

  test('workflow detail paths preserve dot-only identifiers without changing legacy tilde links', () => {
    for (const workflowId of ['.', '..']) {
      router.navigate(workflowDetailPath(workflowId));
      expect(router.current.params['id']).toBe(workflowId);
    }

    router.navigate('/runs/~legacy-link');
    expect(router.current.params['id']).toBe('~legacy-link');
    router.navigate(workflowDetailPath('~new-link'));
    expect(router.current.params['id']).toBe('~new-link');
  });

  test('the dot-id override applies only to the placeholder path, never to another run', () => {
    router.navigate('/runs/order-123?__weft_workflow_id=..');
    expect(router.current.params['id']).toBe('order-123');
    router.navigate('/runs/_?__weft_workflow_id=..');
    expect(router.current.params['id']).toBe('..');
  });

  test('schedule detail paths preserve dot-only identifiers, and the override applies only to the placeholder path', () => {
    for (const scheduleId of ['.', '..']) {
      router.navigate(scheduleDetailPath(scheduleId));
      expect(router.current.params['id']).toBe(scheduleId);
    }
    router.navigate('/schedules/nightly?__weft_schedule_id=..');
    expect(router.current.params['id']).toBe('nightly');
    router.navigate('/schedules/_?__weft_schedule_id=..');
    expect(router.current.params['id']).toBe('..');
    // The runs' escape means nothing on a schedule's path, and the schedules' means nothing on a run's.
    router.navigate('/schedules/_?__weft_workflow_id=..');
    expect(router.current.params['id']).toBe('_');
    router.navigate('/runs/_?__weft_schedule_id=..');
    expect(router.current.params['id']).toBe('_');
  });

  test('chat session paths carry the sessions the path cannot: new, and the dot-only identifiers', () => {
    for (const sessionId of ['new', '.', '..']) {
      router.navigate(chatSessionPath(sessionId));
      expect(router.current.route?.pattern).toBe('/chat/:sessionId');
      expect(router.current.params['sessionId']).toBe(sessionId);
    }
    // The static new-chat route is still the one `/chat/new` names.
    router.navigate('/chat/new');
    expect(router.current.route?.pattern).toBe('/chat/new');
  });

  test('chat session paths leave every other identifier as the path segment itself', () => {
    expect(chatSessionPath('abc-123')).toBe('/chat/abc-123');
    expect(chatSessionPath('a b/c')).toBe('/chat/a%20b%2Fc');
    expect(chatSessionPath('news')).toBe('/chat/news');
    expect(chatSessionPath('_')).toBe('/chat/_');
    router.navigate(chatSessionPath('_'));
    expect(router.current.params['sessionId']).toBe('_');
    router.navigate(chatSessionPath('a b/c'));
    expect(router.current.params['sessionId']).toBe('a b/c');
  });

  test('the chat override applies only to the placeholder path, and only to what the builder escapes', () => {
    router.navigate('/chat/order-123?__weft_session_id=new');
    expect(router.current.params['sessionId']).toBe('order-123');
    router.navigate('/chat/_?__weft_session_id=anything-else');
    expect(router.current.params['sessionId']).toBe('_');
    router.navigate('/chat/_?__weft_workflow_id=..');
    expect(router.current.params['sessionId']).toBe('_');
  });

  test('the sessions a placeholder path stands in for are different pages, with different keys', () => {
    router.navigate(chatSessionPath('new'));
    const first = router.viewKey;
    router.navigate(chatSessionPath('..'));

    expect(router.viewKey).not.toBe(first);
    router.navigate('/chat/plain');
    expect(router.viewKey).toBe('/chat/plain');
  });

  test('navigate() to an unowned path yields no match', () => {
    router.navigate('/does-not-exist');
    expect(router.pathname).toBe('/does-not-exist');
    expect(router.match).toBeNull();
  });

  test('navigate() with a query string updates search', () => {
    router.navigate('/runs?status=running&status=failed');
    expect(router.search.getAll('status')).toEqual(['running', 'failed']);
  });

  test('navigate() without a query string clears search', () => {
    router.navigate('/runs?status=running');
    expect(router.search.get('status')).toBe('running');

    router.navigate('/runs');
    expect(router.search.toString()).toBe('');
  });

  test('current combines route, params, and search into one snapshot', () => {
    router.navigate('/runs/wf_123?status=failed');

    const current = router.current;
    expect(current.route).toBe(routes.find((r) => r.pattern === '/runs/:id') ?? null);
    expect(current.params).toEqual({ id: 'wf_123' });
    expect(current.search.get('status')).toBe('failed');
  });

  test('current.route is null and params is empty for an unowned path', () => {
    router.navigate('/nowhere');
    expect(router.current.route).toBeNull();
    expect(router.current.params).toEqual({});
  });

  test('href() resolves a path to itself', () => {
    expect(router.href('/runs/wf_123')).toBe('/runs/wf_123');
  });

  test('back() and forward() traverse pushed history entries', () => {
    router.navigate('/runs');
    router.navigate('/schedules');

    router.back();
    expect(router.pathname).toBe('/runs');

    router.forward();
    expect(router.pathname).toBe('/schedules');
  });

  test('navigate(..., { replace: true }) does not grow the history stack', () => {
    router.navigate('/runs');
    router.navigate('/schedules', { replace: true });

    router.back();
    // The replace collapsed onto /runs's entry, so back() from
    // /schedules lands on whatever preceded /runs — the "/" baseline
    // `resetLocation` established — not on /runs itself.
    expect(router.pathname).toBe('/');
  });

  test('an external popstate (browser back/forward button) syncs pathname and search', () => {
    router.navigate('/runs');
    router.navigate('/schedules?view=list');

    window.history.back();
    expect(router.pathname).toBe('/runs');

    window.history.forward();
    expect(router.pathname).toBe('/schedules');
    expect(router.search.get('view')).toBe('list');
  });
});

describe('the key the outlet mounts a route under', () => {
  beforeEach(() => resetLocation('/'));

  test('is the pathname, so a new path is a new page', () => {
    router.navigate('/chat/new');
    expect(router.viewKey).toBe('/chat/new');

    router.navigate('/chat/session-1');
    expect(router.viewKey).toBe('/chat/session-1');
  });

  test('a navigation that keeps the page leaves the key as it was, and the address changes', () => {
    router.navigate('/chat/new');

    router.navigate('/chat/session-1', { replace: true, keep: true });

    expect(router.pathname).toBe('/chat/session-1');
    expect(router.viewKey).toBe('/chat/new');
    expect(router.current.params).toEqual({ sessionId: 'session-1' });
  });

  test('any later navigation ends the keeping', () => {
    router.navigate('/chat/new');
    router.navigate('/chat/session-1', { replace: true, keep: true });

    router.navigate('/agents');

    expect(router.viewKey).toBe('/agents');
  });

  test('going back ends the keeping too', () => {
    router.navigate('/agents');
    router.navigate('/chat/new');
    router.navigate('/chat/session-1', { replace: true, keep: true });

    router.back();
    window.dispatchEvent(new PopStateEvent('popstate'));

    expect(router.viewKey).toBe(router.pathname);
  });

  test('keeping replaces the history entry, so the length does not grow', () => {
    router.navigate('/chat/new');
    const length = window.history.length;

    router.navigate('/chat/session-1', { replace: true, keep: true });

    expect(window.history.length).toBe(length);
  });
});
