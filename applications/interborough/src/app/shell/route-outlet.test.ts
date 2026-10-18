/**
 * The route outlet mounts the matched route inside its view's frame, and says so when no route
 * owns the path.
 */
import { HttpClient } from '@lostgradient/weft';
import { render } from '@testing-library/svelte';
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';

import { installFetchImplementation } from '../../lib/live-source/fetch.test-support.ts';
import { router } from '../../lib/router.svelte.ts';
import { AUTHORIZATION_SCOPES } from '../../lib/scopes.svelte.ts';
import { ROUTE_LOAD_FAILURE_COPY, VIEW_COPY } from '../copy.ts';
import { routes } from '../routes.ts';
import Harness from './route-outlet.test-harness.svelte';

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

function mount() {
  return render(Harness, {
    props: {
      client: new HttpClient({ baseUrl: 'http://localhost/api' }),
      scopes: AUTHORIZATION_SCOPES,
    },
  });
}

describe('the route outlet', () => {
  test('renders a placeholder view in its frame, empty once the Bureau answers', async () => {
    restore = installFetchImplementation(async () => Response.json({ status: 'ok' }));
    landAt('/chat/session-1');
    const { container, findByRole } = mount();
    expect(
      await findByRole('heading', { level: 1, name: VIEW_COPY.chat.empty?.title ?? '' }),
    ).not.toBeNull();
    const frame = container.querySelector('.weft-view');
    expect(frame?.getAttribute('data-view')).toBe('chat');
    expect(frame?.getAttribute('data-state')).toBe('empty');
  });

  test('says when no route owns the path', async () => {
    restore = installFetchImplementation(async () => Response.json({}));
    landAt('/nowhere');
    const { findByText, container } = mount();
    expect(await findByText('Page not found')).not.toBeNull();
    expect(container.querySelector('.weft-view')).toBeNull();
  });

  test('is the page’s one main landmark, whatever the route renders', async () => {
    restore = installFetchImplementation(async () => Response.json({ status: 'ok' }));
    landAt('/chat');
    const { findByRole, getAllByRole, container } = mount();
    await findByRole('heading', { level: 1, name: VIEW_COPY.chat.empty?.title ?? '' });
    expect(getAllByRole('main')).toHaveLength(1);
    expect(container.querySelector('main.weft-shell-outlet')).not.toBeNull();
  });

  test('says so when a route’s code cannot be loaded, and drops the page it came from', async () => {
    restore = installFetchImplementation(async () => Response.json({ status: 'ok' }));
    landAt('/chat');
    const { findByRole, container } = mount();
    await findByRole('heading', { level: 1, name: VIEW_COPY.chat.empty?.title ?? '' });

    const agents = routes.find((route) => route.pattern === '/agents');
    if (agents === undefined) throw new Error('Expected an /agents route.');
    const load = spyOn(agents, 'load').mockRejectedValue(new Error('Failed to fetch chunk'));
    try {
      router.navigate('/agents');
      expect(
        await findByRole('heading', { level: 1, name: ROUTE_LOAD_FAILURE_COPY.title }),
      ).not.toBeNull();
      expect(container.querySelector('[data-state="error"]')).not.toBeNull();
      // Chat's frame is not left on screen under the agents address.
      expect(container.querySelector('[data-view="chat"]')).toBeNull();
      const reload = spyOn(window.location, 'reload').mockImplementation(() => {});
      try {
        const button = await findByRole('button', { name: ROUTE_LOAD_FAILURE_COPY.action });
        button.click();
        expect(reload).toHaveBeenCalledTimes(1);
      } finally {
        reload.mockRestore();
      }
    } finally {
      load.mockRestore();
    }
  });
});
