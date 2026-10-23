/**
 * The sidebar: two groups, Work and Engine, built from Cinder's `SideNavigationGroup`, with
 * Chat as the home screen and the badge counts the engine reports.
 */
import { HttpClient } from '@lostgradient/weft';
import { fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { toolApprovalFixture } from '../../lib/bureau-fixtures.test-support.ts';
import { installFetchImplementation } from '../../lib/live-source/fetch.test-support.ts';
import type { LiveSourceStatus } from '../../lib/live-source/index.ts';
import { router } from '../../lib/router.svelte.ts';
import { AUTHORIZATION_SCOPES, type AuthorizationScope } from '../../lib/scopes.svelte.ts';
import Harness from './sidebar.test-harness.svelte';

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});

/** Gives happy-dom's `about:blank` window a real origin, so `pushState` takes effect, at `path`. */
function landAt(path: string): void {
  if (!(window instanceof Window)) throw new Error('expected a happy-dom test window');
  window.happyDOM.setURL('http://localhost/');
  router.navigate(path, { replace: true });
}

function stubEngine(
  options: { pendingReviews?: number; bureauReviews?: number; unhealthyWorkers?: number } = {},
): void {
  restore = installFetchImplementation(async (input, init) => {
    const text = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(text, 'http://localhost');
    if (url.pathname.endsWith('/reviews')) {
      const items = Array.from({ length: options.pendingReviews ?? 0 }, (_, index) => ({
        status: 'pending',
        reviewId: `review-${index}`,
        workflowId: `wf-${index}`,
        artifact: {},
        reviewType: 'content',
        reviewers: [],
        allowPartial: false,
        createdAt: Date.now(),
      }));
      return Response.json({ items });
    }
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as { id?: unknown }) : {};
    if (url.pathname === '/bureau/jsonrpc') {
      // The Bureau's own pending reviews, which the count adds to the engine's.
      const reviews = Array.from({ length: options.bureauReviews ?? 0 }, (_, index) => ({
        ...toolApprovalFixture({ id: `bureau-review-${index}`, runId: `run-${index}` }),
      }));
      return Response.json({ jsonrpc: '2.0', id: body.id, result: { reviews } });
    }
    const items = Array.from({ length: options.unhealthyWorkers ?? 0 }, (_, index) => ({
      id: `worker-${index}`,
      health: 'drained',
      heartbeatAgeMs: 0,
    }));
    return Response.json({ jsonrpc: '2.0', id: body.id, result: { items } });
  });
}

function mount(scopes?: readonly AuthorizationScope[], engineStatus?: LiveSourceStatus) {
  return render(Harness, {
    props: {
      client: new HttpClient({ baseUrl: 'http://localhost/api' }),
      ...(scopes === undefined ? {} : { scopes }),
      ...(engineStatus === undefined ? {} : { engineStatus }),
    },
  });
}

const PRIMARY = ['Chat', 'Agents', 'Workflows', 'Runs', 'Schedules', 'Reviews'];
const ENGINE = ['Workers', 'Storage', 'System', 'Audit'];

