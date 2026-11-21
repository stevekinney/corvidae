/**
 * The forbidden page uses the shared empty state, with a lock icon and links to scopes and Home.
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { router } from '../lib/router.svelte.ts';
import { FORBIDDEN_COPY } from './copy/views.ts';
import ForbiddenState from './forbidden-state.svelte';

afterEach(cleanup);

/** Gives happy-dom's `about:blank` window a real origin, so `pushState` takes effect, at `path`. */
function landAt(path: string): void {
  if (!(window instanceof Window)) throw new Error('expected a happy-dom test window');
  window.happyDOM.setURL('http://localhost/');
  router.navigate(path, { replace: true });
}

describe('the forbidden page', () => {
  test('uses the shared layout and explains local access was refused', () => {
    landAt('/hooks');
    const { container, getByRole } = render(ForbiddenState, {
      props: { title: FORBIDDEN_COPY.title('Hooks') },
    });

    expect(getByRole('heading', { level: 1 }).textContent?.trim()).toBe(
      'Your sign-in can’t open Hooks',
    );
    const gate = container.querySelector('.cinder-empty-state');
    expect(gate?.getAttribute('data-cinder-kind')).toBe('disabled');
    expect(gate?.querySelector('.cinder-empty-state-icon svg.lucide-lock')).not.toBeNull();
    expect(gate?.textContent).toContain('Interborough refused access to this page.');
    expect(gate?.querySelector('code')).toBeNull();
  });

  test('offers a single way back to Home', () => {
    landAt('/hooks');
    const { container, getByRole, queryByRole } = render(ForbiddenState, {
      props: { title: FORBIDDEN_COPY.title('Hooks') },
    });

    const buttons = [...container.querySelectorAll('.cinder-empty-state-action > *')];
    expect(buttons.map((button) => button.textContent?.trim())).toEqual(['Back to Home']);
    for (const button of buttons) {
      expect(button.classList.contains('button-variant-secondary')).toBe(true);
    }
    expect(container.querySelector('.button-variant-primary')).toBeNull();
    expect(queryByRole('button', { name: /request/i })).toBeNull();
    expect(queryByRole('link', { name: /request/i })).toBeNull();
    expect(queryByRole('link', { name: 'See your scopes' })).toBeNull();
    expect(getByRole('link', { name: 'Back to Home' }).getAttribute('href')).toBe('/');
  });

  test('Back to Home opens Home in place', async () => {
    landAt('/hooks');
    const { getByRole } = render(ForbiddenState, {
      props: { title: FORBIDDEN_COPY.title('Hooks') },
    });

    await fireEvent.click(getByRole('link', { name: 'Back to Home' }));
    await waitFor(() => expect(router.pathname).toBe('/'));
  });
});
