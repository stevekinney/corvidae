/**
 * The forbidden page (design rows 12z and 13a): Cinder's access gate as a page, with the title,
 * the sentence that points at the scopes, the missing scope small and monospaced, and two
 * secondary buttons. There is no request-access button.
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
  test('is an access gate with a lock disc, the title, the sentence and the missing scope', () => {
    landAt('/hooks');
    const { container, getByRole } = render(ForbiddenState, {
      props: { title: FORBIDDEN_COPY.title('Hooks'), requirement: 'hooks:read' },
    });

    expect(getByRole('heading', { level: 1 }).textContent?.trim()).toBe(
      'Your sign-in can’t open Hooks',
    );
    const gate = container.querySelector('.cinder-access-gate');
    expect(gate?.getAttribute('data-cinder-variant')).toBe('section');
    expect(gate?.getAttribute('data-cinder-layout')).toBe('page');
    expect(gate?.querySelector('.cinder-access-gate__section-icon svg')).not.toBeNull();
    expect(gate?.textContent).toContain(
      'Settings › API reference › Your scopes shows what it can do.',
    );
    expect(gate?.querySelector('code')?.textContent).toBe('requires hooks:read');
  });

  test('never says Bureau in the scope it names', () => {
    landAt('/goals');
    const { container } = render(ForbiddenState, {
      props: { title: FORBIDDEN_COPY.title('Goals'), requirement: 'bureau.goals:read' },
    });

    expect(container.querySelector('code')?.textContent).toBe('requires goals:read');
  });

  test('names no scope when none is known, instead of guessing one', () => {
    landAt('/hooks');
    const { container } = render(ForbiddenState, {
      props: { title: 'Your sign-in can’t open Home' },
    });

    expect(container.querySelector('code')).toBeNull();
  });

  test('has two secondary buttons, See your scopes and Back to Home, and no request-access button', () => {
    landAt('/hooks');
    const { container, getByRole, queryByRole } = render(ForbiddenState, {
      props: { title: FORBIDDEN_COPY.title('Hooks'), requirement: 'hooks:read' },
    });

    const buttons = [...container.querySelectorAll('.cinder-access-gate__actions > *')];
    expect(buttons.map((button) => button.textContent?.trim())).toEqual([
      'See your scopes',
      'Back to Home',
    ]);
    for (const button of buttons) {
      expect(button.getAttribute('data-cinder-variant')).toBe('secondary');
    }
    expect(container.querySelector('[data-cinder-variant="primary"]')).toBeNull();
    expect(queryByRole('button', { name: /request/i })).toBeNull();
    expect(queryByRole('link', { name: /request/i })).toBeNull();
    expect(getByRole('link', { name: 'See your scopes' }).getAttribute('href')).toBe(
      '/settings/api-reference?group=scopes',
    );
  });

  test('See your scopes and Back to Home open their pages in place', async () => {
    landAt('/hooks');
    const { getByRole } = render(ForbiddenState, {
      props: { title: FORBIDDEN_COPY.title('Hooks') },
    });

    await fireEvent.click(getByRole('link', { name: 'See your scopes' }));
    await waitFor(() => expect(router.pathname).toBe('/settings/api-reference'));

    await fireEvent.click(getByRole('link', { name: 'Back to Home' }));
    await waitFor(() => expect(router.pathname).toBe('/'));
  });
});
