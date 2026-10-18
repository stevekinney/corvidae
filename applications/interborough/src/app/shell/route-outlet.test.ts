/**
 * The route outlet mounts the matched route inside its view's frame, and says so when no route
 * owns the path.
 */
import { HttpClient } from '@lostgradient/weft';
import { render } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { installFetchImplementation } from '../../lib/live-source/fetch.test-support.ts';
import { router } from '../../lib/router.svelte.ts';
import { AUTHORIZATION_SCOPES } from '../../lib/scopes.svelte.ts';
import { VIEW_COPY } from '../copy.ts';
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
});