describe('the sidebar', () => {
  test('holds a Work group and an Engine group, in order', () => {
    stubEngine();
    landAt('/chat');
    const { getByRole } = mount();

    const navigation = getByRole('navigation', { name: 'Views' });
    const groups = Array.from(navigation.querySelectorAll('.cinder-side-navigation-group'));
    expect(groups.length).toBe(2);
    const labelsOf = (group: Element) =>
      Array.from(group.querySelectorAll('a')).map(
        (link) => link.textContent?.trim().split(/\s+/)[0],
      );
    expect(groups[0]?.querySelector('button')?.textContent?.trim()).toBe('Work');
    expect(labelsOf(groups[0] as Element)).toEqual(PRIMARY);
    expect(groups[1]?.querySelector('button')?.textContent?.trim()).toBe('Engine');
    expect(labelsOf(groups[1] as Element)).toEqual(ENGINE);
  });

  test('links each entry to its route', () => {
    stubEngine();
    landAt('/chat');
    const { getByRole } = mount();
    const paths = Object.fromEntries(
      [...PRIMARY, ...ENGINE].map((label) => [
        label,
        getByRole('link', { name: new RegExp(`^${label}`) }).getAttribute('href'),
      ]),
    );
    expect(paths).toEqual({
      Chat: '/chat',
      Agents: '/agents',
      Workflows: '/workflows',
      Runs: '/runs',
      Schedules: '/schedules',
      Reviews: '/reviews',
      Workers: '/workers',
      Storage: '/storage',
      System: '/system',
      Audit: '/audit',
    });
  });

  test('marks Chat current on the home screen and on a session', () => {
    stubEngine();
    for (const path of ['/', '/chat', '/chat/session-1']) {
      landAt(path);
      const { getByRole, unmount } = mount();
      expect(getByRole('link', { name: /^Chat/ }).getAttribute('aria-current'), path).toBe('page');
      expect(getByRole('link', { name: /^Runs/ }).getAttribute('aria-current'), path).toBeNull();
      unmount();
    }
  });

  test('marks Runs current on a run, and not Workflows', () => {
    stubEngine();
    landAt('/runs/run-1');
    const { getByRole } = mount();
    expect(getByRole('link', { name: /^Runs/ }).getAttribute('aria-current')).toBe('page');
    expect(getByRole('link', { name: /^Workflows/ }).getAttribute('aria-current')).toBeNull();
  });

  test('navigates without leaving the page', async () => {
    stubEngine();
    landAt('/chat');
    const { getByRole } = mount();
    await fireEvent.click(getByRole('link', { name: /^Runs/ }));
    expect(router.pathname).toBe('/runs');
  });

  test('shows the pending reviews on Reviews and the unhealthy workers on Workers', async () => {
    stubEngine({ pendingReviews: 3, unhealthyWorkers: 2 });
    landAt('/chat');
    const { getByRole } = mount();
    await waitFor(() => expect(getByRole('link', { name: /^Reviews\s*3$/ })).not.toBeNull());
    await waitFor(() => expect(getByRole('link', { name: /^Workers\s*2$/ })).not.toBeNull());
  });

  test('counts the Bureau’s pending reviews and the engine’s as one number', async () => {
    stubEngine({ bureauReviews: 2, pendingReviews: 3 });
    landAt('/chat');
    const { getByRole } = mount();
    await waitFor(() => expect(getByRole('link', { name: /^Reviews\s*5$/ })).not.toBeNull());
  });

  test('counts the Bureau’s alone when the principal does not hold reviews:read', async () => {
    stubEngine({ bureauReviews: 2, pendingReviews: 3 });
    landAt('/chat');
    const { getByRole } = mount(AUTHORIZATION_SCOPES.filter((scope) => scope !== 'reviews:read'));
    await waitFor(() => expect(getByRole('link', { name: /^Reviews\s*2$/ })).not.toBeNull());
  });

  test('points the engine status at the engine overview, and says the status in words', () => {
    stubEngine();
    landAt('/chat');
    const { getByRole } = mount();
    const link = getByRole('link', { name: 'Engine healthy' });
    expect(link.getAttribute('href')).toBe('/engine');
    expect(link.querySelector('.cinder-status-dot')?.getAttribute('data-cinder-status')).toBe(
      'online',
    );
  });

  test('turns the engine status red, and names the problem, when the engine is unreachable', () => {
    stubEngine();
    landAt('/chat');
    const { getByRole } = mount(undefined, 'closed');
    const link = getByRole('link', { name: 'Engine unreachable' });
    expect(link.querySelector('.cinder-status-dot')?.getAttribute('data-cinder-status')).toBe(
      'danger',
    );
  });

  test('names the keys that open a view in its title', () => {
    stubEngine();
    landAt('/chat');
    const { getByRole } = mount();
    const titles = Object.fromEntries(
      ['Chat', 'Agents', 'Reviews', 'Audit'].map((label) => [
        label,
        getByRole('link', { name: new RegExp(`^${label}`) }).getAttribute('title'),
      ]),
    );
    expect(titles).toEqual({
      Chat: 'Chat (g c)',
      Agents: 'Agents (g a)',
      Reviews: 'Reviews (g v)',
      Audit: 'Audit (g u)',
    });
  });
});

describe('the sidebar on a narrow viewport', () => {
  test('closes its drawer, and records that it is collapsed, when the drawer is dismissed', async () => {
    stubEngine();
    landAt('/chat');
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query.includes('max-width'),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
    })) as unknown as typeof window.matchMedia;
    try {
      const { findByRole } = mount();
      const dialog = await findByRole('dialog');
      expect(document.querySelector('.weft-shell-sidebar--mobile')).not.toBeNull();
      // A click on the dialog itself is a click on its backdrop, which dismisses the drawer.
      await fireEvent.click(dialog);
      await waitFor(() => expect(document.querySelector('.weft-shell-sidebar--mobile')).toBeNull());
    } finally {
      window.matchMedia = original;
    }
  });
});

